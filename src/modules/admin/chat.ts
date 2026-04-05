/**
 * Чат администратора с клиентом.
 *
 * Обрабатывает:
 *  - admin:end_chat — завершение режима чата
 *  - admin:chat_client — повторный вход в чат по оплате
 *  - message:text — пересылка текста клиенту (по оплате или продлению)
 *
 * Режим чата определяется полем ctx.session.chatMode:
 *  - 'payment' — переписка по оплате (chatProofId)
 *  - 'extension' — переписка по продлению (chatRentalId)
 *
 * Текстовый хендлер вызывает next() если:
 *  - Ожидается фото MBank QR (waitingMBankQR) — пропускаем в roles.ts
 *  - Не в режиме чата — пропускаем в walkin.ts
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";

export const chatHandlers = new Composer<BotContext>();

/** Завершение режима чата — очистка всех чат-полей сессии */
chatHandlers.callbackQuery("admin:end_chat", async (ctx) => {
  await ctx.answerCallbackQuery("Чат завершён");
  ctx.session.chatMode = undefined;
  ctx.session.chatWithClientTgId = undefined;
  ctx.session.chatProofId = undefined;
  ctx.session.chatRentalId = undefined;
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

  ctx.session.chatMode = 'payment';
  ctx.session.chatWithClientTgId = Number(proof.user.tgId);
  ctx.session.chatProofId = proofId;
  ctx.session.chatRentalId = undefined;

  await ctx.reply(
    `💬 <b>Чат с клиентом ${proof.user.name}</b> (оплата #${proofId})\n\n` +
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
  if (ctx.session.waitingMBankQR) return next();

  // Чат по оплате
  if (ctx.session.chatMode === 'payment' && ctx.session.chatWithClientTgId && ctx.session.chatProofId) {
    const clientTgId = ctx.session.chatWithClientTgId;
    const proofId = ctx.session.chatProofId;

    try {
      await ctx.api.sendMessage(
        clientTgId,
        `💬 <b>Администратор</b> (оплата #${proofId}):\n\n${ctx.message.text}`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("💬 Ответить", `client:chat_admin:${proofId}`),
        }
      );
      await ctx.reply("✅ Сообщение отправлено клиенту.", {
        reply_markup: new InlineKeyboard()
          .text("✅ Подтвердить оплату", `pay:approve:${proofId}`)
          .text("❌ Отклонить", `pay:reject:${proofId}`)
          .row()
          .text("🛑 Завершить чат", `admin:end_chat`),
      });
    } catch {
      await ctx.reply("⚠️ Не удалось отправить сообщение клиенту.");
    }
    return;
  }

  // Чат по продлению
  if (ctx.session.chatMode === 'extension' && ctx.session.chatWithClientTgId && ctx.session.chatRentalId) {
    const clientTgId = ctx.session.chatWithClientTgId;
    const rentalId = ctx.session.chatRentalId;

    try {
      await ctx.api.sendMessage(
        clientTgId,
        `💬 <b>Администратор</b> (продление #${rentalId}):\n\n${ctx.message.text}`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("💬 Ответить", `client:chat_ext:${rentalId}`),
        }
      );
      await ctx.reply("✅ Сообщение отправлено клиенту.", {
        reply_markup: new InlineKeyboard()
          .text("✅ Подтвердить", `ext:approve:${rentalId}`)
          .text("❌ Отклонить", `ext:reject:${rentalId}`)
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
