/**
 * Управление оплатами (администратор).
 *
 * Обрабатывает:
 *  - admin:payments — список ожидающих оплат с пагинацией
 *
 * Действия с оплатой (pay:approve, pay:reject, pay:request_info)
 * вынесены в shared/payment-actions.ts — доступны админу и кассиру.
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { fmtPrice } from "../../ui/helpers";
import * as paymentService from "../../services/payment";

export const paymentsHandlers = new Composer<BotContext>();

/** Список ожидающих оплат с пагинацией и кнопками действий */
paymentsHandlers.callbackQuery(/^admin:payments(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");

  const { items, total, totalPages } = await paymentService.getPendingPayments(page, 5);

  let text = `💳 <b>Оплаты на проверку</b> (${total})\n\n`;
  if (items.length === 0) {
    text += "Нет ожидающих оплат.";
  }

  const kb = new InlineKeyboard();
  for (const p of items) {
    const kindLabel = p.kind === "OVERDUE" ? "⚠️ Просрочка" : p.kind === "RENTAL" ? "🏄 Аренда" : "📋 Бронь";
    text += `#${p.id} — ${kindLabel} #${p.refId} — ${fmtPrice(p.amount)} — ${p.user.name}\n`;
    if (p.kind === "OVERDUE") {
      kb.text(`✅ Оплачено #${p.id}`, `pay:approve:${p.id}`)
        .text(`🔄 Списать #${p.id}`, `pay:reject:${p.id}`)
        .row();
    } else {
      kb.text(`✅ #${p.id}`, `pay:approve:${p.id}`)
        .text(`❌ #${p.id}`, `pay:reject:${p.id}`)
        .row();
    }
  }
  const { addPaginationRow } = await import("../../ui/helpers");
  addPaginationRow(kb, page, totalPages, "admin:payments:");
  kb.row().text("⬅️ Меню", "back:menu").text("🧹 Убрать лишнее", "clear:chat");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});
