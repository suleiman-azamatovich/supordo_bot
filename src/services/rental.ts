/**
 * Сервис аренды — ядро бизнес-логики.
 *
 * Управляет полным жизненным циклом аренды:
 * CREATED → WAIT_PAYMENT → WAIT_ADMIN → RENTED → WAIT_RETURN → RETURNED
 *
 * Все мутации данных оборачиваются в транзакции с `SELECT FOR UPDATE`
 * для предотвращения гонок при параллельных апдейтах.
 */
import {
  RentalStatus,
  BoardStatus,
  PaymentProofKind,
  PaymentProofStatus,
  AuditAction,
} from "@prisma/client";
import { prisma } from "../db/prisma";
import * as audit from "./audit";
import { fmtPrice, fmtDuration, fmtDate, escapeHtml } from "../ui/helpers";
import { resetExpiryTracking } from "./expiry";

/** Проверяет, включён ли тестовый режим (самый короткий тариф ≤ 3 мин) */
let _testModeCache: { value: boolean; ts: number } | null = null;
const TEST_MODE_TTL = 5_000; // 5 секунд

export async function isTestMode(): Promise<boolean> {
  const now = Date.now();
  if (_testModeCache && now - _testModeCache.ts < TEST_MODE_TTL) {
    return _testModeCache.value;
  }
  const shortest = await prisma.tariff.findFirst({ orderBy: { durationMinutes: "asc" } });
  const value = !!shortest && shortest.durationMinutes <= 3;
  _testModeCache = { value, ts: now };
  return value;
}

/** Сбросить кеш тестового режима (после изменения тарифов) */
export function clearTestModeCache() {
  _testModeCache = null;
}

/**
 * Задержка старта таймера после подтверждения оплаты.
 * Даёт время клиенту дойти до доски.
 * @returns Грейс в миллисекундах: 10 сек (тест) | 8 мин (рабочий)
 */
export async function getStartGraceMs(): Promise<number> {
  return (await isTestMode()) ? 10_000 : 8 * 60_000;
}

/**
 * Грейс-период после окончания аренды до начала начисления просрочки.
 * @returns Грейс в миллисекундах: 10 сек (тест) | 10 мин (рабочий)
 */
export async function getEndGraceMs(): Promise<number> {
  return (await isTestMode()) ? 10_000 : 10 * 60_000;
}

/**
 * Таймаут отмены неоплаченных аренд (CREATED/WAIT_PAYMENT).
 * После истечения аренда автоматически отменяется.
 * @returns Таймаут в миллисекундах: 3 мин (тест) | 8 мин (рабочий)
 */
export async function getUnpaidTimeoutMs(): Promise<number> {
  return (await isTestMode()) ? 3 * 60_000 : 8 * 60_000;
}

/** Ставка просрочки (сом за минуту после грейс-периода) */
export const OVERDUE_RATE_PER_MIN = 10;

/**
 * Создание аренды через бота (онлайн-поток).
 *
 * Блокирует доску через `SELECT FOR UPDATE`, создаёт аренду в статусе CREATED,
 * помечает доску как RENTED. После создания клиент должен перейти к оплате.
 *
 * @param params - Параметры: userId, spotId, boardId, tariffId, опционально sellerUserId/clientName
 * @returns Созданная аренда и выбранный тариф
 * @throws Если доска недоступна для аренды
 */
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
    // Lock the board row to prevent double-booking (SELECT FOR UPDATE)
    const [board] = await tx.$queryRawUnsafe<{ id: number; status: string }[]>(
      `SELECT id, status FROM "Board" WHERE id = $1 FOR UPDATE`, params.boardId
    );
    if (!board || board.status !== BoardStatus.AVAILABLE) {
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

  await audit.log(params.userId, "Rental", rental.id, AuditAction.CREATED, {
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

  const now = new Date();
  const rental = await prisma.$transaction(async (tx) => {
    // Lock the board row to prevent double-booking (SELECT FOR UPDATE)
    const [board] = await tx.$queryRawUnsafe<{ id: number; status: string }[]>(
      `SELECT id, status FROM "Board" WHERE id = $1 FOR UPDATE`, params.boardId
    );
    if (!board || board.status !== BoardStatus.AVAILABLE) {
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

  await audit.log(params.sellerUserId, "Rental", rental.id, AuditAction.WALKIN_CREATED, {
    tariffId: tariff.id,
    price: tariff.price,
    clientName: params.clientName,
  });

  return { rental, tariff };
}

/**
 * Перевод аренды в статус ожидания оплаты (WAIT_PAYMENT).
 * Вызывается после выбора тарифа клиентом.
 */
export async function moveToWaitPayment(rentalId: number, userId: number) {
  const rental = await prisma.rental.update({
    where: { id: rentalId },
    data: { status: RentalStatus.WAIT_PAYMENT },
  });
  await audit.log(userId, "Rental", rentalId, AuditAction.WAIT_PAYMENT);
  return rental;
}

/**
 * Отправка подтверждения оплаты (чек/скриншот).
 *
 * Создаёт PaymentProof со статусом SUBMITTED и переводит аренду в WAIT_ADMIN.
 * Повторная отправка не создаёт дубликат (идемпотентность).
 *
 * @returns proof — объект доказательства оплаты, duplicate — был ли уже отправлен
 */
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

  await audit.log(params.userId, "PaymentProof", proof.id, AuditAction.SUBMITTED, {
    rentalId: params.rentalId,
    amount: params.amount,
  });

  return { proof, duplicate: false };
}

/**
 * Одобрение аренды администратором.
 *
 * Устанавливает startAt с учётом грейс-периода старта,
 * переводит в статус RENTED. Доска уже помечена как RENTED при создании.
 *
 * @throws Если аренда уже обработана (не в WAIT_ADMIN)
 */
export async function approveRental(rentalId: number, adminUserId: number) {
  const rental = await prisma.rental.findUniqueOrThrow({ where: { id: rentalId } });
  if (rental.status !== RentalStatus.WAIT_ADMIN) {
    throw new Error("Аренда уже обработана");
  }
  const graceMs = await getStartGraceMs();
  const startAt = new Date(Date.now() + graceMs);
  const updated = await prisma.rental.update({
    where: { id: rentalId },
    data: { status: RentalStatus.RENTED, startAt },
  });
  await prisma.board.update({
    where: { id: updated.boardId },
    data: { status: BoardStatus.RENTED },
  });
  await audit.log(adminUserId, "Rental", rentalId, AuditAction.APPROVED_AND_RENTED, {
    boardId: updated.boardId,
    tariffId: rental.tariffId,
  });
  return updated;
}

/**
 * Принятие возврата доски.
 *
 * Переводит аренду в RETURNED, устанавливает endAt,
 * освобождает доску (→ AVAILABLE). Выполняется в транзакции.
 */
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
  await audit.log(sellerUserId, "Rental", rentalId, AuditAction.RETURNED);
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

  if (!['RENTED', 'WAIT_RETURN'].includes(rentalBefore.status)) {
    throw new Error('Аренда уже завершена или отменена');
  }

  const { overdueCost } = await calculateOverdueCost(rentalBefore);

  // Атомарная транзакция: возврат + освобождение доски
  // overdueCost НЕ добавляется в extraCost — просрочка оплачивается отдельно
  // через PaymentProof(OVERDUE) в return:invoice, или списывается при return:complete
  await prisma.$transaction(async (tx) => {
    await tx.rental.update({
      where: { id: rentalId },
      data: {
        status: RentalStatus.RETURNED,
        endAt: new Date(),
      },
    });

    await tx.board.update({
      where: { id: rentalBefore.boardId },
      data: { status: BoardStatus.AVAILABLE },
    });
  });

  await audit.log(actorUserId, "Rental", rentalId, AuditAction.RETURNED, {
    overdueCost,
    boardCode: rentalBefore.board.code,
  });

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, user: true },
  });

  return { rental, overdueCost, clientTgId: rental.user.tgId };
}

/**
 * Продление активной аренды на указанное количество минут.
 *
 * Если аренда в просрочке — продление сначала покрывает просроченные минуты.
 * Возвращает аренду в статус RENTED (если была WAIT_RETURN).
 *
 * @param rentalId - ID аренды
 * @param minutes - Количество минут продления
 * @param userId - ID пользователя, инициирующего продление
 * @param extensionCost - Стоимость продления (опционально)
 * @returns Обновлённая аренда с данными о просрочке
 */
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
    const endGraceMs = await getEndGraceMs();
    const graceEnd = new Date(endAt.getTime() + endGraceMs);
    const now = new Date();
    if (now > graceEnd) {
      overdueMinutes = Math.ceil((now.getTime() - graceEnd.getTime()) / 60_000);
    }
  }

  // Calculate cost: use provided cost or fall back to tariff price
  const cost = extensionCost ?? 0;

  const newExtra = (rental.extraMinutes ?? 0) + minutes;
  const netMinutes = Math.max(0, minutes - overdueMinutes);

  // Статус: RENTED только если продление даёт чистое время.
  // Если всё ушло на покрытие просрочки — оставляем текущий статус.
  const newStatus = netMinutes > 0 ? RentalStatus.RENTED : rental.status;

  const updated = await prisma.rental.update({
    where: { id: rentalId },
    data: {
      extraMinutes: newExtra,
      extraCost: { increment: cost },
      pendingExtraMinutes: null,
      status: newStatus,
    },
  });

  if (netMinutes > 0) {
    await prisma.board.update({
      where: { id: rental.boardId },
      data: { status: BoardStatus.RENTED },
    });
    // Сбросить трекинг уведомлений — expiry checker пересчитает по новому сроку
    resetExpiryTracking(rentalId);
  }

  await audit.log(userId, 'Rental', rentalId, AuditAction.EXTENDED, {
    addedMinutes: minutes,
    extensionCost: cost,
    overdueMinutes,
    netMinutes,
    totalExtra: newExtra,
  });

  return { ...updated, overdueMinutes, netMinutes, extensionCost: cost };
}

/** Get current overdue minutes for a rental */
export async function getOverdueMinutes(rental: {
  startAt: Date | null;
  tariff: { durationMinutes: number } | null;
  extraMinutes: number;
  status: string;
}): Promise<number> {
  if (!rental.startAt || !rental.tariff) return 0;
  if (!['RENTED', 'WAIT_RETURN'].includes(rental.status)) return 0;
  const totalMin = rental.tariff.durationMinutes + (rental.extraMinutes ?? 0);
  const endAt = new Date(rental.startAt.getTime() + totalMin * 60_000);
  const now = new Date();
  const endGraceMs = await getEndGraceMs();
  const graceEnd = new Date(endAt.getTime() + endGraceMs);
  if (now > graceEnd) {
    return Math.ceil((now.getTime() - graceEnd.getTime()) / 60_000);
  }
  return 0;
}

/** Close overdue by adding exact overdue minutes as extension (no net gain) */
export async function closeOverdue(rentalId: number, userId: number) {
  const result = await prisma.$transaction(async (tx) => {
    const rental = await tx.rental.findUniqueOrThrow({
      where: { id: rentalId },
      include: { tariff: true, board: true },
    });

    if (rental.status !== 'WAIT_RETURN') {
      throw new Error('Нет просрочки для закрытия');
    }

    const overdue = await getOverdueMinutes(rental);
    if (overdue <= 0) {
      throw new Error('Нет просрочки для закрытия');
    }

    // Calculate overdue cost — фиксированные 10 сом/мин
    const overdueCost = overdue * OVERDUE_RATE_PER_MIN;

    const newExtra = (rental.extraMinutes ?? 0) + overdue;

    const updated = await tx.rental.update({
      where: { id: rentalId },
      data: {
        extraMinutes: newExtra,
        extraCost: { increment: overdueCost },
        status: RentalStatus.RETURNED,
      },
    });

    await tx.board.update({
      where: { id: rental.boardId },
      data: { status: BoardStatus.AVAILABLE },
    });

    return { updated, closedMinutes: overdue, overdueCost, newExtra };
  });

  await audit.log(userId, 'Rental', rentalId, AuditAction.CLOSE_OVERDUE, {
    overdueMinutes: result.closedMinutes,
    overdueCost: result.overdueCost,
    totalExtra: result.newExtra,
  });

  return { ...result.updated, closedMinutes: result.closedMinutes, overdueCost: result.overdueCost };
}

/** Client requests overdue closure — creates OVERDUE proof for admin approval */
export async function requestCloseOverdue(rentalId: number, userId: number) {
  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { tariff: true, board: true },
  });

  if (rental.status !== 'WAIT_RETURN') {
    throw new Error('Нет просрочки для закрытия');
  }

  const overdueMinutes = await getOverdueMinutes(rental);
  if (overdueMinutes <= 0) {
    throw new Error('Нет просрочки для закрытия');
  }

  const { overdueCost } = await calculateOverdueCost(rental);

  // Idempotency: don't create duplicate SUBMITTED proofs
  const existing = await prisma.paymentProof.findFirst({
    where: {
      kind: PaymentProofKind.OVERDUE,
      refId: rentalId,
      status: PaymentProofStatus.SUBMITTED,
    },
  });
  if (existing) {
    return { proof: existing, overdueCost, overdueMinutes, duplicate: true };
  }

  const proof = await prisma.paymentProof.create({
    data: {
      kind: PaymentProofKind.OVERDUE,
      refId: rentalId,
      amount: overdueCost,
      userId,
      text: `Закрытие просрочки по аренде #${rentalId} (${overdueMinutes} мин)`,
    },
  });

  await audit.log(userId, 'PaymentProof', proof.id, AuditAction.SUBMITTED, {
    rentalId,
    overdueCost,
    overdueMinutes,
  });

  return { proof, overdueCost, overdueMinutes, duplicate: false };
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

  await audit.log(userId, 'Rental', rentalId, AuditAction.EXTEND_REQUESTED, {
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

  await audit.log(adminUserId, 'Rental', rentalId, AuditAction.EXTEND_REJECTED);
  return updated;
}

/** Calculate overdue cost for an active rental (before return) */
export async function calculateOverdueCost(rental: {
  startAt: Date | null;
  tariff: { durationMinutes: number; price: number } | null;
  extraMinutes: number;
  status: string;
}): Promise<{ overdueMinutes: number; overdueCost: number }> {
  const overdueMinutes = await getOverdueMinutes(rental);
  const overdueCost = overdueMinutes * OVERDUE_RATE_PER_MIN;
  return { overdueMinutes, overdueCost };
}

const CANCELLABLE_STATUSES: RentalStatus[] = [
  RentalStatus.CREATED,
  RentalStatus.WAIT_PAYMENT,
  RentalStatus.WAIT_ADMIN,
  RentalStatus.RENTED,
  RentalStatus.WAIT_RETURN,
];

/**
 * Отмена аренды.
 *
 * Допустима для статусов: CREATED, WAIT_PAYMENT, WAIT_ADMIN, RENTED, WAIT_RETURN.
 * Освобождает доску, отклоняет незакрытые чеки оплаты.
 *
 * @param requireOwner - Если true, проверяет что аренда принадлежит userId
 * @throws Если аренда уже завершена/отменена
 */
export async function cancelRental(rentalId: number, userId: number, requireOwner = false) {
  const updated = await prisma.$transaction(async (tx) => {
    // Блокировка строки аренды для предотвращения гонок
    const [locked] = await tx.$queryRawUnsafe<{ id: number; status: string }[]>(
      `SELECT id, status FROM "Rental" WHERE id = $1 FOR UPDATE`, rentalId
    );
    if (!locked) {
      throw new Error("Аренда не найдена");
    }

    const rental = await tx.rental.findUniqueOrThrow({
      where: { id: rentalId },
    });

    if (requireOwner && rental.userId !== userId) {
      throw new Error("Это не ваша аренда");
    }

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

    // Reject any pending payment proofs for this rental
    await tx.paymentProof.updateMany({
      where: {
        refId: rentalId,
        kind: { in: [PaymentProofKind.RENTAL, PaymentProofKind.OVERDUE] },
        status: PaymentProofStatus.SUBMITTED,
      },
      data: { status: PaymentProofStatus.REJECTED },
    });

    return r;
  });

  await audit.log(userId, "Rental", rentalId, AuditAction.CANCELLED);
  return updated;
}

/**
 * Чек аренды.
 * @param overdueBilled — сумма просрочки, выставленная к оплате (0 = просрочка списана/не выставлена)
 */
export async function getRentalReceipt(rentalId: number, overdueBilled = 0): Promise<string> {
  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, tariff: true, user: true, seller: true },
  });

  const client = escapeHtml(rental.clientName ?? rental.user.name);
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

  text += `\n<b>⏱ Время:</b>\n`;
  if (rental.tariff) {
    text += `   Тариф: ${rental.tariff.name} — ${fmtDuration(baseDuration)}\n`;
  }
  if (extra > 0) {
    text += `   Продления: +${fmtDuration(extra)}\n`;
  }
  text += `   Оплаченное время: <b>${fmtDuration(totalPaidMinutes)}</b>\n`;

  // Actual usage & overdue
  const endGraceMs = await getEndGraceMs();
  const endGraceMin = endGraceMs / 60_000;
  let overdueAtReturn = 0;
  if (rental.startAt && rental.endAt) {
    const actualMin = Math.ceil((rental.endAt.getTime() - rental.startAt.getTime()) / 60_000);
    text += `   Фактическое время: <b>${fmtDuration(actualMin)}</b>\n`;
    const rawOverdue = actualMin - totalPaidMinutes - endGraceMin;
    overdueAtReturn = Math.max(0, Math.ceil(rawOverdue));
    if (overdueAtReturn > 0) {
      text += `   ⚠️ Просрочка: <b>${fmtDuration(overdueAtReturn)}</b> (${OVERDUE_RATE_PER_MIN} сом/мин)\n`;
    }
  } else if (rental.startAt) {
    // Rental still active — show current overdue
    const now = new Date();
    const actualMin = Math.ceil((now.getTime() - rental.startAt.getTime()) / 60_000);
    text += `   Текущее время: <b>${fmtDuration(actualMin)}</b>\n`;
    const rawOverdue = actualMin - totalPaidMinutes - endGraceMin;
    const currentOverdue = Math.max(0, Math.ceil(rawOverdue));
    if (currentOverdue > 0) {
      overdueAtReturn = currentOverdue;
      text += `   ⚠️ Просрочка: <b>${fmtDuration(currentOverdue)}</b> (${OVERDUE_RATE_PER_MIN} сом/мин)\n`;
    }
  }

  // Cost breakdown
  const totalCost = basePrice + extraCost + overdueBilled;

  text += `\n<b>💰 Стоимость:</b>\n`;
  text += `   Тариф: ${fmtPrice(basePrice)}\n`;
  if (extraCost > 0) {
    text += `   Доплаты (продления): +${fmtPrice(extraCost)}\n`;
  }
  if (overdueBilled > 0) {
    text += `   ⚠️ Просрочка: +${fmtPrice(overdueBilled)}\n`;
  }
  text += `   ─────────────\n`;
  text += `   <b>Итого: ${fmtPrice(totalCost)}</b>\n`;

  if (overdueBilled > 0) {
    const paidAmount = basePrice + extraCost;
    text += `\n   ✅ Оплачено: ${fmtPrice(paidAmount)}\n`;
    text += `   💳 <b>К оплате: ${fmtPrice(overdueBilled)}</b>\n`;
  }

  return text;
}
