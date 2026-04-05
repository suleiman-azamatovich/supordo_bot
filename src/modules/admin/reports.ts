/**
 * Отчёты и тарифы (администратор).
 *
 * Обрабатывает:
 *  - admin:reports — сводка за сегодня + меню отчётов
 *  - report:week — отчёт за неделю по дням
 *  - report:tariffs — статистика по тарифам
 *  - admin:tariffs — список тарифов с настройками
 *  - seller:today — история аренд за сегодня на точке
 *
 * Отчёты формируются сервисом reports.ts и показывают
 * выручку, количество аренд, популярные тарифы и т.д.
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import {
  fmtPrice, fmtDuration, fmtDate,
  escapeHtml, paginate, addPaginationRow,
} from "../../ui/helpers";
import * as reports from "../../services/reports";
import { startOfDayBishkek } from "../../services/reports";

export const reportsHandlers = new Composer<BotContext>();

/** Сводка за сегодня + навигация по отчётам */
reportsHandlers.callbackQuery("admin:reports", async (ctx) => {
  await ctx.answerCallbackQuery();

  const today = await reports.todayReport();
  const todayText = reports.formatTodayReport(today);

  const kb = new InlineKeyboard()
    .text("📈 Неделя по дням", "report:week")
    .row()
    .text("💵 По тарифам", "report:tariffs")
    .row()
    .text("🔄 Обновить", "admin:reports")
    .text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(todayText, {
    parse_mode: "HTML",
    reply_markup: kb,
  });
});

/** Отчёт за неделю — разбивка по дням */
reportsHandlers.callbackQuery("report:week", async (ctx) => {
  await ctx.answerCallbackQuery();
  const data = await reports.weekReport();
  const text = reports.formatWeekReport(data);

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text("📊 Отчёты", "admin:reports")
      .text("⬅️ Меню", "back:menu"),
  });
});

/** Статистика по тарифам — какой тариф популярнее */
reportsHandlers.callbackQuery("report:tariffs", async (ctx) => {
  await ctx.answerCallbackQuery();
  const data = await reports.tariffReport();
  const text = reports.formatTariffReport(data);

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text("📊 Отчёты", "admin:reports")
      .text("⬅️ Меню", "back:menu"),
  });
});

/** Список тарифов с настройками (длительность, цена, точка) */
reportsHandlers.callbackQuery(/^admin:tariffs(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");

  const tariffs = await prisma.tariff.findMany({
    include: { spot: true },
    orderBy: { id: "asc" },
  });
  const paged = paginate(tariffs, page);

  let text = "💰 <b>Тарифы</b>\n\n";
  for (const t of paged.items) {
    text += `#${t.id} ${t.name} (${fmtDuration(t.durationMinutes)}) — ${fmtPrice(t.price)} — ${t.spot.name}\n`;
  }
  if (paged.items.length === 0) text += "Нет тарифов.";

  const kb = new InlineKeyboard();
  addPaginationRow(kb, paged.page, paged.totalPages, "admin:tariffs:");
  kb.row().text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/**
 * История аренд за сегодня на точке админа (seller:today).
 *
 * Показывает все аренды за сегодня с иконками статуса,
 * именами клиентов и источником (клиент / админ).
 */
reportsHandlers.callbackQuery(/^seller:today(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");
  const spotId = ctx.dbUser!.spotId;
  if (!spotId) {
    return ctx.editMessageText("⚠️ Вы не привязаны к точке.");
  }

  const todayStart = startOfDayBishkek();

  const rentals = await prisma.rental.findMany({
    where: { spotId, createdAt: { gte: todayStart } },
    include: { board: true, user: true, tariff: true },
    orderBy: { createdAt: "desc" },
  });

  const paged = paginate(rentals, page);

  let text = "📊 <b>История за сегодня</b>\n\n";
  if (paged.items.length === 0) {
    text += "Нет записей за сегодня.";
  } else {
    for (const r of paged.items) {
      const client = escapeHtml(r.clientName ?? r.user.name);
      const source = r.sellerUserId ? "👤 админ" : "📱 клиент";
      const statusMap: Record<string, string> = {
        RENTED: "🔴", WAIT_RETURN: "⏰", RETURNED: "✅", CANCELLED: "❌", CREATED: "⏳", WAIT_PAYMENT: "💳", WAIT_ADMIN: "🔍",
      };
      const icon = statusMap[r.status] ?? "❓";
      const price = r.tariff ? fmtPrice(r.tariff.price) : "";
      text += `${icon} <b>${r.board.code}</b> → ${client} · ${price} · ${source}\n`;
    }
  }

  const kb = new InlineKeyboard();
  addPaginationRow(kb, paged.page, paged.totalPages, "seller:today:");
  kb.row().text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});
