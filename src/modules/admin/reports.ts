/**
 * Отчёт за день (администратор).
 *
 * Обрабатывает:
 *  - admin:reports — полная сводка за сегодня (выручка, аренды, оплаты, доски, тарифы)
 *
 * Вся информация формируется сервисом reports.ts.
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import * as reports from "../../services/reports";

export const reportsHandlers = new Composer<BotContext>();

/** Полная сводка за день — единственный экран отчёта */
reportsHandlers.callbackQuery("admin:reports", async (ctx) => {
  await ctx.answerCallbackQuery();

  const data = await reports.dailyReport();
  const text = reports.formatDailyReport(data);

  const kb = new InlineKeyboard()
    .text("🔄 Обновить", "admin:reports")
    .text("⬅️ Меню", "back:menu")
    .row()
    .text("🧹 Убрать лишнее", "clear:chat");

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: kb,
  });
});
