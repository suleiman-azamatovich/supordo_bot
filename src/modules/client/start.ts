/**
 * Старт и навигация клиента.
 *
 * Обрабатывает:
 *  - /start — приветствие + deep link для QR-кодов (?start=SUP-XX)
 *  - /menu — показ главного меню
 *  - back:menu — возврат в меню (inline-кнопка)
 *  - clear:chat — очистка чата бота
 *  - client:qr_hint — подсказка как сканировать QR
 *  - client:enter_code — ручной ввод кода доски
 *
 * Эти хендлеры доступны ВСЕМ пользователям (и CLIENT, и ADMIN),
 * поскольку меню рисуется с учётом роли через mainMenuKeyboard().
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { mainMenuKeyboard } from "../../ui/keyboards";
import { handleRentalByQR } from "./helpers";
import { isTestMode } from "../../services/rental";

/** Строка режима работы для админа/кассира */
async function modeLabel(role: string): Promise<string> {
  if (role !== "ADMIN" && role !== "CASHIER") return "";
  const test = await isTestMode();
  return `\n⚙️ Режим: <b>${test ? "🧪 Тестовый" : "🟢 Рабочий"}</b>`;
}

export const startHandlers = new Composer<BotContext>();

/** /start — приветствие или переход к аренде по deep link */
startHandlers.command("start", async (ctx) => {
  const payload = (ctx.match as string)?.trim();

  // Deep link: /start board_SUP-05 или /start SUP-05 → начинаем аренду доски
  const boardCode = payload?.replace(/^board_/i, "");
  if (boardCode && /^SUP-\d{2}$/i.test(boardCode)) {
    return handleRentalByQR(ctx, boardCode.toUpperCase());
  }

  const role = ctx.dbUser?.role ?? "CLIENT";
  const name = ctx.dbUser?.name ?? "друг";
  const mode = await modeLabel(role);

  const sent = await ctx.reply(
    `👋 Привет, <b>${name}</b>!\n\nДобро пожаловать в SUP-аренду.${mode}`,
    { parse_mode: "HTML", reply_markup: mainMenuKeyboard(role) }
  );
  ctx.session.lastBotMsgIds = [sent.message_id];
});

/** /menu — показ главного меню */
startHandlers.command("menu", async (ctx) => {
  const role = ctx.dbUser?.role ?? "CLIENT";
  const mode = await modeLabel(role);
  const sent = await ctx.reply(`📋 <b>Главное меню</b>${mode}`, {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(role),
  });
  ctx.session.lastBotMsgIds = [sent.message_id];
});

/** Подсказка «Как сканировать QR» */
startHandlers.callbackQuery("client:qr_hint", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "📷 <b>Как арендовать по QR?</b>\n\n" +
    "1. Откройте камеру телефона\n" +
    "2. Наведите на QR-код на доске\n" +
    "3. Перейдите по ссылке — бот откроется автоматически\n" +
    "4. Выберите тариф и оплатите",
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🏄 Арендовать доску", "client:boards")
        .row()
        .text("⬅️ Меню", "back:menu"),
    }
  );
});

/** Ввод кода доски вручную — активирует ожидание текстового сообщения */
startHandlers.callbackQuery("client:enter_code", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.waitingBoardCode = true;
  await ctx.editMessageText(
    "🔤 Введите код доски (например, <code>SUP-05</code>):",
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
    }
  );
});

/** Кнопка «Меню» — возврат в главное меню (используется всеми ролями) */
startHandlers.callbackQuery("back:menu", async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => { });
  const role = ctx.dbUser?.role ?? "CLIENT";
  ctx.session.waitingBoardCode = false;
  ctx.session.walkin = undefined;
  ctx.session.chatMode = undefined;
  ctx.session.chatWithAdminTgId = undefined;
  ctx.session.chatReplyProofId = undefined;
  ctx.session.chatReplyRentalId = undefined;
  ctx.session.chatWithClientTgId = undefined;
  ctx.session.chatProofId = undefined;
  ctx.session.chatRentalId = undefined;
  ctx.session.waitingMBankQR = false;
  const mode = await modeLabel(role);
  try {
    await ctx.editMessageText(`📋 <b>Главное меню</b>${mode}`, {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboard(role),
    });
  } catch {
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    await ctx.reply(`📋 <b>Главное меню</b>${mode}`, {
      parse_mode: "HTML",
      reply_markup: mainMenuKeyboard(role),
    });
  }
});

/**
 * Очистка чата — удаляет все отслеживаемые сообщения бота,
 * а также пытается удалить близлежащие неотслеживаемые сообщения.
 */
startHandlers.callbackQuery("clear:chat", async (ctx) => {
  const chatId = ctx.chat!.id;
  const ids = ctx.session.lastBotMsgIds ?? [];
  const sourceId = ctx.callbackQuery?.message?.message_id;

  // Удаляем отслеживаемые сообщения (кроме текущего)
  const toDelete = ids.filter((id) => id !== sourceId);
  for (let i = 0; i < toDelete.length; i += 100) {
    const chunk = toDelete.slice(i, i + 100);
    try { await ctx.api.deleteMessages(chatId, chunk); } catch { }
  }

  // Пытаемся удалить близлежащие неотслеживаемые сообщения (уведомления и т.п.)
  if (sourceId) {
    const untrackedIds: number[] = [];
    // Назад от текущего сообщения
    for (let id = sourceId - 1; id > sourceId - 200 && id > 0; id--) {
      if (!ids.includes(id)) untrackedIds.push(id);
    }
    // Вперёд от текущего сообщения (уведомления, пришедшие позже)
    for (let id = sourceId + 1; id <= sourceId + 50; id++) {
      untrackedIds.push(id);
    }
    for (let i = 0; i < untrackedIds.length; i += 100) {
      const chunk = untrackedIds.slice(i, i + 100);
      try { await ctx.api.deleteMessages(chatId, chunk); } catch { }
    }
  }

  ctx.session.lastBotMsgIds = sourceId ? [sourceId] : [];
  await ctx.answerCallbackQuery({ text: "🧹 Лишнее убрано!", show_alert: false });
});
