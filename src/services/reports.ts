/**
 * Сервис отчётов — генерация статистики по арендам.
 *
 * Отчёты: сегодня, неделя (по дням), выручка по тарифам.
 * Все даты в часовом поясе Asia/Bishkek.
 *
 * @module
 */
import { prisma } from "../db/prisma";
import { RentalStatus } from "@prisma/client";
import { fmtPrice, fmtDuration, escapeHtml, truncateMessage } from "../ui/helpers";

import { config } from "../bot/config";

/** Начало дня по часовому поясу Бишкека (UTC+6) */
export function startOfDayBishkek(date: Date = new Date()): Date {
  const s = date.toLocaleDateString("en-CA", { timeZone: config.TIMEZONE }); // YYYY-MM-DD
  return new Date(`${s}T00:00:00+06:00`);
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return startOfDayBishkek(d);
}

function shortWeekday(d: Date): string {
  return d.toLocaleDateString("ru-RU", { timeZone: config.TIMEZONE, weekday: "short" });
}

function shortDate(d: Date): string {
  return d.toLocaleDateString("ru-RU", { timeZone: config.TIMEZONE, day: "2-digit", month: "2-digit" });
}

// ——— Today report ———

/** Отчёт за сегодня: выручка, число аренд, средний чек, отмены */
export async function todayReport() {
  const since = startOfDayBishkek();

  const rentals = await prisma.rental.findMany({
    where: { createdAt: { gte: since } },
    include: { tariff: true, board: true, user: true, seller: true },
    orderBy: { createdAt: "desc" },
  });

  const completed = rentals.filter((r) =>
    (r.status === RentalStatus.RETURNED || r.status === RentalStatus.RENTED || r.status === RentalStatus.WAIT_RETURN)
  );
  const revenue = completed.reduce((s, r) => s + (r.tariff?.price ?? 0) + (r.extraCost ?? 0), 0);
  const count = completed.length;
  const cancelled = rentals.filter((r) => r.status === RentalStatus.CANCELLED).length;
  const avg = count > 0 ? Math.round(revenue / count) : 0;

  return { revenue, count, cancelled, avg, rentals };
}

/** Форматирование отчёта за сегодня в Telegram HTML */
export function formatTodayReport(data: Awaited<ReturnType<typeof todayReport>>): string {
  let text = `📊 <b>Сегодня</b>\n\n`;
  text += `💰 Выручка: <b>${fmtPrice(data.revenue)}</b>\n`;
  text += `🏄 Аренд: <b>${data.count}</b>\n`;
  text += `💵 Средний чек: <b>${data.avg > 0 ? fmtPrice(data.avg) : "—"}</b>\n`;
  text += `❌ Отмен: <b>${data.cancelled}</b>\n\n`;

  if (data.rentals.length > 0) {
    text += `<b>Список аренд:</b>\n`;
    for (const r of data.rentals) {
      if (r.status === RentalStatus.CANCELLED) continue;
      const client = escapeHtml(r.clientName ?? r.user.name);
      const source = r.sellerUserId ? "👤 админ" : "📱 клиент";
      const tariffInfo = r.tariff ? `${fmtDuration(r.tariff.durationMinutes)}` : "";
      const price = r.tariff ? fmtPrice(r.tariff.price) : "—";
      const extra = r.extraMinutes ?? 0;

      const statusMap: Record<string, string> = {
        RENTED: "🔴 в аренде",
        WAIT_RETURN: "⏰ возврат",
        RETURNED: "✅ завершена",
        CREATED: "⏳ создана",
        WAIT_PAYMENT: "💳 ожидает оплаты",
        WAIT_ADMIN: "🔍 проверка",
      };
      const statusText = statusMap[r.status] ?? r.status;

      text += `\n▸ <b>${r.board.code}</b> → ${client}\n`;
      text += `   ${tariffInfo} · ${price} · ${statusText}\n`;
      if (extra > 0) {
        text += `   ⏱ +${fmtDuration(extra)} продления\n`;
      }

      // Overdue info for returned or active rentals
      if (r.status === RentalStatus.RETURNED && r.startAt && r.endAt && r.tariff) {
        const totalPaid = r.tariff.durationMinutes + extra;
        const actual = Math.ceil((r.endAt.getTime() - r.startAt.getTime()) / 60_000);
        const overdue = Math.max(0, actual - totalPaid);
        if (overdue > 0) {
          text += `   ⚠️ просрочка: ${fmtDuration(overdue)}\n`;
        }
      } else if ((r.status === RentalStatus.WAIT_RETURN || r.status === RentalStatus.RENTED) && r.startAt && r.tariff) {
        const totalPaid = r.tariff.durationMinutes + extra;
        const actual = Math.ceil((Date.now() - r.startAt.getTime()) / 60_000);
        const overdue = Math.max(0, actual - totalPaid);
        if (overdue > 0) {
          text += `   ⚠️ просрочка: ${fmtDuration(overdue)}\n`;
        }
      }
      text += `   ${source}\n`;
    }
  }

  return truncateMessage(text);
}

// ——— Week report (by day) ———

/** Отчёт за неделю с разбивкой по дням (последние 7 дней) */
export async function weekReport() {
  const since = daysAgo(7);

  const rentals = await prisma.rental.findMany({
    where: {
      createdAt: { gte: since },
      status: { in: [RentalStatus.RETURNED, RentalStatus.RENTED, RentalStatus.WAIT_RETURN] },
    },
    include: { tariff: true },
  });

  // Build per-day map
  const dayMap = new Map<string, { revenue: number; count: number }>();
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString("en-CA", { timeZone: config.TIMEZONE });
    dayMap.set(key, { revenue: 0, count: 0 });
  }

  for (const r of rentals) {
    const key = r.createdAt.toLocaleDateString("en-CA", { timeZone: config.TIMEZONE });
    const entry = dayMap.get(key);
    if (entry) {
      entry.count++;
      entry.revenue += (r.tariff?.price ?? 0) + (r.extraCost ?? 0);
    }
  }

  const rows = [...dayMap.entries()].map(([iso, val]) => {
    const d = new Date(`${iso}T12:00:00+06:00`);
    return { date: shortDate(d), weekday: shortWeekday(d), ...val };
  });

  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const totalCount = rows.reduce((s, r) => s + r.count, 0);

  return { rows, totalRevenue, totalCount };
}

/** Форматирование недельного отчёта в Telegram HTML с ASCII-гистограммой */
export function formatWeekReport(data: Awaited<ReturnType<typeof weekReport>>): string {
  let text = `📈 <b>Неделя</b>\n\n`;

  const maxRev = Math.max(...data.rows.map((r) => r.revenue), 1);

  for (const r of data.rows) {
    const barLen = Math.round((r.revenue / maxRev) * 8);
    const bar = "▓".repeat(barLen) + "░".repeat(8 - barLen);
    text += `<code>${r.date} ${r.weekday}</code> ${bar} ${r.count} шт — ${fmtPrice(r.revenue)}\n`;
  }

  text += `\n💰 <b>Итого:</b> ${fmtPrice(data.totalRevenue)} (${data.totalCount} аренд)`;
  return truncateMessage(text);
}

// ——— Revenue by tariff ———

/**
 * Отчёт по выручке в разрезе тарифов.
 * @param days - Количество дней для анализа (по умолчанию 7)
 */
export async function tariffReport(days: number = 7) {
  const since = daysAgo(days);

  const rentals = await prisma.rental.findMany({
    where: {
      createdAt: { gte: since },
      status: { in: [RentalStatus.RETURNED, RentalStatus.RENTED, RentalStatus.WAIT_RETURN] },
    },
    include: { tariff: true },
  });

  const map = new Map<number, { name: string; price: number; count: number; revenue: number }>();
  for (const r of rentals) {
    if (!r.tariff) continue;
    const entry = map.get(r.tariff.id) ?? { name: r.tariff.name, price: r.tariff.price, count: 0, revenue: 0 };
    entry.count++;
    entry.revenue += r.tariff.price + (r.extraCost ?? 0);
    map.set(r.tariff.id, entry);
  }

  const rows = [...map.values()].sort((a, b) => b.revenue - a.revenue);
  const totalRevenue = rows.reduce((s, r) => s + r.revenue, 0);
  const totalCount = rows.reduce((s, r) => s + r.count, 0);

  return { rows, totalRevenue, totalCount };
}

/** Форматирование отчёта по тарифам в Telegram HTML с процентами */
export function formatTariffReport(data: Awaited<ReturnType<typeof tariffReport>>): string {
  let text = `💵 <b>Выручка по тарифам (7 дней)</b>\n\n`;
  if (data.rows.length === 0) {
    text += "Нет данных за период.\n";
    return text;
  }

  for (const t of data.rows) {
    const pct = data.totalRevenue > 0 ? Math.round((t.revenue / data.totalRevenue) * 100) : 0;
    text += `▸ <b>${t.name}</b> (${fmtPrice(t.price)})\n`;
    text += `   ${t.count} аренд → ${fmtPrice(t.revenue)} (${pct}%)\n\n`;
  }

  text += `💰 <b>Итого:</b> ${fmtPrice(data.totalRevenue)} (${data.totalCount} аренд)`;
  return truncateMessage(text);
}
