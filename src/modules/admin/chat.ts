/**
 * Чат администратора с клиентом.
 *
 * Обрабатывает:
 *  - admin:end_chat — завершение режима чата
 *  - admin:chat_client — повторный вход в чат по оплате
 *  - message:text — пересылка текста клиенту (по оплате или продлению)
 *
 * Режим чата определяется полем ctx.session.adminChat (discriminated union):
 *  - mode: 'payment' — переписка по оплате
 *  - mode: 'extension' — переписка по продлению
 *
 * Текстовый хендлер вызывает next() если:
 *  - Ожидается фото MBank QR (inputMode === 'mbank_qr') — пропускаем в roles.ts
 *  - Не в режиме чата — пропускаем в walkin.ts
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import { escapeHtml } from "../../ui/helpers";

export const chatHandlers = new Composer<BotContext>();

/** Завершение режима чата — очистка всех чат-полей сессии */
chatHandlers.callbackQuery("admin:end_chat", async (ctx) => {
  await ctx.answerCallbackQuery("Чат завершён");
  ctx.session.adminChat = undefined;
  await ctx.editMessageText("🛑 Режим переписки завершён.", {
    reply_markup: new InlineKeyboard()
      .text("✅ Проверка оплат", "cashier:payments")
      .text("⬅️ Меню", "back:menu"),
  });
});

/**
 * Повторный вход в чат с клиентом по оплате.
 *
 * Используется когда клиент отправил сообщение и админ нажимает
 * «Ответить» в уведомлении.
 */
chatHandlers.callbackQuery(/^admin:chat_client:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const proofId = parseInt(ctx.match[1]);

  const proof = await prisma.paymentProof.findUniqueOrThrow({
    where: { id: proofId },
    include: { user: true },
  });

  ctx.session.adminChat = { mode: 'payment', clientTgId: Number(proof.user.tgId), proofId };

  await ctx.reply(
    `💬 <b>Чат с клиентом ${escapeHtml(proof.user.name)}</b> (оплата #${proofId})\n\n` +
    `Напишите сообщение — оно будет отправлено клиенту.`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("✅ Подтвердить оплату", `pay:approve:${proofId}`)
        .text("❌ Отклонить", `pay:reject:${proofId}`)
        .row()
        .text("🛑 Завершить чат", `admin:end_chat`),
    }
  );
});

/**
 * Пересылка текста от админа клиенту.
 *
 * Определяет режим чата и отправляет сообщение с соответствующими кнопками.
 * Вызывает next() при отсутствии активного чата.
 */
chatHandlers.on("message:text", async (ctx, next) => {
  // Пропускаем если ожидается фото MBank QR
  if (ctx.session.inputMode === 'mbank_qr') return next();

  const chat = ctx.session.adminChat;
  if (!chat) return next();

  // Чат по оплате
  if (chat.mode === 'payment') {
    try {
      await ctx.api.sendMessage(
        chat.clientTgId,
        `💬 <b>Администратор</b> (оплата #${chat.proofId}):\n\n${escapeHtml(ctx.message.text)}`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("💬 Ответить", `client:chat_admin:${chat.proofId}`),
        }
      );
      await ctx.reply("✅ Сообщение отправлено клиенту.", {
        reply_markup: new InlineKeyboard()
          .text("✅ Подтвердить оплату", `pay:approve:${chat.proofId}`)
          .text("❌ Отклонить", `pay:reject:${chat.proofId}`)
          .row()
          .text("🛑 Завершить чат", `admin:end_chat`),
      });
    } catch {
      await ctx.reply("⚠️ Не удалось отправить сообщение клиенту.");
    }
    return;
  }

  // Чат по продлению
  if (chat.mode === 'extension') {
    try {
      await ctx.api.sendMessage(
        chat.clientTgId,
        `💬 <b>Администратор</b> (продление #${chat.rentalId}):\n\n${escapeHtml(ctx.message.text)}`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("💬 Ответить", `client:chat_ext:${chat.rentalId}`),
        }
      );
      await ctx.reply("✅ Сообщение отправлено клиенту.", {
        reply_markup: new InlineKeyboard()
          .text("✅ Подтвердить", `ext:approve:${chat.rentalId}`)
          .text("❌ Отклонить", `ext:reject:${chat.rentalId}`)
          .row()
          .text("🛑 Завершить чат", `admin:end_chat`),
      });
    } catch {
      await ctx.reply("⚠️ Не удалось отправить сообщение клиенту.");
    }
    return;
  }

  return next();
});
