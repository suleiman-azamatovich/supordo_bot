/**
 * Сервис отчётов — генерация дневной сводки по точке.
 *
 * Единый отчёт за сегодня: выручка, аренды, доски, оплаты, продления, просрочки.
 * Все даты в часовом поясе Asia/Bishkek.
 *
 * @module
 */
import { prisma } from "../db/prisma";
import { RentalStatus, BoardStatus, PaymentProofStatus, PaymentProofKind } from "@prisma/client";
import { fmtPrice, fmtDuration, truncateMessage } from "../ui/helpers";

import { config } from "../bot/config";

/** Начало дня по часовому поясу Бишкека (UTC+6) */
export function startOfDayBishkek(date: Date = new Date()): Date {
  const s = date.toLocaleDateString("en-CA", { timeZone: config.TIMEZONE }); // YYYY-MM-DD
  return new Date(`${s}T00:00:00+06:00`);
}

/** Конец дня (эксклюзивно — начало следующего) по часовому поясу Бишкека */
export function endOfDayBishkek(date: Date = new Date()): Date {
  const start = startOfDayBishkek(date);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

/** Парсинг даты из строки формата YYYY-MM-DD (интерпретируется в TZ Бишкека) */
export function parseDayKey(key: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const d = new Date(`${key}T00:00:00+06:00`);
  return isNaN(d.getTime()) ? null : d;
}

/** Ключ дня YYYY-MM-DD в часовом поясе Бишкека */
export function dayKey(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: config.TIMEZONE });
}

// ——— Дневной отчёт (полная сводка) ———

/**
 * Полная сводка за указанный день (по умолчанию — сегодня).
 *
 * @param day — произвольный момент внутри интересующего дня (в TZ Бишкека).
 *              Будет преобразован в диапазон [startOfDay, endOfDay).
 */
export async function dailyReport(day: Date = new Date()) {
  const since = startOfDayBishkek(day);
  const until = endOfDayBishkek(day);

  // Аренды
  const rentals = await prisma.rental.findMany({
    where: { createdAt: { gte: since, lt: until } },
    include: { tariff: true, board: true, user: true },
  });

  const active = rentals.filter((r) =>
    r.status === RentalStatus.RENTED || r.status === RentalStatus.WAIT_RETURN
  );
  const completed = rentals.filter((r) => r.status === RentalStatus.RETURNED);
  const cancelled = rentals.filter((r) => r.status === RentalStatus.CANCELLED);
  const pending = rentals.filter((r) =>
    r.status === RentalStatus.CREATED || r.status === RentalStatus.WAIT_PAYMENT || r.status === RentalStatus.WAIT_ADMIN
  );

  // Выручка = тариф (со скидкой) + доплаты (только успешные: RETURNED + RENTED + WAIT_RETURN)
  const paidRentals = rentals.filter((r) =>
    r.status === RentalStatus.RETURNED || r.status === RentalStatus.RENTED || r.status === RentalStatus.WAIT_RETURN
  );
  // Используем снапшот basePriceKgs (цена со скидкой клиента на момент создания).
  // Для старых записей fallback на tariff.price.
  const priceOf = (r: typeof paidRentals[number]) =>
    r.basePriceKgs ?? r.tariffPriceKgs ?? r.tariff?.price ?? 0;
  const listPriceOf = (r: typeof paidRentals[number]) =>
    r.tariffPriceKgs ?? r.tariff?.price ?? 0;
  const baseTariffRevenue = paidRentals.reduce((s, r) => s + priceOf(r), 0);
  const extraRevenue = paidRentals.reduce((s, r) => s + (r.extraCost ?? 0), 0);
  const totalRevenue = baseTariffRevenue + extraRevenue;
  const avgCheck = paidRentals.length > 0 ? Math.round(totalRevenue / paidRentals.length) : 0;

  // Сумма предоставленных скидок (прайс − реальная цена)
  const totalDiscountGiven = paidRentals.reduce(
    (s, r) => s + Math.max(0, listPriceOf(r) - priceOf(r)),
    0,
  );
  const discountedRentalsCount = paidRentals.filter((r) => (r.discountPercent ?? 0) > 0).length;

  // Оплаты
  const payments = await prisma.paymentProof.findMany({
    where: { createdAt: { gte: since, lt: until } },
  });
  const approvedPayments = payments.filter((p) => p.status === PaymentProofStatus.APPROVED);
  const rejectedPayments = payments.filter((p) => p.status === PaymentProofStatus.REJECTED);
  const pendingPayments = payments.filter((p) => p.status === PaymentProofStatus.SUBMITTED);

  // Выручка по видам оплат
  const rentalPayments = approvedPayments.filter((p) => p.kind === PaymentProofKind.RENTAL);
  const extensionPayments = approvedPayments.filter((p) => p.kind === PaymentProofKind.EXTENSION);
  const overduePayments = approvedPayments.filter((p) => p.kind === PaymentProofKind.OVERDUE);
  const rentalPaymentsSum = rentalPayments.reduce((s, p) => s + p.amount, 0);
  const extensionPaymentsSum = extensionPayments.reduce((s, p) => s + p.amount, 0);
  const overduePaymentsSum = overduePayments.reduce((s, p) => s + p.amount, 0);

  // Доски
  const boards = await prisma.board.findMany();
  const availableBoards = boards.filter((b) => b.status === BoardStatus.AVAILABLE);
  const rentedBoards = boards.filter((b) => b.status === BoardStatus.RENTED);
  const serviceBoards = boards.filter((b) => b.status === BoardStatus.SERVICE);

  // Продления за сегодня (из extraMinutes/extraCost активных+завершённых)
  const rentalsWithExtra = paidRentals.filter((r) => r.extraMinutes > 0);
  const totalExtraMinutes = rentalsWithExtra.reduce((s, r) => s + r.extraMinutes, 0);

  // Тарифы — сколько раз какой использовался
  const tariffStats = new Map<string, { count: number; revenue: number }>();
  for (const r of paidRentals) {
    if (!r.tariff) continue;
    const key = `${r.tariff.name} (${fmtPrice(r.tariff.price)})`;
    const entry = tariffStats.get(key) ?? { count: 0, revenue: 0 };
    entry.count++;
    entry.revenue += priceOf(r);
    tariffStats.set(key, entry);
  }

  // Walk-in vs клиентские аренды
  const walkinRentals = paidRentals.filter((r) => r.sellerUserId);
  const walkinCount = walkinRentals.length;
  const clientCount = paidRentals.filter((r) => !r.sellerUserId).length;
  const walkinRevenue = walkinRentals.reduce((s, r) => s + priceOf(r), 0);

  // Просрочки среди завершённых
  let overdueCount = 0;
  let totalOverdueMinutes = 0;
  for (const r of completed) {
    if (r.startAt && r.endAt && r.tariff) {
      const paidMinutes = r.tariff.durationMinutes + r.extraMinutes;
      const actualMinutes = Math.ceil((r.endAt.getTime() - r.startAt.getTime()) / 60_000);
      const overdue = Math.max(0, actualMinutes - paidMinutes);
      if (overdue > 0) {
        overdueCount++;
        totalOverdueMinutes += overdue;
      }
    }
  }

  return {
    // Аренды
    totalRentals: rentals.length,
    active, completed, cancelled, pending,
    paidCount: paidRentals.length,
    walkinCount, clientCount,
    // Выручка
    totalRevenue, baseTariffRevenue, extraRevenue, avgCheck,
    totalDiscountGiven, discountedRentalsCount,
    // Оплаты
    approvedPayments: approvedPayments.length,
    rejectedPayments: rejectedPayments.length,
    pendingPayments: pendingPayments.length,
    rentalPaymentsSum, extensionPaymentsSum, overduePaymentsSum, walkinRevenue,
    // Доски
    totalBoards: boards.length,
    availableBoards: availableBoards.length,
    rentedBoards: rentedBoards.length,
    serviceBoards: serviceBoards.length,
    // Продления
    extensionCount: rentalsWithExtra.length,
    totalExtraMinutes,
    // Просрочки
    overdueCount, totalOverdueMinutes,
    // Тарифы
    tariffStats,
  };
}

/** Форматирование дневного отчёта в Telegram HTML */
export function formatDailyReport(
  data: Awaited<ReturnType<typeof dailyReport>>,
  day: Date = new Date(),
): string {
  const dateStr = day.toLocaleDateString("ru-RU", {
    timeZone: config.TIMEZONE,
    day: "2-digit",
    month: "long",
    year: "numeric",
    weekday: "long",
  });

  const todayKey = dayKey(new Date());
  const isToday = dayKey(day) === todayKey;
  const title = isToday ? "Сводка за сегодня" : "Сводка за день";

  let text = `📊 <b>${title}</b>\n`;
  text += `📅 ${dateStr}\n`;

  // Если данных за день нет совсем — короткое сообщение
  if (data.totalRentals === 0 && data.approvedPayments === 0 && data.pendingPayments === 0 && data.rejectedPayments === 0) {
    text += `\n<i>Нет данных за этот день.</i>\n`;
    return truncateMessage(text);
  }

  // ─── Выручка ───
  text += `\n<b>💰 Выручка</b>\n`;
  text += `Общая: <b>${fmtPrice(data.totalRevenue)}</b>\n`;
  if (data.baseTariffRevenue > 0) {
    text += `  ├ Аренды: ${fmtPrice(data.baseTariffRevenue)}\n`;
  }
  if (data.extraRevenue > 0) {
    text += `  └ Доплаты: ${fmtPrice(data.extraRevenue)}\n`;
  }
  if (data.paidCount > 0) {
    text += `Средний чек: <b>${fmtPrice(data.avgCheck)}</b>\n`;
  }
  if (data.totalDiscountGiven > 0) {
    text += `🎁 Скидок предоставлено: <b>${fmtPrice(data.totalDiscountGiven)}</b>`;
    text += ` (в ${data.discountedRentalsCount} арендах)\n`;
  }

  // ─── Аренды ───
  text += `\n<b>🏄 Аренды</b> (${data.totalRentals})\n`;
  if (data.active.length > 0) {
    text += `  🔵 Активных: <b>${data.active.length}</b>\n`;
  }
  if (data.completed.length > 0) {
    text += `  ✅ Завершённых: <b>${data.completed.length}</b>\n`;
  }
  if (data.pending.length > 0) {
    text += `  ⏳ В обработке: <b>${data.pending.length}</b>\n`;
  }
  if (data.cancelled.length > 0) {
    text += `  ❌ Отменённых: <b>${data.cancelled.length}</b>\n`;
  }
  if (data.walkinCount > 0 || data.clientCount > 0) {
    text += `  👤 Walk-in: ${data.walkinCount}  ·  📱 Через бота: ${data.clientCount}\n`;
  }

  // ─── Оплаты ───
  text += `\n<b>💳 Оплаты</b>\n`;
  text += `  ✅ Принято: <b>${data.approvedPayments}</b>\n`;
  if (data.rejectedPayments > 0) {
    text += `  ❌ Отклонено: <b>${data.rejectedPayments}</b>\n`;
  }
  if (data.pendingPayments > 0) {
    text += `  🔍 На проверке: <b>${data.pendingPayments}</b>\n`;
  }
  if (data.rentalPaymentsSum > 0 || data.extensionPaymentsSum > 0 || data.overduePaymentsSum > 0 || data.walkinRevenue > 0) {
    text += `  <b>По категориям:</b>\n`;
    if (data.walkinRevenue > 0) {
      text += `    👤 Walk-in (наличные): ${fmtPrice(data.walkinRevenue)}\n`;
    }
    if (data.rentalPaymentsSum > 0) {
      text += `    📱 Аренды (через бота): ${fmtPrice(data.rentalPaymentsSum)}\n`;
    }
    if (data.extensionPaymentsSum > 0) {
      text += `    ⏱ Продления: ${fmtPrice(data.extensionPaymentsSum)}\n`;
    }
    if (data.overduePaymentsSum > 0) {
      text += `    ⚠️ Просрочки: ${fmtPrice(data.overduePaymentsSum)}\n`;
    }
  }

  // ─── Продления и просрочки ───
  if (data.extensionCount > 0 || data.overdueCount > 0) {
    text += `\n<b>⏱ Продления и просрочки</b>\n`;
    if (data.extensionCount > 0) {
      text += `  Продлений: <b>${data.extensionCount}</b> (+${fmtDuration(data.totalExtraMinutes)})\n`;
    }
    if (data.overdueCount > 0) {
      text += `  Просрочек: <b>${data.overdueCount}</b> (${fmtDuration(data.totalOverdueMinutes)})\n`;
    }
  }

  // ─── Тарифы ───
  if (data.tariffStats.size > 0) {
    text += `\n<b>📋 По тарифам</b>\n`;
    const sorted = [...data.tariffStats.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [name, stat] of sorted) {
      text += `  ▸ ${name}: <b>${stat.count}</b> шт — ${fmtPrice(stat.revenue)}\n`;
    }
  }

  // ─── Доски ───
  text += `\n<b>🏄 Доски</b> (${data.totalBoards})\n`;
  text += `  🟢 Свободно: <b>${data.availableBoards}</b>\n`;
  if (data.rentedBoards > 0) {
    text += `  🔵 В аренде: <b>${data.rentedBoards}</b>\n`;
  }
  if (data.serviceBoards > 0) {
    text += `  🔧 На обслуживании: <b>${data.serviceBoards}</b>\n`;
  }

  return truncateMessage(text);
}

/** Тип данных дневного отчёта — для секционных форматтеров */
export type DailyReportData = Awaited<ReturnType<typeof dailyReport>>;

// ─────────────────────────────────────────────────────────────
// Секционные форматтеры — для кнопочного UI в админке
// ─────────────────────────────────────────────────────────────

/** Красивая дата вида «понедельник, 18 апреля 2026» */
function fmtFullDate(day: Date): string {
  return day.toLocaleDateString("ru-RU", {
    timeZone: config.TIMEZONE,
    day: "2-digit",
    month: "long",
    year: "numeric",
    weekday: "long",
  });
}

/** Общий заголовок карточки дня */
function dayHeader(day: Date, subtitle: string): string {
  const todayKey = dayKey(new Date());
  const isToday = dayKey(day) === todayKey;
  const badge = isToday ? " · сегодня" : "";
  return `📊 <b>${subtitle}</b>\n📅 ${fmtFullDate(day)}${badge}\n`;
}

/** Обзорная карточка — короткая сводка с указателями на секции */
export function formatDailyOverview(data: DailyReportData, day: Date): string {
  let text = dayHeader(day, "Отчёт за день");

  if (data.totalRentals === 0 && data.approvedPayments === 0 &&
    data.pendingPayments === 0 && data.rejectedPayments === 0) {
    text += `\n<i>Нет данных за этот день.</i>`;
    return truncateMessage(text);
  }

  text += `\n💰 Выручка: <b>${fmtPrice(data.totalRevenue)}</b>`;
  if (data.paidCount > 0) {
    text += `  ·  средний чек <b>${fmtPrice(data.avgCheck)}</b>`;
  }
  text += `\n`;
  text += `🏄 Аренд создано: <b>${data.totalRentals}</b>`;
  if (data.active.length > 0) text += `  ·  🔵 активно ${data.active.length}`;
  if (data.pending.length > 0) text += `  ·  ⏳ в обработке ${data.pending.length}`;
  text += `\n`;
  text += `💳 Оплаты: ✅ ${data.approvedPayments}`;
  if (data.pendingPayments > 0) text += `  ·  🔍 ${data.pendingPayments}`;
  if (data.rejectedPayments > 0) text += `  ·  ❌ ${data.rejectedPayments}`;
  text += `\n`;
  if (data.totalDiscountGiven > 0) {
    text += `🎁 Скидок: <b>${fmtPrice(data.totalDiscountGiven)}</b>`;
    text += ` в ${data.discountedRentalsCount} арендах\n`;
  }
  if (data.extensionCount > 0 || data.overdueCount > 0) {
    const parts: string[] = [];
    if (data.extensionCount > 0) parts.push(`⏱ продлений ${data.extensionCount}`);
    if (data.overdueCount > 0) parts.push(`⚠️ просрочек ${data.overdueCount}`);
    text += `${parts.join("  ·  ")}\n`;
  }
  text += `\n<i>Выберите раздел для подробностей ↓</i>`;
  return truncateMessage(text);
}

/** Раздел «Выручка» */
export function formatDailyRevenue(data: DailyReportData, day: Date): string {
  let text = dayHeader(day, "💰 Выручка") + `\n`;
  if (data.totalRevenue === 0) {
    text += `<i>В этот день выручки не было.</i>`;
    return truncateMessage(text);
  }
  text += `Итого: <b>${fmtPrice(data.totalRevenue)}</b>\n`;
  if (data.baseTariffRevenue > 0) text += `  ├ Аренды: ${fmtPrice(data.baseTariffRevenue)}\n`;
  if (data.extraRevenue > 0) text += `  └ Доплаты: ${fmtPrice(data.extraRevenue)}\n`;
  if (data.paidCount > 0) text += `\nСредний чек: <b>${fmtPrice(data.avgCheck)}</b> (${data.paidCount} аренд)\n`;
  if (data.walkinRevenue > 0 || data.rentalPaymentsSum > 0) {
    text += `\n<b>По каналам:</b>\n`;
    if (data.walkinRevenue > 0) text += `  👤 Walk-in (наличные): ${fmtPrice(data.walkinRevenue)}\n`;
    if (data.rentalPaymentsSum > 0) text += `  📱 Через бота: ${fmtPrice(data.rentalPaymentsSum)}\n`;
    if (data.extensionPaymentsSum > 0) text += `  ⏱ Продления: ${fmtPrice(data.extensionPaymentsSum)}\n`;
    if (data.overduePaymentsSum > 0) text += `  ⚠️ Просрочки: ${fmtPrice(data.overduePaymentsSum)}\n`;
  }
  if (data.totalDiscountGiven > 0) {
    text += `\n🎁 Скидок предоставлено: <b>${fmtPrice(data.totalDiscountGiven)}</b>`;
    text += ` в ${data.discountedRentalsCount} арендах\n`;
  }
  return truncateMessage(text);
}

/** Раздел «Аренды» — счётчики по статусам + источникам */
export function formatDailyRentals(data: DailyReportData, day: Date): string {
  let text = dayHeader(day, `🏄 Аренды — ${data.totalRentals}`) + `\n`;
  if (data.totalRentals === 0) {
    text += `<i>Аренд за этот день не было.</i>`;
    return truncateMessage(text);
  }
  text += `🔵 Активных: <b>${data.active.length}</b>\n`;
  text += `✅ Завершённых: <b>${data.completed.length}</b>\n`;
  text += `⏳ В обработке: <b>${data.pending.length}</b>\n`;
  text += `❌ Отменённых: <b>${data.cancelled.length}</b>\n`;
  if (data.walkinCount > 0 || data.clientCount > 0) {
    text += `\n<b>По каналам:</b>\n`;
    text += `  👤 Walk-in: <b>${data.walkinCount}</b>\n`;
    text += `  📱 Через бота: <b>${data.clientCount}</b>\n`;
  }
  return truncateMessage(text);
}

/** Раздел «Оплаты» */
export function formatDailyPayments(data: DailyReportData, day: Date): string {
  let text = dayHeader(day, "💳 Оплаты") + `\n`;
  const total = data.approvedPayments + data.rejectedPayments + data.pendingPayments;
  if (total === 0) {
    text += `<i>За этот день оплат не было.</i>`;
    return truncateMessage(text);
  }
  text += `✅ Принято: <b>${data.approvedPayments}</b>\n`;
  if (data.rejectedPayments > 0) text += `❌ Отклонено: <b>${data.rejectedPayments}</b>\n`;
  if (data.pendingPayments > 0) text += `🔍 На проверке: <b>${data.pendingPayments}</b>\n`;
  if (data.rentalPaymentsSum > 0 || data.extensionPaymentsSum > 0 ||
    data.overduePaymentsSum > 0 || data.walkinRevenue > 0) {
    text += `\n<b>Суммы по категориям:</b>\n`;
    if (data.walkinRevenue > 0) text += `  👤 Walk-in: ${fmtPrice(data.walkinRevenue)}\n`;
    if (data.rentalPaymentsSum > 0) text += `  📱 Аренды: ${fmtPrice(data.rentalPaymentsSum)}\n`;
    if (data.extensionPaymentsSum > 0) text += `  ⏱ Продления: ${fmtPrice(data.extensionPaymentsSum)}\n`;
    if (data.overduePaymentsSum > 0) text += `  ⚠️ Просрочки: ${fmtPrice(data.overduePaymentsSum)}\n`;
  }
  return truncateMessage(text);
}

/** Раздел «Продления и просрочки» */
export function formatDailyExtensionsOverdue(data: DailyReportData, day: Date): string {
  let text = dayHeader(day, "⏱ Продления и просрочки") + `\n`;
  if (data.extensionCount === 0 && data.overdueCount === 0) {
    text += `<i>За этот день не было ни продлений, ни просрочек.</i>`;
    return truncateMessage(text);
  }
  if (data.extensionCount > 0) {
    text += `<b>⏱ Продления</b>\n`;
    text += `  Количество: <b>${data.extensionCount}</b>\n`;
    text += `  Добавлено времени: <b>${fmtDuration(data.totalExtraMinutes)}</b>\n`;
    text += `  Выручка: <b>${fmtPrice(data.extensionPaymentsSum)}</b>\n`;
  }
  if (data.overdueCount > 0) {
    if (data.extensionCount > 0) text += `\n`;
    text += `<b>⚠️ Просрочки</b>\n`;
    text += `  Количество: <b>${data.overdueCount}</b>\n`;
    text += `  Суммарно: <b>${fmtDuration(data.totalOverdueMinutes)}</b>\n`;
    text += `  Оплачено штрафов: <b>${fmtPrice(data.overduePaymentsSum)}</b>\n`;
  }
  return truncateMessage(text);
}

/** Раздел «Тарифы» */
export function formatDailyTariffs(data: DailyReportData, day: Date): string {
  let text = dayHeader(day, "📋 Тарифы за день") + `\n`;
  if (data.tariffStats.size === 0) {
    text += `<i>Нет данных по тарифам.</i>`;
    return truncateMessage(text);
  }
  const sorted = [...data.tariffStats.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [name, stat] of sorted) {
    text += `▸ ${name}\n`;
    text += `   <b>${stat.count}</b> шт  ·  ${fmtPrice(stat.revenue)}\n`;
  }
  return truncateMessage(text);
}

/** Раздел «Парк досок» — текущее состояние */
export function formatDailyBoards(data: DailyReportData, day: Date): string {
  let text = dayHeader(day, `🏄 Парк досок — ${data.totalBoards}`) + `\n`;
  text += `🟢 Свободно: <b>${data.availableBoards}</b>\n`;
  text += `🔵 В аренде: <b>${data.rentedBoards}</b>\n`;
  text += `🔧 На обслуживании: <b>${data.serviceBoards}</b>\n`;
  text += `\n<i>Показывает текущее состояние парка, а не исторический срез на ${dayKey(day)}.</i>`;
  return truncateMessage(text);
}

// ——— Список дней с активностью ———

/** Краткая сводка по одному дню — для списка дней в меню отчётов */
export interface DaySummary {
  /** Ключ дня YYYY-MM-DD (в TZ Бишкека) */
  key: string;
  /** Локальное начало дня */
  date: Date;
  /** Количество аренд, созданных в этот день */
  rentals: number;
  /** Суммарная выручка за день (тарифы + доплаты по успешным арендам) */
  revenue: number;
}

/**
 * Получить список дней, в которые была активность (создавались аренды или оплаты).
 *
 * Выручка рассчитывается упрощённо: сумма тарифов + extraCost по арендам,
 * у которых статус не CANCELLED (т. е. деньги были получены или ожидаются).
 *
 * Отсортировано от новых к старым.
 */
export async function listReportDays(): Promise<DaySummary[]> {
  const [rentals, payments] = await Promise.all([
    prisma.rental.findMany({
      select: {
        createdAt: true, status: true, extraCost: true,
        basePriceKgs: true, tariffPriceKgs: true,
        tariff: { select: { price: true } },
      },
    }),
    prisma.paymentProof.findMany({
      select: { createdAt: true },
    }),
  ]);

  const map = new Map<string, DaySummary>();

  const touch = (createdAt: Date): DaySummary => {
    const key = dayKey(createdAt);
    let entry = map.get(key);
    if (!entry) {
      entry = { key, date: startOfDayBishkek(createdAt), rentals: 0, revenue: 0 };
      map.set(key, entry);
    }
    return entry;
  };

  for (const r of rentals) {
    const entry = touch(r.createdAt);
    entry.rentals++;
    if (r.status !== RentalStatus.CANCELLED) {
      const price = r.basePriceKgs ?? r.tariffPriceKgs ?? r.tariff?.price ?? 0;
      entry.revenue += price + (r.extraCost ?? 0);
    }
  }

  for (const p of payments) {
    touch(p.createdAt);
  }

  return [...map.values()].sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** Получить соседний (предыдущий/следующий) день с активностью относительно указанного */
export async function adjacentReportDay(
  from: Date,
  direction: "prev" | "next",
): Promise<DaySummary | null> {
  const days = await listReportDays();
  const fromKey = dayKey(from);

  if (direction === "prev") {
    // Список отсортирован от новых к старым — ищем первый, чей ключ < fromKey
    return days.find((d) => d.key < fromKey) ?? null;
  } else {
    // Ищем первый день > fromKey (более новый). Идём с конца.
    const newer = days.filter((d) => d.key > fromKey);
    return newer.length > 0 ? newer[newer.length - 1] : null;
  }
}

// ——— Периодный отчёт (7/30 дней или произвольный) ———

/** Сводка за указанный диапазон дат */
export interface PeriodReport {
  /** Начало периода (включительно, 00:00 Бишкек) */
  from: Date;
  /** Конец периода (эксклюзивно, 00:00 следующего дня) */
  until: Date;
  /** Количество дней в периоде */
  daysCount: number;
  /** Всего аренд создано */
  totalRentals: number;
  /** Оплаченных аренд (не отменённых) */
  paidRentals: number;
  /** Выручка = тарифы со скидкой + доплаты */
  totalRevenue: number;
  /** Из тарифов */
  tariffRevenue: number;
  /** Из доплат (продления+просрочки) */
  extraRevenue: number;
  /** Средний чек */
  avgCheck: number;
  /** Средняя выручка за день */
  avgDailyRevenue: number;
  /** Walk-in vs через бота */
  walkinCount: number;
  clientCount: number;
  /** Скидки */
  totalDiscountGiven: number;
  discountedRentalsCount: number;
  /** Отменённые аренды */
  cancelledCount: number;
  /** Разбивка по дням: key → { revenue, rentals } */
  perDay: Array<{ key: string; date: Date; revenue: number; rentals: number }>;
  /** Топ тарифов */
  topTariffs: Array<{ name: string; count: number; revenue: number }>;
  /** Сравнение с предыдущим периодом такой же длительности */
  prev: {
    totalRevenue: number;
    paidRentals: number;
  };
}

/** Полная сводка за период [from, until) */
export async function periodReport(from: Date, until: Date): Promise<PeriodReport> {
  const daysCount = Math.max(1, Math.round((until.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));

  const rentals = await prisma.rental.findMany({
    where: { createdAt: { gte: from, lt: until } },
    include: { tariff: true },
  });

  const priceOf = (r: typeof rentals[number]) =>
    r.basePriceKgs ?? r.tariffPriceKgs ?? r.tariff?.price ?? 0;
  const listPriceOf = (r: typeof rentals[number]) =>
    r.tariffPriceKgs ?? r.tariff?.price ?? 0;

  const paidRentals = rentals.filter((r) =>
    r.status === RentalStatus.RETURNED || r.status === RentalStatus.RENTED || r.status === RentalStatus.WAIT_RETURN
  );
  const cancelled = rentals.filter((r) => r.status === RentalStatus.CANCELLED);

  const tariffRevenue = paidRentals.reduce((s, r) => s + priceOf(r), 0);
  const extraRevenue = paidRentals.reduce((s, r) => s + (r.extraCost ?? 0), 0);
  const totalRevenue = tariffRevenue + extraRevenue;
  const avgCheck = paidRentals.length > 0 ? Math.round(totalRevenue / paidRentals.length) : 0;
  const avgDailyRevenue = Math.round(totalRevenue / daysCount);

  const walkinCount = paidRentals.filter((r) => r.sellerUserId).length;
  const clientCount = paidRentals.length - walkinCount;

  const totalDiscountGiven = paidRentals.reduce(
    (s, r) => s + Math.max(0, listPriceOf(r) - priceOf(r)),
    0,
  );
  const discountedRentalsCount = paidRentals.filter((r) => (r.discountPercent ?? 0) > 0).length;

  // Разбивка по дням — заполняем все дни диапазона (включая пустые)
  const perDayMap = new Map<string, { key: string; date: Date; revenue: number; rentals: number }>();
  for (let i = 0; i < daysCount; i++) {
    const d = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
    const key = dayKey(d);
    perDayMap.set(key, { key, date: d, revenue: 0, rentals: 0 });
  }
  for (const r of rentals) {
    const key = dayKey(r.createdAt);
    const entry = perDayMap.get(key);
    if (!entry) continue;
    entry.rentals++;
    if (r.status !== RentalStatus.CANCELLED) {
      entry.revenue += priceOf(r) + (r.extraCost ?? 0);
    }
  }
  const perDay = [...perDayMap.values()].sort((a, b) => a.date.getTime() - b.date.getTime());

  // Топ тарифов
  const tariffStats = new Map<string, { count: number; revenue: number }>();
  for (const r of paidRentals) {
    if (!r.tariff) continue;
    const key = r.tariff.name;
    const entry = tariffStats.get(key) ?? { count: 0, revenue: 0 };
    entry.count++;
    entry.revenue += priceOf(r);
    tariffStats.set(key, entry);
  }
  const topTariffs = [...tariffStats.entries()]
    .map(([name, s]) => ({ name, ...s }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  // Предыдущий период такой же длительности
  const prevUntil = from;
  const prevFrom = new Date(from.getTime() - daysCount * 24 * 60 * 60 * 1000);
  const prevRentals = await prisma.rental.findMany({
    where: { createdAt: { gte: prevFrom, lt: prevUntil } },
    include: { tariff: true },
  });
  const prevPaid = prevRentals.filter((r) =>
    r.status === RentalStatus.RETURNED || r.status === RentalStatus.RENTED || r.status === RentalStatus.WAIT_RETURN
  );
  const prevRevenue = prevPaid.reduce(
    (s, r) => s + (r.basePriceKgs ?? r.tariffPriceKgs ?? r.tariff?.price ?? 0) + (r.extraCost ?? 0),
    0,
  );

  return {
    from,
    until,
    daysCount,
    totalRentals: rentals.length,
    paidRentals: paidRentals.length,
    totalRevenue,
    tariffRevenue,
    extraRevenue,
    avgCheck,
    avgDailyRevenue,
    walkinCount,
    clientCount,
    totalDiscountGiven,
    discountedRentalsCount,
    cancelledCount: cancelled.length,
    perDay,
    topTariffs,
    prev: {
      totalRevenue: prevRevenue,
      paidRentals: prevPaid.length,
    },
  };
}

/** Мини-спарклайн из чисел: Unicode-блоки ▁▂▃▄▅▆▇█ */
function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max === 0) return "▁".repeat(values.length);
  const chars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  return values
    .map((v) => {
      if (v === 0) return "▁";
      const idx = Math.min(chars.length - 1, Math.floor((v / max) * (chars.length - 1)));
      return chars[idx];
    })
    .join("");
}

/** Формат стрелки сравнения: ↑ +X% или ↓ −X% */
function compareBadge(current: number, previous: number): string {
  if (previous === 0) {
    return current > 0 ? "🆕" : "·";
  }
  const delta = ((current - previous) / previous) * 100;
  if (Math.abs(delta) < 0.5) return "≈ без изменений";
  const sign = delta >= 0 ? "↑" : "↓";
  const emoji = delta >= 0 ? "📈" : "📉";
  return `${emoji} ${sign} ${Math.abs(delta).toFixed(0)}%`;
}

/** Формат периода в заголовке: "14 — 20 апр" или "21 мар — 20 апр" */
function fmtPeriodLabel(from: Date, until: Date): string {
  const last = new Date(until.getTime() - 24 * 60 * 60 * 1000);
  const fromStr = from.toLocaleDateString("ru-RU", {
    timeZone: config.TIMEZONE, day: "2-digit", month: "short",
  });
  const toStr = last.toLocaleDateString("ru-RU", {
    timeZone: config.TIMEZONE, day: "2-digit", month: "short",
  });
  return `${fromStr} — ${toStr}`;
}

/** Форматирование периодного отчёта */
export function formatPeriodReport(data: PeriodReport): string {
  const label = fmtPeriodLabel(data.from, data.until);
  let text = `📈 <b>Отчёт за период</b>\n`;
  text += `🗓 ${label}  ·  ${data.daysCount} дн.\n\n`;

  // Главные числа
  text += `<b>💰 Выручка: ${fmtPrice(data.totalRevenue)}</b>\n`;
  text += `   ${compareBadge(data.totalRevenue, data.prev.totalRevenue)} vs пред. период (${fmtPrice(data.prev.totalRevenue)})\n`;
  text += `   Средний в день: ${fmtPrice(data.avgDailyRevenue)}\n\n`;

  text += `<b>🏄 Оплачено аренд: ${data.paidRentals}</b>\n`;
  text += `   ${compareBadge(data.paidRentals, data.prev.paidRentals)} vs пред. период (${data.prev.paidRentals})\n`;
  if (data.paidRentals > 0) {
    text += `   Средний чек: ${fmtPrice(data.avgCheck)}\n`;
  }
  if (data.walkinCount > 0 || data.clientCount > 0) {
    text += `   👤 Walk-in: ${data.walkinCount}  ·  📱 Бот: ${data.clientCount}\n`;
  }

  // Мини-график
  if (data.perDay.length > 1) {
    text += `\n<b>📊 Выручка по дням</b>\n`;
    const values = data.perDay.map((d) => d.revenue);
    text += `<code>${sparkline(values)}</code>\n`;
    const bestDay = [...data.perDay].sort((a, b) => b.revenue - a.revenue)[0];
    if (bestDay && bestDay.revenue > 0) {
      const bestLabel = bestDay.date.toLocaleDateString("ru-RU", {
        timeZone: config.TIMEZONE, weekday: "short", day: "2-digit", month: "short",
      });
      text += `🏆 Лучший: <b>${bestLabel}</b> — ${fmtPrice(bestDay.revenue)}\n`;
    }
  }

  // Скидки
  if (data.totalDiscountGiven > 0) {
    text += `\n🎁 <b>Скидок выдано:</b> ${fmtPrice(data.totalDiscountGiven)}`;
    text += ` (в ${data.discountedRentalsCount} арендах)\n`;
  }

  // Отмены
  if (data.cancelledCount > 0) {
    text += `\n❌ Отменённых аренд: ${data.cancelledCount}\n`;
  }

  // Топ тарифов
  if (data.topTariffs.length > 0) {
    text += `\n<b>🔝 Популярные тарифы</b>\n`;
    for (const t of data.topTariffs) {
      text += `   ▸ ${t.name}: <b>${t.count}</b> шт — ${fmtPrice(t.revenue)}\n`;
    }
  }

  return truncateMessage(text);
}

// ——— Календарь месяца (для выбора даты) ———

/** Данные одного дня календаря */
export interface CalendarDay {
  key: string;
  day: number;          // число месяца (1..31)
  weekday: number;      // 0=Пн, 6=Вс
  hasActivity: boolean;
  revenue: number;
  rentals: number;
  isToday: boolean;
  isFuture: boolean;
}

/** Построить календарь месяца. month: 1..12 */
export async function monthCalendar(year: number, month: number): Promise<{
  year: number;
  month: number;
  monthLabel: string;
  days: CalendarDay[];
  totalRevenue: number;
  totalRentals: number;
}> {
  const from = new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00+06:00`);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const until = new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+06:00`);

  const rentals = await prisma.rental.findMany({
    where: { createdAt: { gte: from, lt: until } },
    select: {
      createdAt: true, status: true, extraCost: true,
      basePriceKgs: true, tariffPriceKgs: true,
      tariff: { select: { price: true } },
    },
  });

  const byKey = new Map<string, { revenue: number; rentals: number }>();
  for (const r of rentals) {
    const key = dayKey(r.createdAt);
    const entry = byKey.get(key) ?? { revenue: 0, rentals: 0 };
    entry.rentals++;
    if (r.status !== RentalStatus.CANCELLED) {
      const price = r.basePriceKgs ?? r.tariffPriceKgs ?? r.tariff?.price ?? 0;
      entry.revenue += price + (r.extraCost ?? 0);
    }
    byKey.set(key, entry);
  }

  const todayKey = dayKey(new Date());
  const daysInMonth = Math.round((until.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));

  const weekdayFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: config.TIMEZONE,
    weekday: "short",
  });
  const weekdayMap: Record<string, number> = {
    Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
  };

  const days: CalendarDay[] = [];
  for (let i = 0; i < daysInMonth; i++) {
    const d = new Date(from.getTime() + i * 24 * 60 * 60 * 1000);
    const key = dayKey(d);
    const stats = byKey.get(key) ?? { revenue: 0, rentals: 0 };
    const weekday = weekdayMap[weekdayFmt.format(d)] ?? 0;
    days.push({
      key,
      day: i + 1,
      weekday,
      hasActivity: stats.rentals > 0,
      revenue: stats.revenue,
      rentals: stats.rentals,
      isToday: key === todayKey,
      isFuture: key > todayKey,
    });
  }

  const monthLabel = from.toLocaleDateString("ru-RU", {
    timeZone: config.TIMEZONE, month: "long", year: "numeric",
  });
  const totalRevenue = [...byKey.values()].reduce((s, v) => s + v.revenue, 0);
  const totalRentals = [...byKey.values()].reduce((s, v) => s + v.rentals, 0);

  return { year, month, monthLabel, days, totalRevenue, totalRentals };
}

/** Быстрая компактная статистика дня (для хаба) */
export async function quickDayStats(day: Date): Promise<{
  revenue: number;
  paidRentals: number;
  activeRentals: number;
}> {
  const since = startOfDayBishkek(day);
  const until = endOfDayBishkek(day);
  const rentals = await prisma.rental.findMany({
    where: { createdAt: { gte: since, lt: until } },
    include: { tariff: true },
  });
  const priceOf = (r: typeof rentals[number]) =>
    r.basePriceKgs ?? r.tariffPriceKgs ?? r.tariff?.price ?? 0;
  const paid = rentals.filter((r) =>
    r.status === RentalStatus.RETURNED || r.status === RentalStatus.RENTED || r.status === RentalStatus.WAIT_RETURN,
  );
  const active = rentals.filter((r) =>
    r.status === RentalStatus.RENTED || r.status === RentalStatus.WAIT_RETURN,
  );
  const revenue = paid.reduce((s, r) => s + priceOf(r) + (r.extraCost ?? 0), 0);
  return { revenue, paidRentals: paid.length, activeRentals: active.length };
}

