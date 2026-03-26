import {
  RentalStatus,
  BoardStatus,
  PaymentProofKind,
  PaymentProofStatus,
} from "@prisma/client";
import { prisma } from "../db/prisma";
import * as audit from "./audit";

export async function createRental(params: {
  userId: number;
  spotId: number;
  boardId: number;
  tariffId: number;
  sellerUserId?: number;
  clientName?: string;
}) {
  const tariff = await prisma.tariff.findUniqueOrThrow({
    where: { id: params.tariffId },
  });

  const rental = await prisma.$transaction(async (tx) => {
    const board = await tx.board.findUniqueOrThrow({
      where: { id: params.boardId },
    });

    if (board.status !== BoardStatus.AVAILABLE) {
      throw new Error("Доска недоступна для аренды");
    }

    const r = await tx.rental.create({
      data: {
        userId: params.userId,
        spotId: params.spotId,
        boardId: params.boardId,
        tariffId: params.tariffId,
        sellerUserId: params.sellerUserId,
        clientName: params.clientName,
        status: RentalStatus.CREATED,
      },
    });

    // Mark board as rented immediately
    await tx.board.update({
      where: { id: params.boardId },
      data: { status: BoardStatus.RENTED },
    });

    return r;
  });

  await audit.log(params.userId, "Rental", rental.id, "CREATED", {
    tariffId: tariff.id,
    price: tariff.price,
    sellerUserId: params.sellerUserId,
    clientName: params.clientName,
  });

  return { rental, tariff };
}

/** Seller creates walk-in rental: board picked → tariff picked → client name → immediately RENTED */
export async function createWalkinRental(params: {
  sellerUserId: number;
  spotId: number;
  boardId: number;
  tariffId: number;
  clientName: string;
}) {
  const tariff = await prisma.tariff.findUniqueOrThrow({
    where: { id: params.tariffId },
  });

  const board = await prisma.board.findUniqueOrThrow({
    where: { id: params.boardId },
  });

  if (board.status !== BoardStatus.AVAILABLE) {
    throw new Error("Доска недоступна для аренды");
  }

  const now = new Date();
  const rental = await prisma.$transaction(async (tx) => {
    const board = await tx.board.findUniqueOrThrow({
      where: { id: params.boardId },
    });

    if (board.status !== BoardStatus.AVAILABLE) {
      throw new Error("Доска недоступна для аренды");
    }

    const r = await tx.rental.create({
      data: {
        userId: params.sellerUserId,
        spotId: params.spotId,
        boardId: params.boardId,
        tariffId: params.tariffId,
        sellerUserId: params.sellerUserId,
        clientName: params.clientName,
        status: RentalStatus.RENTED,
        startAt: now,
      },
    });

    await tx.board.update({
      where: { id: params.boardId },
      data: { status: BoardStatus.RENTED },
    });

    return r;
  });

  await audit.log(params.sellerUserId, "Rental", rental.id, "WALKIN_CREATED", {
    tariffId: tariff.id,
    price: tariff.price,
    clientName: params.clientName,
  });

  return { rental, tariff };
}

export async function moveToWaitPayment(rentalId: number, userId: number) {
  const rental = await prisma.rental.update({
    where: { id: rentalId },
    data: { status: RentalStatus.WAIT_PAYMENT },
  });
  await audit.log(userId, "Rental", rentalId, "WAIT_PAYMENT");
  return rental;
}

export async function submitPayment(params: {
  rentalId: number;
  userId: number;
  amount: number;
  fileId?: string;
  text?: string;
}) {
  // Idempotency: don't create duplicate SUBMITTED proofs
  const existing = await prisma.paymentProof.findFirst({
    where: {
      kind: PaymentProofKind.RENTAL,
      refId: params.rentalId,
      status: { in: [PaymentProofStatus.SUBMITTED, PaymentProofStatus.APPROVED] },
    },
  });
  if (existing) {
    return { proof: existing, duplicate: true };
  }

  const proof = await prisma.paymentProof.create({
    data: {
      kind: PaymentProofKind.RENTAL,
      refId: params.rentalId,
      amount: params.amount,
      fileId: params.fileId,
      text: params.text,
      userId: params.userId,
    },
  });

  await prisma.rental.update({
    where: { id: params.rentalId },
    data: { status: RentalStatus.WAIT_ADMIN },
  });

  await audit.log(params.userId, "PaymentProof", proof.id, "SUBMITTED", {
    rentalId: params.rentalId,
    amount: params.amount,
  });

  return { proof, duplicate: false };
}

export async function approveRental(rentalId: number, adminUserId: number) {
  const rental = await prisma.rental.update({
    where: { id: rentalId },
    data: { status: RentalStatus.RENTED, startAt: new Date() },
  });
  await prisma.board.update({
    where: { id: rental.boardId },
    data: { status: BoardStatus.RENTED },
  });
  await audit.log(adminUserId, "Rental", rentalId, "APPROVED_AND_RENTED");
  return rental;
}

export async function acceptReturn(rentalId: number, sellerUserId: number) {
  const rental = await prisma.$transaction(async (tx) => {
    const r = await tx.rental.update({
      where: { id: rentalId },
      data: { status: RentalStatus.RETURNED, endAt: new Date() },
    });
    await tx.board.update({
      where: { id: r.boardId },
      data: { status: BoardStatus.AVAILABLE },
    });
    return r;
  });
  await audit.log(sellerUserId, "Rental", rentalId, "RETURNED");
  return rental;
}

/**
 * Complete return flow: calculate overdue, accept return, create overdue proof if needed.
 * Returns all data needed by the caller (receipt, overdueCost, client info).
 */
export async function completeReturn(rentalId: number, actorUserId: number) {
  // Calculate overdue BEFORE completing return
  const rentalBefore = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, tariff: true, user: true },
  });
  const { overdueCost } = calculateOverdueCost(rentalBefore);

  await acceptReturn(rentalId, actorUserId);
  const receipt = await getRentalReceipt(rentalId);

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, user: true },
  });

  // If overdue, create payment proof for the overdue amount
  if (overdueCost > 0) {
    await prisma.paymentProof.create({
      data: {
        kind: PaymentProofKind.OVERDUE,
        refId: rentalId,
        amount: overdueCost,
        userId: rentalBefore.userId,
        text: `Просрочка по аренде #${rentalId}`,
      },
    });
  }

  // Build client message
  let clientMsg = `✅ <b>Аренда завершена!</b>\n\n` + receipt;
  if (overdueCost > 0) {
    clientMsg += `\n⚠️ У вас задолженность за просрочку: <b>${overdueCost}</b>.\nОжидайте подтверждения оплаты.`;
  } else {
    clientMsg += `\nСпасибо за аренду! 🌊`;
  }

  return { rental, receipt, overdueCost, clientMsg, clientTgId: rental.user.tgId };
}

export async function extendRental(rentalId: number, minutes: number, userId: number, extensionCost?: number) {
  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { tariff: true, board: true },
  });

  if (!['RENTED', 'WAIT_RETURN'].includes(rental.status)) {
    throw new Error('Продлить можно только активную аренду');
  }

  // Calculate overdue — if overdue, extension covers it first
  let overdueMinutes = 0;
  if (rental.startAt && rental.tariff) {
    const totalMin = rental.tariff.durationMinutes + (rental.extraMinutes ?? 0);
    const endAt = new Date(rental.startAt.getTime() + totalMin * 60_000);
    const now = new Date();
    if (now > endAt) {
      overdueMinutes = Math.ceil((now.getTime() - endAt.getTime()) / 60_000);
    }
  }

  // Calculate cost: use provided cost or fall back to per-minute rate
  const perMinuteRate = rental.tariff ? rental.tariff.price / rental.tariff.durationMinutes : 0;
  const cost = extensionCost ?? Math.ceil(minutes * perMinuteRate);

  const newExtra = (rental.extraMinutes ?? 0) + minutes;

  const updated = await prisma.rental.update({
    where: { id: rentalId },
    data: {
      extraMinutes: newExtra,
      extraCost: { increment: cost },
      pendingExtraMinutes: null,
      status: RentalStatus.RENTED,
    },
  });

  await prisma.board.update({
    where: { id: rental.boardId },
    data: { status: BoardStatus.RENTED },
  });

  const netMinutes = Math.max(0, minutes - overdueMinutes);
  await audit.log(userId, 'Rental', rentalId, 'EXTENDED', {
    addedMinutes: minutes,
    extensionCost: cost,
    overdueMinutes,
    netMinutes,
    totalExtra: newExtra,
  });

  return { ...updated, overdueMinutes, netMinutes, extensionCost: cost };
}

/** Get current overdue minutes for a rental */
export function getOverdueMinutes(rental: {
  startAt: Date | null;
  tariff: { durationMinutes: number } | null;
  extraMinutes: number;
  status: string;
}): number {
  if (!rental.startAt || !rental.tariff) return 0;
  if (!['RENTED', 'WAIT_RETURN'].includes(rental.status)) return 0;
  const totalMin = rental.tariff.durationMinutes + (rental.extraMinutes ?? 0);
  const endAt = new Date(rental.startAt.getTime() + totalMin * 60_000);
  const now = new Date();
  if (now > endAt) {
    return Math.ceil((now.getTime() - endAt.getTime()) / 60_000);
  }
  return 0;
}

/** Close overdue by adding exact overdue minutes as extension (no net gain) */
export async function closeOverdue(rentalId: number, userId: number) {
  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { tariff: true, board: true },
  });

  if (rental.status !== 'WAIT_RETURN') {
    throw new Error('Нет просрочки для закрытия');
  }

  const overdue = getOverdueMinutes(rental);
  if (overdue <= 0) {
    throw new Error('Нет просрочки для закрытия');
  }

  // Calculate overdue cost
  const perMinuteRate = rental.tariff ? rental.tariff.price / rental.tariff.durationMinutes : 0;
  const overdueCost = Math.ceil(overdue * perMinuteRate);

  const newExtra = (rental.extraMinutes ?? 0) + overdue;

  const updated = await prisma.rental.update({
    where: { id: rentalId },
    data: {
      extraMinutes: newExtra,
      extraCost: { increment: overdueCost },
      status: RentalStatus.RENTED,
    },
  });

  await prisma.board.update({
    where: { id: rental.boardId },
    data: { status: BoardStatus.RENTED },
  });

  await audit.log(userId, 'Rental', rentalId, 'CLOSE_OVERDUE', {
    overdueMinutes: overdue,
    overdueCost,
    totalExtra: newExtra,
  });

  return { ...updated, closedMinutes: overdue, overdueCost };
}

/** Client requests extension — needs admin approval */
export async function requestExtend(rentalId: number, minutes: number, userId: number) {
  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
  });

  if (!['RENTED', 'WAIT_RETURN'].includes(rental.status)) {
    throw new Error('Продлить можно только активную аренду');
  }

  if (rental.pendingExtraMinutes) {
    throw new Error('Запрос на продление уже отправлен. Дождитесь ответа администратора.');
  }

  const updated = await prisma.rental.update({
    where: { id: rentalId },
    data: { pendingExtraMinutes: minutes },
  });

  await audit.log(userId, 'Rental', rentalId, 'EXTEND_REQUESTED', {
    requestedMinutes: minutes,
  });

  return updated;
}

/** Admin rejects extension request */
export async function rejectExtend(rentalId: number, adminUserId: number) {
  const updated = await prisma.rental.update({
    where: { id: rentalId },
    data: { pendingExtraMinutes: null },
  });

  await audit.log(adminUserId, 'Rental', rentalId, 'EXTEND_REJECTED');
  return updated;
}

/** Calculate overdue cost for an active rental (before return) */
export function calculateOverdueCost(rental: {
  startAt: Date | null;
  tariff: { durationMinutes: number; price: number } | null;
  extraMinutes: number;
  status: string;
}): { overdueMinutes: number; overdueCost: number } {
  const overdueMinutes = getOverdueMinutes(rental);
  const perMinuteRate = rental.tariff ? rental.tariff.price / rental.tariff.durationMinutes : 0;
  const overdueCost = Math.ceil(overdueMinutes * perMinuteRate);
  return { overdueMinutes, overdueCost };
}

const CANCELLABLE_STATUSES: RentalStatus[] = [
  RentalStatus.CREATED,
  RentalStatus.WAIT_PAYMENT,
  RentalStatus.WAIT_ADMIN,
  RentalStatus.RENTED,
  RentalStatus.WAIT_RETURN,
];

export async function cancelRental(rentalId: number, userId: number) {
  const updated = await prisma.$transaction(async (tx) => {
    const rental = await tx.rental.findUniqueOrThrow({
      where: { id: rentalId },
    });

    if (!CANCELLABLE_STATUSES.includes(rental.status)) {
      throw new Error("Нельзя отменить завершённую или уже отменённую аренду");
    }

    const r = await tx.rental.update({
      where: { id: rentalId },
      data: { status: RentalStatus.CANCELLED, endAt: new Date() },
    });

    // Release board back to available
    await tx.board.update({
      where: { id: r.boardId },
      data: { status: BoardStatus.AVAILABLE },
    });

    return r;
  });

  await audit.log(userId, "Rental", rentalId, "CANCELLED");
  return updated;
}

/** Generate a full rental receipt/summary */
export async function getRentalReceipt(rentalId: number): Promise<string> {
  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, tariff: true, user: true, seller: true },
  });

  const { fmtPrice, fmtDuration, fmtDate } = await import("../ui/helpers");
  const client = rental.clientName ?? rental.user.name;
  const source = rental.sellerUserId ? "👤 админ" : "📱 клиент";

  let text = `📋 <b>Итог аренды #${rental.id}</b>\n\n`;
  text += `🏄 Доска: <b>${rental.board.code}</b>\n`;
  text += `👤 Клиент: <b>${client}</b>\n`;
  text += `🔖 Оформление: ${source}\n`;

  if (rental.startAt) text += `📅 Начало: ${fmtDate(rental.startAt)}\n`;
  if (rental.endAt) text += `🏁 Конец: ${fmtDate(rental.endAt)}\n`;

  // Time breakdown
  const baseDuration = rental.tariff?.durationMinutes ?? 0;
  const basePrice = rental.tariff?.price ?? 0;
  const extra = rental.extraMinutes ?? 0;
  const extraCost = rental.extraCost ?? 0;
  const totalPaidMinutes = baseDuration + extra;
  const perMinuteRate = baseDuration > 0 ? basePrice / baseDuration : 0;

  text += `\n<b>⏱ Время:</b>\n`;
  if (rental.tariff) {
    text += `   Тариф: ${rental.tariff.name} — ${fmtDuration(baseDuration)}\n`;
  }
  if (extra > 0) {
    text += `   Продления: +${fmtDuration(extra)}\n`;
  }
  text += `   Оплаченное время: <b>${fmtDuration(totalPaidMinutes)}</b>\n`;

  // Actual usage & overdue
  let overdueAtReturn = 0;
  if (rental.startAt && rental.endAt) {
    const actualMin = Math.ceil((rental.endAt.getTime() - rental.startAt.getTime()) / 60_000);
    text += `   Фактическое время: <b>${fmtDuration(actualMin)}</b>\n`;
    overdueAtReturn = Math.max(0, actualMin - totalPaidMinutes);
    if (overdueAtReturn > 0) {
      text += `   ⚠️ Просрочка: <b>${fmtDuration(overdueAtReturn)}</b>\n`;
    }
  } else if (rental.startAt) {
    // Rental still active — show current overdue
    const now = new Date();
    const actualMin = Math.ceil((now.getTime() - rental.startAt.getTime()) / 60_000);
    text += `   Текущее время: <b>${fmtDuration(actualMin)}</b>\n`;
    const currentOverdue = Math.max(0, actualMin - totalPaidMinutes);
    if (currentOverdue > 0) {
      overdueAtReturn = currentOverdue;
      text += `   ⚠️ Просрочка: <b>${fmtDuration(currentOverdue)}</b>\n`;
    }
  }

  // Cost breakdown
  const overdueCost = Math.ceil(overdueAtReturn * perMinuteRate);
  const totalCost = basePrice + extraCost + overdueCost;
  const paidAmount = basePrice + extraCost;

  text += `\n<b>💰 Стоимость:</b>\n`;
  text += `   Тариф: ${fmtPrice(basePrice)}\n`;
  if (extraCost > 0) {
    text += `   Доплаты (продления): +${fmtPrice(extraCost)}\n`;
  }
  if (overdueCost > 0) {
    text += `   ⚠️ Просрочка: +${fmtPrice(overdueCost)}\n`;
  }
  text += `   ─────────────\n`;
  text += `   <b>Итого: ${fmtPrice(totalCost)}</b>\n`;

  if (overdueCost > 0) {
    text += `\n   ✅ Оплачено: ${fmtPrice(paidAmount)}\n`;
    text += `   💳 <b>К оплате: ${fmtPrice(overdueCost)}</b>\n`;
  }

  return text;
}
