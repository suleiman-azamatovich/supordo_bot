/**
 * Чат клиента с администратором.
 *
 * Обрабатывает:
 *  - client:chat_admin — вход в чат по оплате
 *  - client:chat_ext — вход в чат по продлению
 *  - client:end_chat — завершение чата
 *  - message:text — пересылка сообщений админам или ручной ввод кода доски
 *
 * Чат работает в двух режимах:
 *  1. По оплате (chatReplyProofId) — сообщения пересылаются с кнопками оплаты
 *  2. По продлению (chatReplyRentalId) — сообщения пересылаются с кнопками продления
 *
 * Если клиент не в режиме чата и ввёл код доски (waitingBoardCode) —
 * обрабатывается ввод через handleRentalByQR.
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { Role } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { handleRentalByQR } from "./helpers";

export const chatHandlers = new Composer<BotContext>();

/** Вход в чат по вопросу об оплате */
chatHandlers.callbackQuery(/^client:chat_admin:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const proofId = parseInt(ctx.match[1]);

  const proof = await prisma.paymentProof.findUniqueOrThrow({
    where: { id: proofId },
  });

  const admins = await prisma.user.findMany({ where: { role: Role.ADMIN } });
  if (admins.length === 0) {
    return ctx.reply("⚠️ Администратор недоступен.");
  }

  ctx.session.chatWithAdminTgId = -1; // флаг: рассылка всем админам
  ctx.session.chatReplyProofId = proofId;

  await ctx.reply(
    `💬 <b>Чат с администратором</b> (оплата #${proofId})\n\n` +
    `Напишите сообщение — оно будет отправлено администратору.\n` +
    `Для выхода нажмите /menu`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🛑 Завершить чат", "client:end_chat"),
    }
  );
});

/** Вход в чат по вопросу о продлении */
chatHandlers.callbackQuery(/^client:chat_ext:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  const admins = await prisma.user.findMany({ where: { role: Role.ADMIN } });
  if (admins.length === 0) {
    return ctx.reply("⚠️ Администратор недоступен.");
  }

  ctx.session.chatWithAdminTgId = -1;
  ctx.session.chatReplyRentalId = rentalId;
  ctx.session.chatReplyProofId = undefined;

  await ctx.reply(
    `💬 <b>Чат с администратором</b> (продление аренды #${rentalId})\n\n` +
    `Напишите сообщение — оно будет отправлено администратору.\n` +
    `Для выхода нажмите /menu`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🛑 Завершить чат", "client:end_chat"),
    }
  );
});

/** Завершение чата — очистка сессии */
chatHandlers.callbackQuery("client:end_chat", async (ctx) => {
  await ctx.answerCallbackQuery("Чат завершён");
  ctx.session.chatWithAdminTgId = undefined;
  ctx.session.chatReplyProofId = undefined;
  ctx.session.chatReplyRentalId = undefined;
  await ctx.editMessageText("🛑 Чат завершён.", {
    reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
  });
});

/**
 * Обработчик текста от клиента.
 *
 * Приоритет:
 *  1. Если в чате по оплате → пересылка сообщения всем админам
 *  2. Если в чате по продлению → пересылка сообщения всем админам
 *  3. Если ожидается ввод кода доски → проверка формата и старт аренды
 *  4. Иначе — не обрабатываем (не вызываем next(), чтобы не ловить чужие сообщения)
 */
chatHandlers.on("message:text", async (ctx, next) => {
  // 1. Чат по оплате
  if (ctx.session.chatWithAdminTgId && ctx.session.chatReplyProofId) {
    const proofId = ctx.session.chatReplyProofId;
    const userName = ctx.dbUser?.name ?? "Клиент";
    try {
      const admins = await prisma.user.findMany({ where: { role: Role.ADMIN } });
      for (const admin of admins) {
        try {
          await ctx.api.sendMessage(
            Number(admin.tgId),
            `💬 <b>${userName}</b> (оплата #${proofId}):\n\n${ctx.message.text}`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard()
                .text("✅ Подтвердить оплату", `pay:approve:${proofId}`)
                .text("❌ Отклонить", `pay:reject:${proofId}`)
                .row()
                .text("💬 Ответить", `admin:chat_client:${proofId}`),
            }
          );
        } catch { }
      }
      await ctx.reply("✅ Сообщение отправлено администратору.", {
        reply_markup: new InlineKeyboard()
          .text("🛑 Завершить чат", "client:end_chat"),
      });
    } catch {
      await ctx.reply("⚠️ Не удалось отправить сообщение.");
    }
    return;
  }

  // 2. Чат по продлению
  if (ctx.session.chatWithAdminTgId && ctx.session.chatReplyRentalId) {
    const rentalId = ctx.session.chatReplyRentalId;
    const userName = ctx.dbUser?.name ?? "Клиент";
    try {
      const admins = await prisma.user.findMany({ where: { role: Role.ADMIN } });
      await Promise.all(admins.map((admin) =>
        ctx.api.sendMessage(
          Number(admin.tgId),
          `💬 <b>${userName}</b> (продление #${rentalId}):\n\n${ctx.message.text}`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("✅ Подтвердить", `ext:approve:${rentalId}`)
              .text("❌ Отклонить", `ext:reject:${rentalId}`)
              .row()
              .text("💬 Ответить", `ext:chat:${rentalId}`),
          }
        ).catch((e) => console.error('[chat] Ошибка пересылки сообщения админу:', e))
      ));
      await ctx.reply("✅ Сообщение отправлено администратору.", {
        reply_markup: new InlineKeyboard()
          .text("🛑 Завершить чат", "client:end_chat"),
      });
    } catch {
      await ctx.reply("⚠️ Не удалось отправить сообщение.");
    }
    return;
  }

  // 3. Ручной ввод кода доски
  if (!ctx.session.waitingBoardCode) return next();

  const code = ctx.message.text.trim().toUpperCase();
  ctx.session.waitingBoardCode = false;

  if (!/^SUP-\d{2}$/.test(code)) {
    await ctx.reply(
      "⚠️ Неверный формат. Введите код вида <code>SUP-05</code> или нажмите /menu",
      { parse_mode: "HTML" }
    );
    return;
  }

  return handleRentalByQR(ctx, code);
});
