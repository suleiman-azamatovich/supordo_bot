/**
 * Общие обработчики действий с оплатой (approve / reject).
 *
 * Доступны как администраторам, так и кассирам.
 * Защищены guardRole(ADMIN, CASHIER) — регистрируются в index.ts
 * ДО модулей admin и cashier.
 *
 * Обрабатывает:
 *  - pay:approve:<id> — подтверждение оплаты
 *  - pay:reject:<id> — отклонение оплаты
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import { fmtPrice, fmtDuration, fmtDate, escapeHtml } from "../../ui/helpers";
import * as paymentService from "../../services/payment";
import * as rentalService from "../../services/rental";
import { notify } from "../../services/notify";

export const paymentActionsHandlers = new Composer<BotContext>();

/** Кнопка навигации обратно к проверке оплат */
function backToPaymentsKb(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Проверка оплат", "cashier:payments")
    .text("⬅️ Меню", "back:menu");
}

/**
 * Подтверждение оплаты.
 *
 * Для RENTAL — запускает аренду и уведомляет клиента о грейс-периоде.
 * Для OVERDUE — закрывает просрочку и уведомляет клиента.
 */
paymentActionsHandlers.callbackQuery(/^pay:approve:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
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
          `Просрочка закрыта, аренда продолжается. Приятного катания! 🌊`
        );
      } else {
        await notify(
          ctx.api,
          clientUser.tgId,
          `✅ Доплата за просрочку <b>${fmtPrice(proof.amount)}</b> подтверждена. Спасибо! 🌊`
        );
      }
    } else if (proof.kind === "EXTENSION") {
      const rental = await prisma.rental.findUnique({
        where: { id: proof.refId },
        include: { board: true, tariff: true, user: true },
      });
      if (rental && rental.pendingExtraMinutes) {
        const minutes = rental.pendingExtraMinutes;
        const result = await rentalService.extendRental(rental.id, minutes, ctx.dbUser!.id, proof.amount);

        let clientMsg = `✅ <b>Продление подтверждено!</b>\n\n`;
        clientMsg += `🏄 Доска: <b>${rental.board.code}</b>\n`;
        clientMsg += `⏱ Продление: <b>+${fmtDuration(minutes)}</b>\n`;
        clientMsg += `💰 Оплачено: <b>${fmtPrice(proof.amount)}</b>\n`;
        if (result.overdueMinutes > 0) {
          clientMsg += `\n⚠️ У вас была просрочка <b>${fmtDuration(result.overdueMinutes)}</b> — `;
          clientMsg += `она вычтена из продления.\n`;
          if (result.netMinutes > 0) {
            clientMsg += `✅ Вам добавлено: <b>+${fmtDuration(result.netMinutes)}</b>\n`;
          } else {
            clientMsg += `ℹ️ Всё время продления ушло на покрытие просрочки.\n`;
            clientMsg += `Пожалуйста, верните доску или продлите ещё.\n`;
          }
        }
        if (result.netMinutes > 0) {
          clientMsg += `\nПриятного катания! 🌊`;
        }
        await notify(ctx.api, clientUser.tgId, clientMsg);
      }
    } else {
      await notify(ctx.api, clientUser.tgId, `✅ Ваша оплата подтверждена! Бронирование активно.`);
    }

    const statusText = proof.kind === "OVERDUE"
      ? `✅ Оплата за просрочку #${proofId} подтверждена.`
      : proof.kind === "EXTENSION"
        ? `✅ Оплата за продление #${proofId} подтверждена.`
        : `✅ Оплата #${proofId} подтверждена. Аренда запущена.`;

    await ctx.editMessageText(statusText, {
      reply_markup: backToPaymentsKb(),
    });
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ Ошибка: ${e.message}`);
  }
});

/** Причины отклонения оплаты */
const REJECT_REASONS: Record<string, { label: string; clientMsg: string; clientAdvice: string }> = {
  no_payment: {
    label: "💸 Оплата не поступила",
    clientMsg: "Оплата не поступила на счёт.",
    clientAdvice: "Проверьте, что перевод прошёл в вашем банковском приложении, и попробуйте оплатить повторно.",
  },
  wrong_amount: {
    label: "💰 Неверная сумма",
    clientMsg: "Сумма перевода не совпадает с суммой аренды.",
    clientAdvice: "Убедитесь, что переводите точную сумму, указанную в тарифе, и повторите оплату.",
  },
  other: {
    label: "❓ Другая причина",
    clientMsg: "",
    clientAdvice: "",
  },
};

/**
 * Отклонение оплаты — шаг 1: выбор причины.
 *
 * При нажатии «Отклонить» показываем кнопки с причинами отклонения.
 */
paymentActionsHandlers.callbackQuery(/^pay:reject:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const proofId = ctx.match[1];

  const kb = new InlineKeyboard();
  for (const [key, reason] of Object.entries(REJECT_REASONS)) {
    kb.text(reason.label, `pay:reject_reason:${proofId}:${key}`).row();
  }
  kb.text("⬅️ Отмена", "cashier:payments");

  await ctx.editMessageText(
    `❌ <b>Причина отклонения оплаты #${proofId}:</b>`,
    { parse_mode: "HTML", reply_markup: kb }
  );
});

/**
 * Отклонение оплаты — шаг 2: применение с выбранной причиной.
 *
 * Отклоняет оплату, отменяет аренду (для RENTAL) и отправляет
 * клиенту информативное уведомление с причиной и рекомендациями.
 */
paymentActionsHandlers.callbackQuery(/^pay:reject_reason:(\d+):(\w+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const proofId = parseInt(ctx.match[1]);
  const reasonKey = ctx.match[2];
  const reason = REJECT_REASONS[reasonKey] ?? REJECT_REASONS.other;

  // Для «Другая причина» — просим написать текст
  if (reasonKey === "other") {
    ctx.session.rejectProofId = proofId;
    await ctx.editMessageText(
      `✏️ <b>Напишите причину отклонения оплаты #${proofId}:</b>\n\n` +
      `Этот текст будет отправлен клиенту.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("⬅️ Отмена", `pay:reject:${proofId}`) }
    );
    return;
  }

  try {
    const proof = await paymentService.rejectPayment(proofId, ctx.dbUser!.id, reason.clientMsg);
    const clientUser = await prisma.user.findUniqueOrThrow({ where: { id: proof.userId } });

    const rental = await prisma.rental.findUnique({
      where: { id: proof.refId },
      include: { board: true, tariff: true },
    });
    const boardCode = rental?.board?.code ?? "";
    const now = fmtDate(new Date());

    if (proof.kind === "OVERDUE") {
      await notify(
        ctx.api,
        clientUser.tgId,
        `❌ <b>Оплата за просрочку отклонена</b>\n\n` +
        `🏄 Доска: <b>${boardCode}</b>\n` +
        `💰 Сумма: <b>${fmtPrice(proof.amount)}</b>\n` +
        `📅 Дата: ${now}\n\n` +
        `📌 <b>Причина:</b> ${reason.clientMsg}\n` +
        `💡 ${reason.clientAdvice}\n\n` +
        `Пожалуйста, оплатите просрочку через «📋 Мои аренды» или при возврате доски на берегу.`
      );
    } else if (proof.kind === "EXTENSION") {
      await notify(
        ctx.api,
        clientUser.tgId,
        `❌ <b>Оплата за продление отклонена</b>\n\n` +
        (boardCode ? `🏄 Доска: <b>${boardCode}</b>\n` : "") +
        `💰 Сумма: <b>${fmtPrice(proof.amount)}</b>\n` +
        `📅 Дата: ${now}\n\n` +
        `📌 <b>Причина:</b> ${reason.clientMsg}\n` +
        `💡 ${reason.clientAdvice}\n\n` +
        `Вы можете запросить продление повторно через «📋 Мои аренды».`
      );
    } else {
      const tariffInfo = rental?.tariff
        ? `⏱ Тариф: <b>${fmtDuration(rental.tariff.durationMinutes)}</b>\n`
        : "";
      await notify(
        ctx.api,
        clientUser.tgId,
        `❌ <b>Оплата за аренду отклонена</b>\n\n` +
        (boardCode ? `🏄 Доска: <b>${boardCode}</b>\n` : "") +
        tariffInfo +
        `💰 Сумма: <b>${fmtPrice(proof.amount)}</b>\n` +
        `📅 Дата: ${now}\n\n` +
        `📌 <b>Причина:</b> ${reason.clientMsg}\n` +
        `💡 ${reason.clientAdvice}\n\n` +
        `Доска освобождена — вы можете выбрать её заново в «🏄 Арендовать доску» и повторить оплату.`
      );
    }

    await ctx.editMessageText(
      `❌ Оплата #${proofId} отклонена.\n📌 ${reason.clientMsg}`,
      { reply_markup: backToPaymentsKb() }
    );
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ Ошибка: ${e.message}`);
  }
});

/**
 * Отклонение оплаты — шаг 3 (только для «Другая причина»).
 *
 * Админ пишет текстовое сообщение — оно становится причиной отклонения.
 */
paymentActionsHandlers.on("message:text", async (ctx, next) => {
  const proofId = ctx.session.rejectProofId;
  if (!proofId) return next();

  // Сбрасываем состояние сразу
  ctx.session.rejectProofId = undefined;
  const customReason = ctx.message.text.trim();

  if (!customReason) {
    await ctx.reply("⚠️ Причина не может быть пустой. Попробуйте ещё раз.");
    ctx.session.rejectProofId = proofId;
    return;
  }

  try {
    const proof = await paymentService.rejectPayment(proofId, ctx.dbUser!.id, customReason);
    const clientUser = await prisma.user.findUniqueOrThrow({ where: { id: proof.userId } });

    const rental = await prisma.rental.findUnique({
      where: { id: proof.refId },
      include: { board: true, tariff: true },
    });
    const boardCode = rental?.board?.code ?? "";
    const now = fmtDate(new Date());
    const safeReason = escapeHtml(customReason);

    if (proof.kind === "OVERDUE") {
      await notify(
        ctx.api,
        clientUser.tgId,
        `❌ <b>Оплата за просрочку отклонена</b>\n\n` +
        `🏄 Доска: <b>${boardCode}</b>\n` +
        `💰 Сумма: <b>${fmtPrice(proof.amount)}</b>\n` +
        `📅 Дата: ${now}\n\n` +
        `📌 <b>Причина:</b> ${safeReason}\n\n` +
        `Пожалуйста, оплатите просрочку через «📋 Мои аренды» или при возврате доски на берегу.`
      );
    } else if (proof.kind === "EXTENSION") {
      await notify(
        ctx.api,
        clientUser.tgId,
        `❌ <b>Оплата за продление отклонена</b>\n\n` +
        (boardCode ? `🏄 Доска: <b>${boardCode}</b>\n` : "") +
        `💰 Сумма: <b>${fmtPrice(proof.amount)}</b>\n` +
        `📅 Дата: ${now}\n\n` +
        `📌 <b>Причина:</b> ${safeReason}\n\n` +
        `Вы можете запросить продление повторно через «📋 Мои аренды».`
      );
    } else {
      const tariffInfo = rental?.tariff
        ? `⏱ Тариф: <b>${fmtDuration(rental.tariff.durationMinutes)}</b>\n`
        : "";
      await notify(
        ctx.api,
        clientUser.tgId,
        `❌ <b>Оплата за аренду отклонена</b>\n\n` +
        (boardCode ? `🏄 Доска: <b>${boardCode}</b>\n` : "") +
        tariffInfo +
        `💰 Сумма: <b>${fmtPrice(proof.amount)}</b>\n` +
        `📅 Дата: ${now}\n\n` +
        `📌 <b>Причина:</b> ${safeReason}\n\n` +
        `Доска освобождена — вы можете выбрать её заново в «🏄 Арендовать доску» и повторить оплату.`
      );
    }

    await ctx.reply(
      `❌ Оплата #${proofId} отклонена.\n📌 ${safeReason}`,
      { reply_markup: backToPaymentsKb() }
    );
  } catch (e: any) {
    await ctx.reply(`⚠️ Ошибка: ${e.message}`);
  }
});


