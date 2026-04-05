/**
 * Уведомления и помощь для клиента.
 *
 * Обрабатывает:
 *  - client:notifications — список уведомлений за 24 часа
 *  - client:help — справочная информация
 *  - noop — заглушка для кнопок пагинации (индикатор страницы)
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { getNotifications } from "../../services/notify";
import { config } from "../../bot/config";

export const notificationsHandlers = new Composer<BotContext>();

/** Список уведомлений клиента за последние 24 часа */
notificationsHandlers.callbackQuery("client:notifications", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.dbUser!.id;
  const items = await getNotifications(userId);

  let text = "🔔 <b>Уведомления</b>\n\n";
  if (items.length === 0) {
    text += "Нет уведомлений за последние 24 часа.";
  } else {
    for (const n of items) {
      const time = n.createdAt.toLocaleTimeString("ru-RU", {
        timeZone: config.TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
      });
      text += `<code>${time}</code>  ${n.text}\n\n`;
    }
  }

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text("🔄 Обновить", "client:notifications")
      .text("⬅️ Меню", "back:menu"),
  });
});

/** Справочная страница — как арендовать, оплатить, связаться */
notificationsHandlers.callbackQuery("client:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "❓ <b>Помощь</b>\n\n" +
    "• <b>Доски:</b> посмотрите статус всех досок и арендуйте свободную.\n" +
    "• <b>Аренда по QR:</b> отсканируйте QR-код на доске камерой телефона.\n" +
    "• <b>Оплата:</b> переведите сумму через MBank по QR-коду.\n" +
    "• Администратор подтвердит оплату, и продавец выдаст вам доску.\n\n" +
    "По вопросам свяжитесь с администрацией.",
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu") }
  );
});

/** Заглушка для кнопок-индикаторов пагинации (нажатие ни к чему не приводит) */
notificationsHandlers.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());
