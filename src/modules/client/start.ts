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

export const startHandlers = new Composer<BotContext>();

/** /start — приветствие или переход к аренде по deep link */
startHandlers.command("start", async (ctx) => {
  const payload = (ctx.match as string)?.trim();

  // Deep link: /start SUP-05 → начинаем аренду доски
  if (payload && /^SUP-\d{2}$/i.test(payload)) {
    return handleRentalByQR(ctx, payload.toUpperCase());
  }

  const role = ctx.dbUser?.role ?? "CLIENT";
  const name = ctx.dbUser?.name ?? "друг";

  const sent = await ctx.reply(
    `👋 Привет, <b>${name}</b>!\n\nДобро пожаловать в SUP-аренду.`,
    { parse_mode: "HTML", reply_markup: mainMenuKeyboard(role) }
  );
  ctx.session.lastBotMsgIds = [sent.message_id];
});

/** /menu — показ главного меню */
startHandlers.command("menu", async (ctx) => {
  const role = ctx.dbUser?.role ?? "CLIENT";
  const sent = await ctx.reply("📋 <b>Главное меню</b>", {
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
    "4. Выберите тариф и оплатите\n\n" +
    "Или введите код вручную (например, <code>SUP-05</code>).",
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🔤 Ввести код доски", "client:enter_code")
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
  await ctx.answerCallbackQuery();
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
  await ctx.editMessageText("📋 <b>Главное меню</b>", {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(role),
  });
});

/**
 * Очистка чата — удаляет все отслеживаемые сообщения бота,
 * а также пытается удалить близлежащие неотслеживаемые сообщения.
 */
startHandlers.callbackQuery("clear:chat", async (ctx) => {
  await ctx.answerCallbackQuery();
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
    for (let id = sourceId - 1; id > sourceId - 200 && id > 0; id--) {
      if (!ids.includes(id)) untrackedIds.push(id);
    }
    for (let i = 0; i < untrackedIds.length; i += 100) {
      const chunk = untrackedIds.slice(i, i + 100);
      try { await ctx.api.deleteMessages(chatId, chunk); } catch { }
    }
  }

  const role = ctx.dbUser?.role ?? "CLIENT";
  ctx.session.lastBotMsgIds = sourceId ? [sourceId] : [];
  await ctx.editMessageText("📋 <b>Главное меню</b>\n\n✅ Чат очищен.", {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(role),
  });
});
