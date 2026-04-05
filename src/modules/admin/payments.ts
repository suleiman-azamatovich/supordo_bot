/**
 * Управление оплатами (администратор).
 *
 * Обрабатывает:
 *  - admin:payments — список ожидающих оплат с пагинацией
 *  - pay:approve — подтверждение оплаты (запуск аренды / закрытие просрочки)
 *  - pay:reject — отклонение оплаты
 *  - pay:request_info — запрос доп. информации у клиента (вход в чат)
 *
 * При подтверждении оплаты:
 *  - RENTAL: аренда запускается, клиенту приходит уведомление с грейс-периодом
 *  - OVERDUE: просрочка закрывается, клиенту приходит подтверждение
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import { fmtPrice, fmtDuration } from "../../ui/helpers";
import * as paymentService from "../../services/payment";
import * as rentalService from "../../services/rental";
import { notify } from "../../services/notify";

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
  kb.row().text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/**
 * Подтверждение оплаты.
 *
 * Для RENTAL — запускает аренду и уведомляет клиента о грейс-периоде.
 * Для OVERDUE — закрывает просрочку и уведомляет клиента.
 */
paymentsHandlers.callbackQuery(/^pay:approve:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.chatMode = undefined;
  ctx.session.chatWithClientTgId = undefined;
  ctx.session.chatProofId = undefined;
  const proofId = parseInt(ctx.match[1]);

  try {
    const proof = await paymentService.approvePayment(proofId, ctx.dbUser!.id);

    const clientUser = await prisma.user.findUniqueOrThrow({ where: { id: proof.userId } });

    if (proof.kind === "RENTAL") {
      const rental = await prisma.rental.findUnique({
        where: { id: proof.refId },
        include: { board: true, spot: true, user: true, tariff: true },
      });
      if (rental) {
        const graceMs = await rentalService.getStartGraceMs();
        const graceLabel = graceMs >= 60_000
          ? `${Math.round(graceMs / 60_000)} минут`
          : `${Math.round(graceMs / 1_000)} секунд`;
        await notify(
          ctx.api,
          clientUser.tgId,
          `✅ Оплата подтверждена!\n\n` +
          `🏄 Доска: <b>${rental.board.code}</b>\n` +
          `⏱ Тариф: <b>${rental.tariff ? fmtDuration(rental.tariff.durationMinutes) : ""}</b>\n` +
          `🕐 Отсчёт начнётся через <b>${graceLabel}</b> — у вас есть время спуститься на воду.\n\n` +
          `Приятного катания! 🌊\n` +
          `Не забывайте о правилах безопасности!`
        );
      }
    } else if (proof.kind === "OVERDUE") {
      const rental = await prisma.rental.findUnique({
        where: { id: proof.refId },
        include: { board: true, tariff: true },
      });
      if (rental && rental.status === "RENTED") {
        await notify(
          ctx.api,
          clientUser.tgId,
          `✅ Оплата за просрочку подтверждена!\n\n` +
          `🏄 Доска: <b>${rental.board.code}</b>\n` +
          `💰 Оплачено: <b>${fmtPrice(proof.amount)}</b>\n\n` +
          `Просрочка закрыта, аренда продолжается. Приятного катания! 🌊`,
          { deleteAfterMs: 0 }
        );
      } else {
        await notify(
          ctx.api,
          clientUser.tgId,
          `✅ Доплата за просрочку <b>${fmtPrice(proof.amount)}</b> подтверждена. Спасибо! 🌊`,
          { deleteAfterMs: 0 }
        );
      }
    } else {
      await notify(ctx.api, clientUser.tgId, `✅ Ваша оплата подтверждена! Бронирование активно.`);
    }

    const statusText = proof.kind === "OVERDUE"
      ? `✅ Оплата за просрочку #${proofId} подтверждена.`
      : `✅ Оплата #${proofId} подтверждена. Аренда запущена.`;

    await ctx.editMessageText(statusText, {
      reply_markup: new InlineKeyboard()
        .text("💳 К оплатам", "admin:payments")
        .text("⬅️ Меню", "back:menu"),
    });
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ Ошибка: ${e.message}`);
  }
});

/** Отклонение оплаты — уведомляет клиента */
paymentsHandlers.callbackQuery(/^pay:reject:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.chatMode = undefined;
  ctx.session.chatWithClientTgId = undefined;
  ctx.session.chatProofId = undefined;
  const proofId = parseInt(ctx.match[1]);

  try {
    const proof = await paymentService.rejectPayment(proofId, ctx.dbUser!.id);

    const clientUser = await prisma.user.findUniqueOrThrow({ where: { id: proof.userId } });

    if (proof.kind === "OVERDUE") {
      await notify(
        ctx.api,
        clientUser.tgId,
        `❌ Оплата за просрочку #${proof.id} отклонена.\n` +
        `Попробуйте оплатить повторно через «Мои аренды» или свяжитесь с администрацией.`,
        { deleteAfterMs: 0 }
      );
    } else {
      await notify(ctx.api, clientUser.tgId, `❌ Ваша оплата #${proof.id} отклонена.\nПопробуйте оплатить повторно или свяжитесь с администрацией.`);
    }

    await ctx.editMessageText(`❌ Оплата #${proofId} отклонена.`, {
      reply_markup: new InlineKeyboard()
        .text("💳 К оплатам", "admin:payments")
        .text("⬅️ Меню", "back:menu"),
    });
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ Ошибка: ${e.message}`);
  }
});

/**
 * Запрос доп. информации — вход в режим чата с клиентом.
 *
 * Устанавливает сессию chatMode='payment' и отправляет клиенту
 * уведомление с кнопкой «Ответить».
 */
paymentsHandlers.callbackQuery(/^pay:request_info:(\d+)$/, async (ctx) => {
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

  try {
    await ctx.api.sendMessage(
      Number(proof.user.tgId),
      `💬 <b>Сообщение от администратора</b> (оплата #${proof.id})\n\n` +
      `Администратор запрашивает дополнительную информацию.\n` +
      `Нажмите кнопку ниже, чтобы ответить:`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("💬 Ответить администратору", `client:chat_admin:${proof.id}`),
      }
    );
  } catch { }

  await ctx.editMessageText(
    `💬 <b>Чат с клиентом</b> (оплата #${proofId})\n\n` +
    `Клиент: ${proof.user.name}\n` +
    `Вы в режиме переписки. Напишите сообщение — оно будет отправлено клиенту.\n\n` +
    `Для завершения чата нажмите кнопку ниже.`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("✅ Подтвердить оплату", `pay:approve:${proofId}`)
        .text("❌ Отклонить", `pay:reject:${proofId}`)
        .row()
        .text("🛑 Завершить чат", `admin:end_chat`)
        .row()
        .text("💳 К оплатам", "admin:payments")
        .text("⬅️ Меню", "back:menu"),
    }
  );
});
