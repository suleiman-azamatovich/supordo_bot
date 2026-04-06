/**
 * Принятие досок (администратор).
 *
 * Хендлеры:
 *  - return:confirm — экран подтверждения завершения аренды
 *  - return:complete — выполнение завершения аренды
 *  - return:invoice — завершение + счёт за просрочку
 *
 * При завершении аренды:
 *  1. Доска возвращается в статус AVAILABLE
 *  2. Клиенту отправляется итоговый чек
 *  3. Если есть просрочка — создаётся счёт и отправляется QR MBank
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import {
  fmtPrice, fmtDuration, fmtDate,
  escapeHtml,
} from "../../ui/helpers";
import * as rentalService from "../../services/rental";
import { notify, sendMBankQRToChat } from "../../services/notify";
import { RentalStatus, PaymentProofKind, Role } from "@prisma/client";

export const returnsHandlers = new Composer<BotContext>();

/**
 * Единый экран подтверждения завершения аренды.
 *
 * Показывает итоговые данные (доска, клиент, время, просрочка, стоимость)
 * и кнопку подтверждения. Вызывается из любого места:
 *  - Список возвратов (admin:returns, seller:rented, seller:returns)
 *  - Детали доски (admin:board_detail)
 *  - Меню продления (admin:extend)
 */
returnsHandlers.callbackQuery(/^return:confirm:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, tariff: true, user: true },
  });

  if (!['RENTED', 'WAIT_RETURN'].includes(rental.status)) {
    return ctx.editMessageText("⚠️ Аренда уже завершена или отменена.", {
      reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
    });
  }

  const client = escapeHtml(rental.clientName ?? rental.user.name);
  const isExpired = rental.status === RentalStatus.WAIT_RETURN;

  let text = `🔄 <b>Принять доску #${rentalId}?</b>\n\n`;
  text += `🏄 Доска: <b>${rental.board.code}</b>\n`;
  text += `👤 Клиент: <b>${client}</b>\n`;

  if (rental.tariff) {
    text += `📋 Тариф: ${rental.tariff.name} — ${fmtPrice(rental.tariff.price)}\n`;
  }
  if (rental.startAt) {
    text += `⏱ Начало: ${fmtDate(rental.startAt)}\n`;
    if (rental.tariff) {
      const now = new Date();
      const actualMin = Math.ceil((now.getTime() - rental.startAt.getTime()) / 60_000);
      text += `⏳ Прошло: <b>${fmtDuration(actualMin)}</b>\n`;
    }
  }

  let overdueMin = 0;
  let overdueCost = 0;
  if (isExpired) {
    overdueMin = await rentalService.getOverdueMinutes(rental);
    if (overdueMin > 0) {
      overdueCost = overdueMin * rentalService.OVERDUE_RATE_PER_MIN;
      text += `\n⚠️ <b>Просрочка: ${fmtDuration(overdueMin)} — ${fmtPrice(overdueCost)}</b>\n`;
    }
  }

  const kb = new InlineKeyboard();
  const isWalkin = !!rental.sellerUserId;

  if (isWalkin) {
    // Walk-in: админ принимает доску и собирает наличные на месте
    if (overdueCost > 0) {
      text += `\n💵 <b>Собрать наличными: ${fmtPrice(overdueCost)}</b>\n`;
    }
    kb.text("✅ Принять доску", `return:complete:${rentalId}`).row();
  } else {
    // Онлайн-клиент: стандартный поток
    kb.text("✅ Принять доску", `return:complete:${rentalId}`).row();
    if (overdueCost > 0) {
      kb.text(`💰 Принять + счёт ${fmtPrice(overdueCost)}`, `return:invoice:${rentalId}`).row();
    }
  }
  kb.text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/**
 * Исполнение завершения аренды.
 *
 * Вызывает completeReturn → освобождает доску, уведомляет клиента.
 * Walk-in: записывает просрочку в extraCost, не шлёт уведомления.
 */
returnsHandlers.callbackQuery(/^return:complete:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  try {
    const { overdueCost, clientTgId, rental } =
      await rentalService.completeReturn(rentalId, ctx.dbUser!.id);

    const isWalkin = !!rental.sellerUserId;

    if (isWalkin && overdueCost > 0) {
      // Walk-in: записываем просрочку как наличный расчёт
      await prisma.rental.update({
        where: { id: rentalId },
        data: { extraCost: { increment: overdueCost } },
      });
    }

    const receiptOverdue = isWalkin ? overdueCost : 0;
    const receipt = await rentalService.getRentalReceipt(rentalId, receiptOverdue);

    await ctx.editMessageText(`✅ <b>Аренда завершена!</b>\n\n` + receipt, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🏄 Доски", "admin:boards")
        .text("⬅️ Меню", "back:menu"),
    });

    if (!isWalkin) {
      await notify(ctx.api, clientTgId,
        `✅ <b>Аренда завершена!</b>\n\n` + receipt + `\nСпасибо за аренду! 🌊`
      );
    }
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ ${e.message}`, {
      reply_markup: new InlineKeyboard()
        .text("⬅️ Меню", "back:menu"),
    });
  }
});

/**
 * Принять доску + выставить счёт за просрочку.
 *
 * Завершает аренду, освобождает доску. Создаёт PaymentProof(OVERDUE)
 * и отправляет клиенту QR с кнопкой «Я оплатил».
 */
returnsHandlers.callbackQuery(/^return:invoice:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  try {
    const { overdueCost, clientTgId } =
      await rentalService.completeReturn(rentalId, ctx.dbUser!.id);

    // Чек с учётом выставленной просрочки
    const receipt = await rentalService.getRentalReceipt(rentalId, overdueCost);

    // Создаём OVERDUE proof если есть просрочка
    if (overdueCost > 0) {
      const rental = await prisma.rental.findUniqueOrThrow({
        where: { id: rentalId },
        include: { board: true, user: true },
      });

      const proof = await prisma.paymentProof.create({
        data: {
          kind: PaymentProofKind.OVERDUE,
          refId: rentalId,
          amount: overdueCost,
          userId: rental.userId,
          text: `Просрочка по аренде #${rentalId}`,
        },
      });
      const overdueProofId = proof.id;

      // Админу — результат
      await ctx.editMessageText(
        `✅ <b>Доска принята, счёт выставлен!</b>\n\n` + receipt +
        `\n💰 Счёт на просрочку: <b>${fmtPrice(overdueCost)}</b>\nQR отправлен клиенту.`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("🏄 Доски", "admin:boards")
            .text("⬅️ Меню", "back:menu"),
        }
      );

      // Клиенту — доска принята, ожидает оплаты (НЕ "Аренда завершена")
      await notify(ctx.api, clientTgId,
        `🏄 <b>Доска принята!</b>\n\n` + receipt +
        `\n⚠️ К оплате за просрочку: <b>${fmtPrice(overdueCost)}</b>\n📱 Оплатите через мобильный банкинг по QR ниже или 💵 наличными на точке.`
      );
      await sendMBankQRToChat(ctx.api, Number(clientTgId), overdueCost, rentalId);

      // Уведомляем остальных админов
      const admins = await prisma.user.findMany({ where: { role: Role.ADMIN } });
      await Promise.all(admins.filter(a => a.id !== ctx.dbUser!.id).map(admin =>
        ctx.api.sendMessage(
          Number(admin.tgId),
          `⏰ <b>Счёт за просрочку #${overdueProofId}</b>\n\n` +
          `👤 ${rental.user.name}\n` +
          `🏄 Доска: ${rental.board.code}\n` +
          `💰 Сумма: <b>${fmtPrice(overdueCost)}</b>\n\n` +
          `Ожидается оплата от клиента.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("✅ Подтвердить", `pay:approve:${overdueProofId}`)
              .text("❌ Отклонить", `pay:reject:${overdueProofId}`),
          }
        ).catch(e => console.error('[returns] Ошибка уведомления админа:', e))
      ));
    } else {
      // Нет просрочки — обычное завершение
      await ctx.editMessageText(
        `✅ <b>Аренда завершена!</b>\n\n` + receipt,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("🏄 Доски", "admin:boards")
            .text("⬅️ Меню", "back:menu"),
        }
      );
      await notify(ctx.api, clientTgId,
        `✅ <b>Аренда завершена!</b>\n\n` + receipt + `\nСпасибо за аренду! 🌊`
      );
    }
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ ${e.message}`, {
      reply_markup: new InlineKeyboard()
        .text("⬅️ Меню", "back:menu"),
    });
  }
});
