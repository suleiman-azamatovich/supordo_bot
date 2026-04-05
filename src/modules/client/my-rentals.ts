/**
 * Мои аренды — список, продление, просрочка.
 *
 * Обрабатывает:
 *  - client:my_list — список всех аренд клиента с пагинацией
 *  - client:close_overdue — запрос на закрытие просрочки (оплата через MBank)
 *  - client:extend — выбор тарифа для продления
 *  - client:extend_confirm — отправка запроса на продление админу
 *
 * Каждая аренда показывает статус, оставшееся время, просрочку,
 * ожидающие запросы на продление и итоговый чек.
 */

import { Composer, InlineKeyboard } from "grammy";
import { Role } from "@prisma/client";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import { fmtPrice, fmtDuration, fmtDate, paginate, addPaginationRow } from "../../ui/helpers";
import * as rentalService from "../../services/rental";
import { sendMBankQR, notifyAdminsNewPayment } from "./helpers";

export const myRentalsHandlers = new Composer<BotContext>();

/** Словарь статусов аренды → человекочитаемые подписи */
const rentalStatusLabel: Record<string, string> = {
  CREATED: "⏳ Создана",
  WAIT_PAYMENT: "💳 Ожидает оплаты",
  WAIT_ADMIN: "🔍 Проверка оплаты",
  RENTED: "🏄 В аренде",
  WAIT_RETURN: "⏰ Верните доску!",
  RETURNED: "✅ Завершена",
  CANCELLED: "❌ Отменена",
};

/** Список всех аренд клиента с пагинацией и кнопками действий */
myRentalsHandlers.callbackQuery(/^client:my_list(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");

  const userId = ctx.dbUser!.id;

  const rentals = await prisma.rental.findMany({
    where: { userId },
    include: { board: true, spot: true, tariff: true },
    orderBy: { createdAt: "desc" },
  });

  const paged = paginate(rentals, page, 5);

  let text = "📋 <b>Мои аренды</b>\n\n";
  if (paged.items.length === 0) {
    text += "У вас пока нет аренд.";
  } else {
    for (const r of paged.items) {
      const status = rentalStatusLabel[r.status] ?? r.status;
      const price = r.tariff ? fmtPrice(r.tariff.price) : "—";
      const duration = r.tariff ? fmtDuration(r.tariff.durationMinutes) : "—";

      text += `<b>${r.board.code}</b>  ${status}\n`;
      text += `   💰 ${price}  ·  ⏱ ${duration}\n`;

      if (r.startAt) {
        text += `   📅 ${fmtDate(r.startAt)}\n`;
      }

      // Оставшееся время для активных аренд
      if (
        r.startAt &&
        r.tariff &&
        ["CREATED", "WAIT_PAYMENT", "WAIT_ADMIN", "RENTED"].includes(r.status)
      ) {
        const totalMin = r.tariff.durationMinutes + (r.extraMinutes ?? 0);
        const expiresAt = new Date(r.startAt.getTime() + totalMin * 60_000);
        const remainMs = expiresAt.getTime() - Date.now();
        if (remainMs > 0) {
          const mins = Math.floor(remainMs / 60_000);
          const secs = Math.floor((remainMs % 60_000) / 1_000);
          text += `   ⏳ Осталось: ${mins} мин ${secs} сек\n`;
        } else {
          text += `   ⏰ Время истекло\n`;
        }
      }

      if (r.status === "WAIT_RETURN") {
        const overdue = await rentalService.getOverdueMinutes(r);
        if (overdue > 0) {
          const cost = overdue * rentalService.OVERDUE_RATE_PER_MIN;
          text += `   ⚠️ Просрочка: ${fmtDuration(overdue)} — <b>${fmtPrice(cost)}</b> (${rentalService.OVERDUE_RATE_PER_MIN} сом/мин)\n`;
        } else {
          const graceMs = await rentalService.getEndGraceMs();
          const graceLabel = graceMs >= 60_000 ? `${Math.round(graceMs / 60_000)} мин` : `${Math.round(graceMs / 1_000)} сек`;
          text += `   ⏰ Время истекло — грейс ${graceLabel}, верните доску\n`;
        }
      }

      if (r.pendingExtraMinutes) {
        text += `   ⏳ Запрос продления: +${fmtDuration(r.pendingExtraMinutes)} (ожидает подтверждения)\n`;
      }

      if (r.endAt) {
        text += `   🏁 Возврат: ${fmtDate(r.endAt)}\n`;
      }

      text += `\n`;
    }
  }

  const kb = new InlineKeyboard();
  for (const r of paged.items) {
    if (r.status === "WAIT_RETURN") {
      const overdue = await rentalService.getOverdueMinutes(r);
      if (overdue > 0) {
        const cost = overdue * rentalService.OVERDUE_RATE_PER_MIN;
        kb.text(`🔄 Закрыть просрочку ${r.board.code} (${fmtDuration(overdue)} — ${fmtPrice(cost)})`, `client:close_overdue:${r.id}`).row();
      }
    }
    if ((r.status === "RENTED" || r.status === "WAIT_RETURN") && !r.pendingExtraMinutes) {
      kb.text(`⏱ Продлить ${r.board.code}`, `client:extend:${r.id}`).row();
    }
  }
  addPaginationRow(kb, paged.page, paged.totalPages, "client:my_list:");
  kb.row().text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/**
 * Запрос на закрытие просрочки.
 *
 * Создаёт запись об оплате просрочки, отправляет QR MBank
 * и уведомляет всех админов.
 */
myRentalsHandlers.callbackQuery(/^client:close_overdue:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, tariff: true },
  });

  if (rental.userId !== ctx.dbUser!.id) {
    return ctx.editMessageText("⛔ Это не ваша аренда.");
  }

  try {
    const { proof, overdueCost, overdueMinutes } =
      await rentalService.requestCloseOverdue(rentalId, ctx.dbUser!.id);

    await ctx.editMessageText(
      `⏰ <b>Запрос на закрытие просрочки</b>\n\n` +
      `🏄 Доска: <b>${rental.board.code}</b>\n` +
      `⏱ Просрочка: <b>${fmtDuration(overdueMinutes)}</b>\n` +
      `💰 К оплате: <b>${fmtPrice(overdueCost)}</b>\n\n` +
      `Оплатите через MBank по QR-коду ниже.\n` +
      `После подтверждения оплаты администратором просрочка будет закрыта.`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("📋 Мои аренды", "client:my_list")
          .text("⬅️ Меню", "back:menu"),
      }
    );

    await sendMBankQR(ctx, overdueCost);
    await notifyAdminsNewPayment(ctx, proof.id);
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ ${e.message}`, {
      reply_markup: new InlineKeyboard().text("📋 Мои аренды", "client:my_list"),
    });
  }
});

/** Выбор тарифа для продления аренды */
myRentalsHandlers.callbackQuery(/^client:extend:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, tariff: true },
  });

  if (rental.userId !== ctx.dbUser!.id) {
    return ctx.editMessageText("⛔ Это не ваша аренда.");
  }

  const tariffs = await prisma.tariff.findMany({
    where: { spotId: rental.spotId, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { durationMinutes: "asc" }],
  });

  let text = `⏱ <b>Продлить аренду</b>\n\n`;
  text += `🏄 Доска: <b>${rental.board.code}</b>\n`;
  if (rental.tariff) {
    const totalMin = rental.tariff.durationMinutes + (rental.extraMinutes ?? 0);
    text += `⏱ Текущая длительность: <b>${fmtDuration(totalMin)}</b>\n`;
  }
  text += `\nВыберите время продления:`;

  const kb = new InlineKeyboard();
  for (const t of tariffs) {
    kb.text(
      `+${fmtDuration(t.durationMinutes)} — ${fmtPrice(t.price)}`,
      `client:extend_confirm:${rentalId}:${t.id}`
    ).row();
  }
  kb.text("⬅️ Назад", "client:my_list").text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/**
 * Подтверждение продления → отправка запроса админам.
 *
 * Записывает pendingExtraMinutes в аренду и рассылает всем админам
 * уведомление с кнопками «Подтвердить / Отклонить / Написать».
 */
myRentalsHandlers.callbackQuery(/^client:extend_confirm:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);
  const tariffId = parseInt(ctx.match[2]);

  const extensionTariff = await prisma.tariff.findUniqueOrThrow({ where: { id: tariffId } });
  const minutes = extensionTariff.durationMinutes;

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, tariff: true },
  });

  if (rental.userId !== ctx.dbUser!.id) {
    return ctx.editMessageText("⛔ Это не ваша аренда.");
  }

  try {
    await rentalService.requestExtend(rentalId, minutes, ctx.dbUser!.id);

    await ctx.editMessageText(
      `⏳ <b>Запрос на продление отправлен</b>\n\n` +
      `🏄 Доска: <b>${rental.board.code}</b>\n` +
      `⏱ Продление: <b>+${fmtDuration(minutes)}</b> — ${fmtPrice(extensionTariff.price)}\n\n` +
      `Ожидайте подтверждения администратора.`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("📋 Мои аренды", "client:my_list")
          .text("⬅️ Меню", "back:menu"),
      }
    );

    // Уведомляем всех админов
    const admins = await prisma.user.findMany({ where: { role: Role.ADMIN } });
    await Promise.all(admins.map(async (admin) => {
      await prisma.notification.create({
        data: {
          userId: admin.id,
          text: `⏱ Запрос продления: ${ctx.dbUser!.name} — ${rental.board.code} на +${fmtDuration(minutes)}`,
        },
      });

      try {
        await ctx.api.sendMessage(
          Number(admin.tgId),
          `⏱ <b>Запрос на продление</b>\n\n` +
          `👤 Клиент: <b>${ctx.dbUser!.name}</b>\n` +
          `🏄 Доска: <b>${rental.board.code}</b>\n` +
          `⏱ Продление: <b>+${fmtDuration(minutes)}</b>\n\n` +
          `Подтвердите или отклоните:`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("✅ Подтвердить", `ext:approve:${rentalId}`)
              .text("❌ Отклонить", `ext:reject:${rentalId}`)
              .row()
              .text("💬 Написать клиенту", `ext:chat:${rentalId}`),
          }
        );
      } catch (e) {
        console.error(`Failed to notify admin ${admin.tgId}:`, e);
      }
    }));
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ ${e.message}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Назад", "client:my_list"),
    });
  }
});
