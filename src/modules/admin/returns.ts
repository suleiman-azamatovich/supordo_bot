/**
 * Возвраты и принятие досок (администратор).
 *
 * Объединяет хендлеры из бывших admin.ts и seller.ts:
 *  - admin:returns — список аренд/возвратов с кнопками действий
 *  - seller:rented — список активных аренд на точке (кнопка «Все в аренде»)
 *  - seller:returns — аналогичный список для возвратов
 *  - seller:return — принятие возврата доски
 *  - admin:complete_rental_confirm — подтверждение завершения
 *  - admin:complete_rental — выполнение завершения аренды
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
  escapeHtml, paginate, addPaginationRow,
} from "../../ui/helpers";
import * as rentalService from "../../services/rental";
import { notify, sendMBankQRToChat } from "../../services/notify";
import { RentalStatus, PaymentProofKind, Role } from "@prisma/client";

export const returnsHandlers = new Composer<BotContext>();

/**
 * Общий список аренд и возвратов (для панели управления).
 *
 * Показывает все активные аренды и ожидающие возврата с кнопками:
 *  - Принять возврат
 *  - Продлить / подтвердить продление
 *  - Закрыть просрочку
 */
returnsHandlers.callbackQuery(/^admin:returns(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");

  const rentals = await prisma.rental.findMany({
    where: { status: { in: [RentalStatus.WAIT_RETURN, RentalStatus.RENTED] } },
    include: { board: true, user: true, tariff: true },
    orderBy: { startAt: "asc" },
  });

  const waitReturn = rentals.filter(r => r.status === RentalStatus.WAIT_RETURN).length;
  const active = rentals.filter(r => r.status === RentalStatus.RENTED).length;
  const paged = paginate(rentals, page);
  const now = new Date();

  let text = `🔄 <b>Аренды и возвраты</b>\n`;
  text += `⏰ Ожидают возврата: <b>${waitReturn}</b>  ·  🔵 В аренде: <b>${active}</b>\n\n`;
  if (paged.items.length === 0) {
    text += "Нет активных аренд.";
  }

  const kb = new InlineKeyboard();
  for (const r of paged.items) {
    const client = escapeHtml(r.clientName ?? r.user.name);
    const isExpired = r.status === RentalStatus.WAIT_RETURN;
    const icon = isExpired ? "⏰" : "🔵";

    text += `${icon} <b>${r.board.code}</b> — ${client}`;
    if (r.pendingExtraMinutes) {
      text += ` ⏱ <i>запрос +${fmtDuration(r.pendingExtraMinutes)}</i>`;
    }
    text += `\n`;
    if (r.startAt && r.tariff) {
      const totalMin = r.tariff.durationMinutes + (r.extraMinutes ?? 0);
      const endAt = new Date(r.startAt.getTime() + totalMin * 60_000);
      if (isExpired) {
        const overdue = await rentalService.getOverdueMinutes(r);
        if (overdue > 0) {
          const cost = overdue * rentalService.OVERDUE_RATE_PER_MIN;
          text += `     просрочено <b>${fmtDuration(overdue)}</b> — ${fmtPrice(cost)}\n`;
        } else {
          const graceMs = await rentalService.getEndGraceMs();
          const graceLabel = graceMs >= 60_000 ? `${Math.round(graceMs / 60_000)} мин` : `${Math.round(graceMs / 1_000)} сек`;
          text += `     бесплатное время на возврат (${graceLabel})\n`;
        }
      } else {
        const remaining = Math.max(0, Math.ceil((endAt.getTime() - now.getTime()) / 60_000));
        text += `     осталось ${fmtDuration(remaining)}\n`;
      }
    }
    text += `\n`;
    kb.text(`✅ Принять ${r.board.code}`, `return:confirm:${r.id}`);
    if (r.pendingExtraMinutes) {
      kb.text(`⏱ ✅ +${fmtDuration(r.pendingExtraMinutes)}`, `ext:approve:${r.id}`);
    } else {
      kb.text(`⏱ +`, `admin:extend:${r.id}`);
    }
    kb.row();
  }
  addPaginationRow(kb, paged.page, paged.totalPages, "admin:returns:");
  kb.text("🔄 Обновить", "admin:returns").row();
  kb.text("⬅️ Меню", "back:menu").text("🧹 Убрать лишнее", "clear:chat");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/** Список активных аренд на точке админа (seller:rented) */
returnsHandlers.callbackQuery(/^seller:rented(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");
  const spotId = ctx.dbUser!.spotId;
  if (!spotId) {
    return ctx.editMessageText("⚠️ Вы не привязаны к точке.");
  }

  const rentals = await prisma.rental.findMany({
    where: { spotId, status: { in: [RentalStatus.RENTED, RentalStatus.WAIT_RETURN] } },
    include: { board: true, user: true, tariff: true },
    orderBy: { startAt: "asc" },
  });

  const paged = paginate(rentals, page);
  const now = new Date();

  let text = `🏄 <b>В аренде</b> (${rentals.length})\n\n`;
  if (paged.items.length === 0) {
    text += "Нет активных аренд.";
  }

  const kb = new InlineKeyboard();
  for (const r of paged.items) {
    const client = escapeHtml(r.clientName ?? r.user.name);
    const isExpired = r.status === RentalStatus.WAIT_RETURN;
    const icon = isExpired ? "🔴" : "🟢";

    text += `${icon} <b>${r.board.code}</b> → ${client}\n`;
    if (r.tariff) {
      text += `   💰 ${r.tariff.name} — ${fmtPrice(r.tariff.price)}\n`;
    }
    if (r.startAt) {
      text += `   ⏱ Старт: ${fmtDate(r.startAt)}\n`;
      if (r.tariff) {
        const totalMin = r.tariff.durationMinutes + (r.extraMinutes ?? 0);
        const endAt = new Date(r.startAt.getTime() + totalMin * 60_000);
        const remaining = Math.max(0, Math.ceil((endAt.getTime() - now.getTime()) / 60_000));
        if (isExpired) {
          const overdue = await rentalService.getOverdueMinutes(r);
          if (overdue > 0) {
            const cost = overdue * rentalService.OVERDUE_RATE_PER_MIN;
            text += `   ⚠️ Просрочка: ${fmtDuration(overdue)} — <b>${fmtPrice(cost)}</b>\n`;
          } else {
            const graceMs = await rentalService.getEndGraceMs();
            const graceLabel = graceMs >= 60_000 ? `${Math.round(graceMs / 60_000)} мин` : `${Math.round(graceMs / 1_000)} сек`;
            text += `   ⏰ <b>Время вышло! Возврат без штрафа: ${graceLabel}</b>\n`;
          }
        } else if (remaining > 0) {
          text += `   ⏳ Осталось: <b>${fmtDuration(remaining)}</b>\n`;
        }
      }
    }
    text += "\n";

    kb.text(`✅ Принять ${r.board.code}`, `return:confirm:${r.id}`).row();
  }
  addPaginationRow(kb, paged.page, paged.totalPages, "seller:rented:");
  kb.row().text("⬅️ Меню", "back:menu").text("🧹 Убрать лишнее", "clear:chat");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/** Список возвратов на точке (seller:returns) */

returnsHandlers.callbackQuery(/^seller:returns(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");
  const spotId = ctx.dbUser!.spotId;
  if (!spotId) {
    return ctx.editMessageText("⚠️ Вы не привязаны к точке.");
  }

  const rentals = await prisma.rental.findMany({
    where: { spotId, status: { in: [RentalStatus.WAIT_RETURN, RentalStatus.RENTED] } },
    include: { board: true, user: true, tariff: true },
    orderBy: { startAt: "asc" },
  });

  const paged = paginate(rentals, page);

  let text = "🔄 <b>Возвраты</b>\n\n";
  if (paged.items.length === 0) {
    text += "Нет досок к возврату.";
  }

  const kb = new InlineKeyboard();
  for (const r of paged.items) {
    const expired = r.status === RentalStatus.WAIT_RETURN;
    const icon = expired ? "🔴" : "🟡";
    const tag = expired ? " ⏰ время вышло!" : "";
    text += `${icon} #${r.id} — ${r.board.code} → ${escapeHtml(r.clientName ?? r.user.name)}${tag}\n`;
    kb.text(`✅ Принять ${r.board.code}`, `return:confirm:${r.id}`).row();
  }
  addPaginationRow(kb, paged.page, paged.totalPages, "seller:returns:");
  kb.row().text("⬅️ Меню", "back:menu").text("🧹 Убрать лишнее", "clear:chat");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

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
  kb.text("✅ Принять доску", `return:complete:${rentalId}`).row();
  if (overdueCost > 0) {
    kb.text(`💰 Принять + счёт ${fmtPrice(overdueCost)}`, `return:invoice:${rentalId}`).row();
  }
  kb.text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/**
 * Исполнение завершения аренды.
 *
 * Вызывает completeReturn → освобождает доску, уведомляет клиента.
 */
returnsHandlers.callbackQuery(/^return:complete:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  try {
    const { clientTgId } =
      await rentalService.completeReturn(rentalId, ctx.dbUser!.id);

    // Простое принятие — просрочка не выставляется (overdueBilled = 0)
    const receipt = await rentalService.getRentalReceipt(rentalId);

    await ctx.editMessageText(`✅ <b>Аренда завершена!</b>\n\n` + receipt, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🏄 Доски", "admin:boards")
        .text("⬅️ Меню", "back:menu"),
    });

    await notify(ctx.api, clientTgId,
      `✅ <b>Аренда завершена!</b>\n\n` + receipt + `\nСпасибо за аренду! 🌊`
    );
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
