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

// ——— Дневной отчёт (полная сводка) ———

/** Полная сводка за сегодня */
export async function dailyReport() {
  const since = startOfDayBishkek();

  // Аренды
  const rentals = await prisma.rental.findMany({
    where: { createdAt: { gte: since } },
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

  // Выручка = тариф + доплаты (только успешные: RETURNED + RENTED + WAIT_RETURN)
  const paidRentals = rentals.filter((r) =>
    r.status === RentalStatus.RETURNED || r.status === RentalStatus.RENTED || r.status === RentalStatus.WAIT_RETURN
  );
  const baseTariffRevenue = paidRentals.reduce((s, r) => s + (r.tariff?.price ?? 0), 0);
  const extraRevenue = paidRentals.reduce((s, r) => s + (r.extraCost ?? 0), 0);
  const totalRevenue = baseTariffRevenue + extraRevenue;
  const avgCheck = paidRentals.length > 0 ? Math.round(totalRevenue / paidRentals.length) : 0;

  // Оплаты
  const payments = await prisma.paymentProof.findMany({
    where: { createdAt: { gte: since } },
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
    entry.revenue += r.tariff.price;
    tariffStats.set(key, entry);
  }

  // Walk-in vs клиентские аренды
  const walkinRentals = paidRentals.filter((r) => r.sellerUserId);
  const walkinCount = walkinRentals.length;
  const clientCount = paidRentals.filter((r) => !r.sellerUserId).length;
  const walkinRevenue = walkinRentals.reduce((s, r) => s + (r.tariff?.price ?? 0), 0);

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
export function formatDailyReport(data: Awaited<ReturnType<typeof dailyReport>>): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("ru-RU", {
    timeZone: config.TIMEZONE,
    day: "2-digit",
    month: "long",
    year: "numeric",
    weekday: "long",
  });

  let text = `📊 <b>Сводка за день</b>\n`;
  text += `📅 ${dateStr}\n`;

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
