/**
 * Принятие досок (администратор).
 *
 * Хендлеры:
 *  - return:confirm — экран подтверждения завершения аренды
 *  - return:complete — приём доски без оплаты просрочки (списать)
 *  - return:cash — walk-in: приём доски + наличный расчёт за просрочку
 *  - return:invoice — онлайн: приём доски + счёт за просрочку (QR + чек)
 *
 * При наличии просрочки админ выбирает один из путей закрытия:
 *  - «Списать без оплаты» — просрочка прощается, extraCost не меняется
 *  - «Наличные» (walk-in) — extraCost += overdue, расчёт собран на месте
 *  - «Счёт» (онлайн) — создаётся PaymentProof(OVERDUE) и отправляется QR
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import {
  fmtPrice, fmtDuration, fmtDate,
  escapeHtml,
} from "../../ui/helpers";
import * as rentalService from "../../services/rental";
import * as audit from "../../services/audit";
import { notify, sendMBankQRToChat } from "../../services/notify";
import { RentalStatus, PaymentProofKind, AuditAction, Role } from "@prisma/client";

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

  let overdueCost = 0;
  if (isExpired) {
    const overdueMin = await rentalService.getOverdueMinutes(rental);
    if (overdueMin > 0) {
      const overdueRate = await rentalService.getOverdueRate();
      overdueCost = overdueMin * overdueRate;
      text += `\n⚠️ <b>Просрочка: ${fmtDuration(overdueMin)} — ${fmtPrice(overdueCost)}</b>\n`;
    }
  }

  const kb = new InlineKeyboard();
  const isWalkin = !!rental.sellerUserId;

  if (overdueCost > 0) {
    // Просрочка есть — админ выбирает: списать или взять оплату
    text += `\n<i>Выберите способ закрытия просрочки:</i>\n`;
    kb.text("✅ Принять (списать просрочку)", `return:complete:${rentalId}`).row();
    if (isWalkin) {
      kb.text(`💵 Принять (наличные ${fmtPrice(overdueCost)})`, `return:cash:${rentalId}`).row();
    } else {
      kb.text(`💰 Принять + счёт ${fmtPrice(overdueCost)}`, `return:invoice:${rentalId}`).row();
    }
  } else {
    // Нет просрочки — обычное завершение
    kb.text("✅ Принять доску", `return:complete:${rentalId}`).row();
  }
  kb.text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/**
 * Приём доски без оплаты просрочки.
 *
 * Универсальный путь для walk-in и онлайн: завершает аренду,
 * освобождает доску. Если была просрочка — она списывается
 * (extraCost не меняется), в чеке показывается «просрочка списана».
 */
returnsHandlers.callbackQuery(/^return:complete:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  try {
    const { overdueCost, clientTgId, rental } =
      await rentalService.completeReturn(rentalId, ctx.dbUser!.id);

    const isWalkin = !!rental.sellerUserId;

    // Если была просрочка — фиксируем факт списания в аудите
    if (overdueCost > 0) {
      await audit.log(ctx.dbUser!.id, "Rental", rentalId, AuditAction.CLOSE_OVERDUE, {
        forgiven: true,
        forgivenAmount: overdueCost,
      });
    }

    const receipt = await rentalService.getRentalReceipt(rentalId, 0);
    const forgivenNote = overdueCost > 0
      ? `\n🎁 Просрочка <b>${fmtPrice(overdueCost)}</b> списана администратором.\n`
      : "";

    await ctx.editMessageText(`✅ <b>Аренда завершена!</b>\n${forgivenNote}\n` + receipt, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🏄 Доски", "admin:boards")
        .text("⬅️ Меню", "back:menu"),
    });

    if (!isWalkin) {
      await notify(ctx.api, clientTgId,
        `✅ <b>Аренда завершена!</b>\n${forgivenNote}\n` + receipt + `\nСпасибо за аренду! 🌊`
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
 * Walk-in: приём доски + наличные за просрочку.
 *
 * Завершает аренду, увеличивает extraCost на сумму просрочки
 * (расчёт собран на месте). Клиента не уведомляет — у walk-in нет TG.
 */
returnsHandlers.callbackQuery(/^return:cash:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  try {
    const { overdueCost, rental } =
      await rentalService.completeReturn(rentalId, ctx.dbUser!.id);

    if (!rental.sellerUserId) {
      // Защита: для онлайн-клиента наличные не применимы — используется счёт
      throw new Error("Этот путь доступен только для walk-in аренд.");
    }

    if (overdueCost > 0) {
      await prisma.rental.update({
        where: { id: rentalId },
        data: { extraCost: { increment: overdueCost } },
      });
      await audit.log(ctx.dbUser!.id, "Rental", rentalId, AuditAction.CLOSE_OVERDUE, {
        paidCash: true,
        amount: overdueCost,
      });
    }

    const receipt = await rentalService.getRentalReceipt(rentalId, overdueCost);
    const cashNote = overdueCost > 0
      ? `\n💵 Наличные за просрочку: <b>${fmtPrice(overdueCost)}</b>\n`
      : "";

    await ctx.editMessageText(`✅ <b>Аренда завершена!</b>\n${cashNote}\n` + receipt, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🏄 Доски", "admin:boards")
        .text("⬅️ Меню", "back:menu"),
    });
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

      await audit.log(ctx.dbUser!.id, "Rental", rentalId, AuditAction.CLOSE_OVERDUE, {
        billed: true,
        amount: overdueCost,
        proofId: overdueProofId,
      });

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

      // Уведомляем остальной staff (админов и кассиров)
      const staff = await prisma.user.findMany({ where: { role: { in: [Role.ADMIN, Role.CASHIER] } } });
      await Promise.all(staff.filter(a => a.id !== ctx.dbUser!.id).map(admin =>
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
