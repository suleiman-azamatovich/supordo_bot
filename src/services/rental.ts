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
import { applyDiscount, normalizePercent } from "./pricing";

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
 * @returns Грейс в миллисекундах: 10 сек (тест) | 3 мин (рабочий)
 */
export async function getStartGraceMs(): Promise<number> {
  return (await isTestMode()) ? 10_000 : 3 * 60_000;
}

/**
 * Грейс-период после окончания аренды до начала начисления просрочки.
 * @returns Грейс в миллисекундах: 10 сек (тест) | 5 мин (рабочий)
 */
export async function getEndGraceMs(): Promise<number> {
  return (await isTestMode()) ? 10_000 : 5 * 60_000;
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
 * Применить скидку к активной аренде.
 *
 * Пересчитывает `basePriceKgs` и `discountPercent`. Если есть незакрытый
 * чек оплаты (SUBMITTED), его сумма тоже обновляется.
 *
 * @param rentalId - ID аренды
 * @param discount - тип `percent` (0..100) или `amount` (сом, 0..listPrice)
 * @param actorUserId - ID администратора
 */
export async function applyRentalDiscount(
  rentalId: number,
  discount: { type: "percent"; value: number } | { type: "amount"; value: number },
  actorUserId: number,
): Promise<{ basePriceKgs: number; discountPercent: number; savedKgs: number }> {
  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { tariff: true },
  });

  const TERMINAL_STATUSES: RentalStatus[] = [RentalStatus.RETURNED, RentalStatus.CANCELLED];
  if (TERMINAL_STATUSES.includes(rental.status)) {
    throw new Error("Нельзя применить скидку к завершённой или отменённой аренде");
  }

  const listPrice = rental.tariffPriceKgs ?? rental.tariff?.price ?? 0;
  if (listPrice <= 0) {
    throw new Error("Не удалось определить прайс тарифа");
  }

  let basePriceKgs: number;
  let discountPercent: number;

  if (discount.type === "percent") {
    discountPercent = normalizePercent(discount.value);
    basePriceKgs = applyDiscount(listPrice, discountPercent);
  } else {
    const amount = Math.max(0, Math.min(Math.round(discount.value), listPrice));
    basePriceKgs = listPrice - amount;
    discountPercent = Math.round((amount * 100) / listPrice);
  }

  const savedKgs = listPrice - basePriceKgs;

  await prisma.$transaction(async (tx) => {
    await tx.rental.update({
      where: { id: rentalId },
      data: { basePriceKgs, discountPercent },
    });

    // Обновляем незакрытый чек оплаты за тариф (если клиент ещё не оплатил)
    await tx.paymentProof.updateMany({
      where: {
        refId: rentalId,
        kind: PaymentProofKind.RENTAL,
        status: PaymentProofStatus.SUBMITTED,
      },
      data: { amount: basePriceKgs },
    });
  });

  await audit.log(actorUserId, "Rental", rentalId, AuditAction.TARIFF_UPDATED, {
    action: "discount_applied",
    discountType: discount.type,
    discountValue: discount.value,
    listPrice,
    basePriceKgs,
    discountPercent,
    savedKgs,
  });

  return { basePriceKgs, discountPercent, savedKgs };
}



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
  const [tariff, clientUser] = await Promise.all([
    prisma.tariff.findUniqueOrThrow({ where: { id: params.tariffId } }),
    prisma.user.findUniqueOrThrow({ where: { id: params.userId } }),
  ]);

  // Снапшот скидки клиента на момент создания (даже если потом админ изменит).
  const discountPercent = normalizePercent(clientUser.discountPercent);
  const basePriceKgs = applyDiscount(tariff.price, discountPercent);

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
        tariffPriceKgs: tariff.price,
        basePriceKgs,
        discountPercent,
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
    tariffPrice: tariff.price,
    basePrice: basePriceKgs,
    discountPercent,
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

  // Walk-in аренды оформляются без привязки к конкретному клиентскому профилю
  // (`userId = sellerUserId`), поэтому персональные скидки не применяются.
  const discountPercent = 0;
  const basePriceKgs = tariff.price;

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
        tariffPriceKgs: tariff.price,
        basePriceKgs,
        discountPercent,
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
    tariffPrice: tariff.price,
    basePrice: basePriceKgs,
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
 * Проверка и создание выполняются атомарно в одной транзакции.
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
  // Атомарная проверка + создание в одной транзакции для предотвращения дублей
  const result = await prisma.$transaction(async (tx) => {
    // Блокируем строку аренды для сериализации конкурентных отправок
    await tx.$queryRawUnsafe(
      `SELECT id FROM "Rental" WHERE id = $1 FOR UPDATE`, params.rentalId
    );

    // Idempotency: не создаём дубликат SUBMITTED/APPROVED чека
    const existing = await tx.paymentProof.findFirst({
      where: {
        kind: PaymentProofKind.RENTAL,
        refId: params.rentalId,
        status: { in: [PaymentProofStatus.SUBMITTED, PaymentProofStatus.APPROVED] },
      },
    });
    if (existing) {
      return { proof: existing, duplicate: true };
    }

    const proof = await tx.paymentProof.create({
      data: {
        kind: PaymentProofKind.RENTAL,
        refId: params.rentalId,
        amount: params.amount,
        fileId: params.fileId,
        text: params.text,
        userId: params.userId,
      },
    });

    await tx.rental.update({
      where: { id: params.rentalId },
      data: { status: RentalStatus.WAIT_ADMIN },
    });

    return { proof, duplicate: false };
  });

  if (!result.duplicate) {
    await audit.log(params.userId, "PaymentProof", result.proof.id, AuditAction.SUBMITTED, {
      rentalId: params.rentalId,
      amount: params.amount,
    });
  }

  return result;
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
 * Завершение аренды: расчёт просрочки + возврат доски в одной транзакции.
 *
 * Блокирует строку аренды через SELECT FOR UPDATE, считает просрочку
 * и атомарно выполняет возврат. Предотвращает race condition при
 * конкурентном нажатии кнопки возврата.
 */
export async function completeReturn(rentalId: number, actorUserId: number) {
  const result = await prisma.$transaction(async (tx) => {
    // Блокируем строку аренды для предотвращения двойного завершения
    await tx.$queryRawUnsafe(
      `SELECT id FROM "Rental" WHERE id = $1 FOR UPDATE`, rentalId
    );

    const rentalBefore = await tx.rental.findUniqueOrThrow({
      where: { id: rentalId },
      include: { board: true, tariff: true, user: true },
    });

    if (!['RENTED', 'WAIT_RETURN'].includes(rentalBefore.status)) {
      throw new Error('Аренда уже завершена или отменена');
    }

    // Расчёт просрочки внутри транзакции — данные консистентны
    const { overdueCost } = await calculateOverdueCost(rentalBefore);

    const rental = await tx.rental.update({
      where: { id: rentalId },
      data: {
        status: RentalStatus.RETURNED,
        endAt: new Date(),
      },
      include: { board: true, user: true },
    });

    await tx.board.update({
      where: { id: rentalBefore.boardId },
      data: { status: BoardStatus.AVAILABLE },
    });

    return { rental, overdueCost, clientTgId: rental.user.tgId, boardCode: rentalBefore.board.code };
  });

  await audit.log(actorUserId, "Rental", rentalId, AuditAction.RETURNED, {
    overdueCost: result.overdueCost,
    boardCode: result.boardCode,
  });

  return { rental: result.rental, overdueCost: result.overdueCost, clientTgId: result.clientTgId };
}

/**
 * Продление активной аренды на указанное количество минут.
 *
 * Если аренда в просрочке — продление сначала покрывает просроченные минуты.
 * Возвращает аренду в статус RENTED (если была WAIT_RETURN).
 *
 * Оборачивается в транзакцию с SELECT FOR UPDATE для защиты от двойного продления.
 *
 * @param rentalId - ID аренды
 * @param minutes - Количество минут продления
 * @param userId - ID пользователя, инициирующего продление
 * @param extensionCost - Стоимость продления (опционально)
 * @param requirePending - Если true, проверяет pendingExtraMinutes внутри транзакции (защита от двойного apply)
 * @returns Обновлённая аренда с данными о просрочке
 */
export async function extendRental(rentalId: number, minutes: number, userId: number, extensionCost?: number, requirePending = false) {
  // Получаем endGraceMs до транзакции (не блокирует строки)
  const endGraceMs = await getEndGraceMs();

  const result = await prisma.$transaction(async (tx) => {
    // Блокируем строку аренды от конкурентных обновлений
    await tx.$queryRaw`SELECT id FROM "Rental" WHERE id = ${rentalId} FOR UPDATE`;

    const rental = await tx.rental.findUniqueOrThrow({
      where: { id: rentalId },
      include: { tariff: true, board: true },
    });

    if (!['RENTED', 'WAIT_RETURN'].includes(rental.status)) {
      throw new Error('Продлить можно только активную аренду');
    }

    // Защита от двойного применения продления (race condition pay:approve + ext:approve)
    if (requirePending && rental.pendingExtraMinutes == null) {
      throw new Error('Продление уже было обработано');
    }

    // Расчёт просрочки — extension сначала покрывает просроченные минуты
    let overdueMinutes = 0;
    if (rental.startAt && rental.tariff) {
      const totalMin = rental.tariff.durationMinutes + (rental.extraMinutes ?? 0);
      const endAt = new Date(rental.startAt.getTime() + totalMin * 60_000);
      const graceEnd = new Date(endAt.getTime() + endGraceMs);
      const now = new Date();
      if (now > graceEnd) {
        overdueMinutes = Math.ceil((now.getTime() - graceEnd.getTime()) / 60_000);
      }
    }

    const cost = extensionCost ?? 0;
    const newExtra = (rental.extraMinutes ?? 0) + minutes;
    const netMinutes = Math.max(0, minutes - overdueMinutes);

    // RENTED только если продление даёт чистое время
    const newStatus = netMinutes > 0 ? RentalStatus.RENTED : rental.status;

    const updated = await tx.rental.update({
      where: { id: rentalId },
      data: {
        extraMinutes: newExtra,
        extraCost: { increment: cost },
        pendingExtraMinutes: null,
        pendingExtraAmount: null,
        status: newStatus,
      },
    });

    if (netMinutes > 0) {
      await tx.board.update({
        where: { id: rental.boardId },
        data: { status: BoardStatus.RENTED },
      });
    }

    return { updated, overdueMinutes, netMinutes, cost };
  });

  // Сбросить трекинг уведомлений — expiry checker пересчитает по новому сроку
  if (result.netMinutes > 0) {
    resetExpiryTracking(rentalId);
  }

  await audit.log(userId, 'Rental', rentalId, AuditAction.EXTENDED, {
    addedMinutes: minutes,
    extensionCost: result.cost,
    overdueMinutes: result.overdueMinutes,
    netMinutes: result.netMinutes,
    totalExtra: (result.updated.extraMinutes ?? 0),
  });

  return { ...result.updated, overdueMinutes: result.overdueMinutes, netMinutes: result.netMinutes, extensionCost: result.cost };
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
  // Вычисляем endGraceMs до транзакции чтобы избежать deadlock
  const endGraceMs = await getEndGraceMs();

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Rental" WHERE id = ${rentalId} FOR UPDATE`;

    const rental = await tx.rental.findUniqueOrThrow({
      where: { id: rentalId },
      include: { tariff: true, board: true },
    });

    if (rental.status !== 'WAIT_RETURN') {
      throw new Error('Нет просрочки для закрытия');
    }

    // Расчёт просрочки с предвычисленным грейсом
    let overdue = 0;
    if (rental.startAt && rental.tariff) {
      const totalMin = rental.tariff.durationMinutes + (rental.extraMinutes ?? 0);
      const endAt = new Date(rental.startAt.getTime() + totalMin * 60_000);
      const graceEnd = new Date(endAt.getTime() + endGraceMs);
      const now = new Date();
      if (now > graceEnd) {
        overdue = Math.ceil((now.getTime() - graceEnd.getTime()) / 60_000);
      }
    }

    if (overdue <= 0) {
      throw new Error('Нет просрочки для закрытия');
    }

    // Calculate overdue cost с учётом скидки клиента (снапшот в Rental.discountPercent)
    const grossCost = overdue * OVERDUE_RATE_PER_MIN;
    const overdueCost = applyDiscount(grossCost, rental.discountPercent ?? 0);

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

/** Client requests extension — needs admin approval.
 * Фиксирует запрошенные минуты и сумму в снапшотах Rental,
 * чтобы изменение цены тарифа не повлияло на уже запрошенное продление.
 */
export async function requestExtend(rentalId: number, minutes: number, userId: number, amountKgs: number) {
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
    data: { pendingExtraMinutes: minutes, pendingExtraAmount: amountKgs },
  });

  await audit.log(userId, 'Rental', rentalId, AuditAction.EXTEND_REQUESTED, {
    requestedMinutes: minutes,
    amountKgs,
  });

  return updated;
}

/** Admin rejects extension request */
export async function rejectExtend(rentalId: number, adminUserId: number) {
  const updated = await prisma.rental.update({
    where: { id: rentalId },
    data: { pendingExtraMinutes: null, pendingExtraAmount: null },
  });

  await audit.log(adminUserId, 'Rental', rentalId, AuditAction.EXTEND_REJECTED);
  return updated;
}

/**
 * Расчёт стоимости просрочки для активной аренды (до возврата).
 *
 * Учитывает снапшот скидки клиента (`rental.discountPercent`): если у клиента
 * есть персональная скидка, она применяется и к оплате просрочки.
 */
export async function calculateOverdueCost(rental: {
  startAt: Date | null;
  tariff: { durationMinutes: number; price: number } | null;
  extraMinutes: number;
  status: string;
  discountPercent?: number | null;
}): Promise<{ overdueMinutes: number; overdueCost: number; overdueCostGross: number }> {
  const overdueMinutes = await getOverdueMinutes(rental);
  const gross = overdueMinutes * OVERDUE_RATE_PER_MIN;
  const overdueCost = applyDiscount(gross, rental.discountPercent ?? 0);
  return { overdueMinutes, overdueCost, overdueCostGross: gross };
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
        kind: { in: [PaymentProofKind.RENTAL, PaymentProofKind.OVERDUE, PaymentProofKind.EXTENSION] },
        status: PaymentProofStatus.SUBMITTED,
      },
      data: { status: PaymentProofStatus.REJECTED },
    });

    // Сбросить pending extension если было
    if (r.pendingExtraMinutes != null) {
      await tx.rental.update({
        where: { id: rentalId },
        data: { pendingExtraMinutes: null, pendingExtraAmount: null },
      });
    }

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
  // Используем снапшот (basePriceKgs) — цена с учётом скидки, зафиксированной
  // на момент создания аренды. Для старых записей fallback на tariff.price.
  const tariffListPrice = rental.tariffPriceKgs ?? rental.tariff?.price ?? 0;
  const basePrice = rental.basePriceKgs ?? tariffListPrice;
  const discountPct = rental.discountPercent ?? 0;
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
  if (rental.startAt && rental.endAt) {
    const actualMin = Math.ceil((rental.endAt.getTime() - rental.startAt.getTime()) / 60_000);
    text += `   Фактическое время: <b>${fmtDuration(actualMin)}</b>\n`;
    const rawOverdue = actualMin - totalPaidMinutes - endGraceMin;
    const overdueAtReturn = Math.max(0, Math.ceil(rawOverdue));
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
      text += `   ⚠️ Просрочка: <b>${fmtDuration(currentOverdue)}</b> (${OVERDUE_RATE_PER_MIN} сом/мин)\n`;
    }
  }

  // Cost breakdown
  const totalCost = basePrice + extraCost + overdueBilled;

  text += `\n<b>💰 Стоимость:</b>\n`;
  if (tariffListPrice > basePrice) {
    const savedKgs = tariffListPrice - basePrice;
    const pctLabel = discountPct > 0 ? ` −${discountPct}%` : "";
    text += `   Тариф (прайс): ${fmtPrice(tariffListPrice)}\n`;
    text += `   🎁 Скидка:${pctLabel} <b>−${fmtPrice(savedKgs)}</b>\n`;
    text += `   Тариф со скидкой: ${fmtPrice(basePrice)}\n`;
  } else {
    text += `   Тариф: ${fmtPrice(basePrice)}\n`;
  }
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
