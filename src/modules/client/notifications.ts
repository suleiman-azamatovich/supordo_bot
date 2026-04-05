/**
 * Уведомления и помощь для клиента.
 *
 * Обрабатывает:
 *  - client:notifications — список уведомлений за 24 часа с иконками
 *  - client:help — справочная информация
 *  - noop — заглушка для кнопок пагинации (индикатор страницы)
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { getNotifications } from "../../services/notify";
import { config } from "../../bot/config";
import { addPaginationRow, paginate } from "../../ui/helpers";

export const notificationsHandlers = new Composer<BotContext>();

/** Определяет иконку по содержимому уведомления */
function notifyIcon(text: string): string {
  if (text.includes("подтверждена") || text.includes("Приятного катания")) return "✅";
  if (text.includes("отклонена") || text.includes("отменена")) return "❌";
  if (text.includes("Просрочка") || text.includes("просрочк")) return "⚠️";
  if (text.includes("истекло") || text.includes("истекает") || text.includes("Время")) return "⏰";
  if (text.includes("Напоминание") || text.includes("верните")) return "📩";
  if (text.includes("Новая оплата") || text.includes("оплат")) return "💳";
  if (text.includes("продлен")) return "🔄";
  if (text.includes("возврат") || text.includes("Возврат")) return "🔙";
  return "🔔";
}

/** Список уведомлений клиента за последние 24 часа с пагинацией */
notificationsHandlers.callbackQuery(/^client:notifications(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");
  const userId = ctx.dbUser!.id;
  const allItems = await getNotifications(userId);

  const paged = paginate(allItems, page, 8);
  // Внутри страницы новые внизу (удобно читать)
  const items = [...paged.items].reverse();

  let text = `🔔 <b>Уведомления</b> (${allItems.length})\n`;
  if (allItems.length === 0) {
    text += "\nНет уведомлений за последние 24 часа.";
  } else {
    text += "\n";
    for (const n of items) {
      const time = n.createdAt.toLocaleTimeString("ru-RU", {
        timeZone: config.TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
      });
      const date = n.createdAt.toLocaleDateString("ru-RU", {
        timeZone: config.TIMEZONE,
        day: "2-digit",
        month: "2-digit",
      });
      const icon = notifyIcon(n.text);
      // Обрезаем длинный текст для компактности
      const shortText = n.text.length > 120 ? n.text.slice(0, 117) + "..." : n.text;
      text += `<code>${date} ${time}</code>\n${icon} ${shortText}\n\n`;
    }
  }

  const kb = new InlineKeyboard();
  addPaginationRow(kb, paged.page, paged.totalPages, "client:notifications:");
  kb.row().text("🔄 Обновить", "client:notifications").text("⬅️ Меню", "back:menu");
  kb.row().text("🧹 Убрать лишнее", "clear:chat");

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: kb,
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
