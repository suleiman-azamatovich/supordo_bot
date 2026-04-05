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
import { RentalStatus, Role } from "@prisma/client";

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
  text += `⏰ Ожидают возврата: <b>${waitReturn}</b>  ·  🔴 В аренде: <b>${active}</b>\n\n`;
  if (paged.items.length === 0) {
    text += "Нет активных аренд.";
  }

  const kb = new InlineKeyboard();
  for (const r of paged.items) {
    const client = escapeHtml(r.clientName ?? r.user.name);
    const isExpired = r.status === RentalStatus.WAIT_RETURN;
    const icon = isExpired ? "⏰" : "🔴";

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
          text += `     грейс-период (${graceLabel})\n`;
        }
      } else {
        const remaining = Math.max(0, Math.ceil((endAt.getTime() - now.getTime()) / 60_000));
        text += `     осталось ${fmtDuration(remaining)}\n`;
      }
    }
    text += `\n`;
    kb.text(`✅ Принять ${r.board.code}`, `seller:return:${r.id}`);
    if (r.pendingExtraMinutes) {
      kb.text(`⏱ ✅ +${fmtDuration(r.pendingExtraMinutes)}`, `ext:approve:${r.id}`);
    } else {
      kb.text(`⏱ +`, `admin:extend:${r.id}`);
    }
    kb.row();
    if (isExpired) {
      kb.text(`🔄 Закрыть просрочку`, `admin:close_overdue:${r.id}`).row();
    }
  }
  addPaginationRow(kb, paged.page, paged.totalPages, "admin:returns:");
  kb.text("🔄 Обновить", "admin:returns").row();
  kb.text("📋 Панель", "admin:dashboard").text("⬅️ Меню", "back:menu");

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
            text += `   ⏰ <b>Время вышло! Грейс ${graceLabel}</b>\n`;
          }
        } else if (remaining > 0) {
          text += `   ⏳ Осталось: <b>${fmtDuration(remaining)}</b>\n`;
        }
      }
    }
    text += "\n";

    kb.text(`✅ Принять ${r.board.code}`, `seller:return:${r.id}`).row();
  }
  addPaginationRow(kb, paged.page, paged.totalPages, "seller:rented:");
  kb.row().text("⬅️ Меню", "back:menu");

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
    kb.text(`✅ Принять ${r.board.code}`, `seller:return:${r.id}`).row();
  }
  addPaginationRow(kb, paged.page, paged.totalPages, "seller:returns:");
  kb.row().text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/**
 * Принятие возврата доски (seller:return).
 *
 * Вызывает rentalService.completeReturn, который:
 *  1. Завершает аренду (статус RETURNED)
 *  2. Освобождает доску (статус AVAILABLE)
 *  3. Считает просрочку и создаёт счёт при необходимости
 *  4. Формирует текст чека
 */
returnsHandlers.callbackQuery(/^seller:return:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  try {
    const { receipt, overdueCost, clientMsg, clientTgId, overdueProofId } =
      await rentalService.completeReturn(rentalId, ctx.dbUser!.id);

    const isAdmin = ctx.dbUser!.role === Role.ADMIN;
    const backAction = isAdmin ? "admin:returns" : "seller:returns";

    let sellerMsg = `✅ <b>Аренда завершена!</b>\n\n` + receipt;
    if (overdueCost > 0) {
      sellerMsg += `\n⚠️ Создан счёт на доплату за просрочку: <b>${fmtPrice(overdueCost)}</b>`;
    }

    await ctx.editMessageText(sellerMsg, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🔄 Возвраты", backAction)
        .text("⬅️ Меню", "back:menu"),
    });

    // Отправляем чек клиенту
    await notify(ctx.api, clientTgId, clientMsg, { deleteAfterMs: 0 });

    // Если есть просрочка — QR и уведомление админам
    if (overdueCost > 0 && overdueProofId) {
      await sendMBankQRToChat(ctx.api, Number(clientTgId), overdueCost);

      const [admins, rental] = await Promise.all([
        prisma.user.findMany({ where: { role: Role.ADMIN } }),
        prisma.rental.findUniqueOrThrow({
          where: { id: rentalId },
          include: { board: true, user: true },
        }),
      ]);
      await Promise.all(admins.filter((a) => a.id !== ctx.dbUser!.id).map((admin) =>
        ctx.api.sendMessage(
          Number(admin.tgId),
          `⏰ <b>Доплата за просрочку #${overdueProofId}</b>\n\n` +
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
        ).catch((e) => console.error('[returns] Ошибка уведомления админа:', e))
      ));
    }
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ Ошибка: ${e.message}`);
  }
});

/** Подтверждение завершения аренды (показ чека и кнопки «Да, завершить») */
returnsHandlers.callbackQuery(/^admin:complete_rental_confirm:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  const receipt = await rentalService.getRentalReceipt(rentalId);
  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true },
  });

  let text = `⚠️ <b>Завершить аренду #${rentalId}?</b>\n\n`;
  text += receipt;
  text += `\n\n⚠️ Доска будет возвращена в доступные. Клиент получит итоговый отчёт.`;

  const kb = new InlineKeyboard()
    .text("✅ Да, завершить", `admin:complete_rental:${rentalId}`)
    .text("⬅️ Назад", `admin:board_detail:${rental.boardId}`)
    .row()
    .text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/** Выполнение завершения аренды — освобождение доски и уведомление клиента */
returnsHandlers.callbackQuery(/^admin:complete_rental:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  try {
    const { receipt, overdueCost, clientMsg, clientTgId, overdueProofId } =
      await rentalService.completeReturn(rentalId, ctx.dbUser!.id);

    let msg = `✅ Аренда завершена!\n\n` + receipt;
    if (overdueCost > 0) {
      msg += `\n⚠️ Создан счёт на доплату за просрочку: <b>${fmtPrice(overdueCost)}</b>`;
    }

    await ctx.editMessageText(msg, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🔄 Возвраты", "admin:returns")
        .text("🏄 Доски", "admin:boards")
        .row()
        .text("⬅️ Меню", "back:menu"),
    });

    await notify(ctx.api, clientTgId, clientMsg, { deleteAfterMs: 0 });

    if (overdueCost > 0 && overdueProofId) {
      await sendMBankQRToChat(ctx.api, Number(clientTgId), overdueCost);

      const [admins, rental] = await Promise.all([
        prisma.user.findMany({ where: { role: Role.ADMIN } }),
        prisma.rental.findUniqueOrThrow({
          where: { id: rentalId },
          include: { board: true, user: true },
        }),
      ]);
      await Promise.all(admins.filter((a) => a.id !== ctx.dbUser!.id).map((admin) =>
        ctx.api.sendMessage(
          Number(admin.tgId),
          `⏰ <b>Доплата за просрочку #${overdueProofId}</b>\n\n` +
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
        ).catch((e) => console.error('[returns] Ошибка уведомления админа:', e))
      ));
    }
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ Ошибка: ${e.message}`);
  }
});
