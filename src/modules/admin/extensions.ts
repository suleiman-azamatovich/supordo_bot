/**
 * Управление продлениями аренды (администратор).
 *
 * Обрабатывает:
 *  - ext:approve — подтверждение запроса клиента на продление
 *  - ext:reject — отклонение продления
 *  - ext:chat — вход в чат с клиентом по продлению
 *  - admin:extend — админ сам инициирует продление
 *  - admin:extend_confirm — подтверждение продления от админа
 *  - admin:close_overdue — закрытие просрочки (покрытие тарифом, без доп. времени)
 *
 * При продлении:
 *  - Если есть просрочка, время продления сначала покрывает её
 *  - Остаток добавляется как чистое время аренды
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import { fmtPrice, fmtDuration, escapeHtml } from "../../ui/helpers";
import * as rentalService from "../../services/rental";
import { notify } from "../../services/notify";

export const extensionsHandlers = new Composer<BotContext>();

/**
 * Подтверждение продления по запросу клиента.
 *
 * Берёт pendingExtraMinutes из аренды, находит соответствующий тариф
 * для определения цены, вызывает extendRental.
 */
extensionsHandlers.callbackQuery(/^ext:approve:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.chatMode = undefined;
  ctx.session.chatWithClientTgId = undefined;
  ctx.session.chatRentalId = undefined;
  const rentalId = parseInt(ctx.match[1]);

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, tariff: true, user: true },
  });

  const minutes = rental.pendingExtraMinutes;
  if (!minutes) {
    return ctx.editMessageText("⚠️ Нет активного запроса на продление.", {
      reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
    });
  }

  try {
    const extensionTariff = await prisma.tariff.findFirst({
      where: { spotId: rental.spotId, durationMinutes: minutes },
    });
    const extensionCost = extensionTariff?.price ?? 0;

    const result = await rentalService.extendRental(rentalId, minutes, ctx.dbUser!.id, extensionCost);
    const totalMin = (rental.tariff?.durationMinutes ?? 0) + (rental.extraMinutes ?? 0) + minutes;
    const client = escapeHtml(rental.clientName ?? rental.user.name);

    let msg = `✅ Продление подтверждено!\n\n`;
    msg += `🏄 Доска: <b>${rental.board.code}</b>\n`;
    msg += `👤 Клиент: <b>${client}</b>\n`;
    msg += `⏱ +${fmtDuration(minutes)} — ${fmtPrice(extensionCost)}\n`;
    if (result.overdueMinutes > 0) {
      msg += `⚠️ Покрыто просрочки: <b>${fmtDuration(result.overdueMinutes)}</b>\n`;
      msg += `✅ Чистое время: <b>${fmtDuration(result.netMinutes)}</b>\n`;
    }
    msg += `Общая длительность: <b>${fmtDuration(totalMin)}</b>`;

    await ctx.editMessageText(msg, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🔄 Возвраты", "admin:returns")
        .text("📋 Панель", "admin:dashboard")
        .row()
        .text("⬅️ Меню", "back:menu"),
    });

    // Уведомление клиенту
    let clientMsg = `✅ Продление подтверждено!\n\n`;
    clientMsg += `🏄 Доска: <b>${rental.board.code}</b>\n`;
    clientMsg += `⏱ +<b>${fmtDuration(minutes)}</b> — ${fmtPrice(extensionCost)}\n`;
    if (result.overdueMinutes > 0) {
      clientMsg += `⚠️ Из них покрыто просрочки: ${fmtDuration(result.overdueMinutes)}\n`;
    }
    clientMsg += `Общая длительность: <b>${fmtDuration(totalMin)}</b>. Приятного катания! 🌊`;
    await notify(ctx.api, rental.user.tgId, clientMsg);
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ ${e.message}`);
  }
});

/** Отклонение запроса на продление — уведомление клиенту */
extensionsHandlers.callbackQuery(/^ext:reject:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.chatMode = undefined;
  ctx.session.chatWithClientTgId = undefined;
  ctx.session.chatRentalId = undefined;
  const rentalId = parseInt(ctx.match[1]);

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, user: true },
  });

  await rentalService.rejectExtend(rentalId, ctx.dbUser!.id);
  const client = escapeHtml(rental.clientName ?? rental.user.name);

  await ctx.editMessageText(
    `❌ Запрос на продление отклонён.\n\n` +
    `🏄 Доска: <b>${rental.board.code}</b>\n` +
    `👤 Клиент: <b>${client}</b>`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🔄 Возвраты", "admin:returns")
        .text("⬅️ Меню", "back:menu"),
    }
  );

  await notify(
    ctx.api,
    rental.user.tgId,
    `❌ Ваш запрос на продление доски <b>${rental.board.code}</b> отклонён.\nСвяжитесь с администрацией.`
  );
});

/** Вход в чат с клиентом по вопросу продления */
extensionsHandlers.callbackQuery(/^ext:chat:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { user: true, board: true },
  });

  ctx.session.chatMode = 'extension';
  ctx.session.chatWithClientTgId = Number(rental.user.tgId);
  ctx.session.chatRentalId = rentalId;
  ctx.session.chatProofId = undefined;

  const client = escapeHtml(rental.clientName ?? rental.user.name);

  await ctx.editMessageText(
    `💬 <b>Чат с клиентом ${client}</b> (продление #${rentalId})\n\n` +
    `🏄 Доска: ${rental.board.code}\n` +
    `Напишите сообщение — оно будет отправлено клиенту.`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("✅ Подтвердить", `ext:approve:${rentalId}`)
        .text("❌ Отклонить", `ext:reject:${rentalId}`)
        .row()
        .text("🛑 Завершить чат", `admin:end_chat`),
    }
  );
});

/** Админ инициирует продление — выбор тарифа */
extensionsHandlers.callbackQuery(/^admin:extend:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, tariff: true, user: true },
  });

  const tariffs = await prisma.tariff.findMany({
    where: { spotId: rental.spotId },
    orderBy: { durationMinutes: "asc" },
  });

  const client = escapeHtml(rental.clientName ?? rental.user.name);
  const overdue = await rentalService.getOverdueMinutes(rental);

  let text = `⏱ <b>Продлить аренду</b>\n\n`;
  text += `🏄 Доска: <b>${rental.board.code}</b>\n`;
  text += `👤 Клиент: <b>${client}</b>\n`;
  if (rental.tariff) {
    const totalMin = rental.tariff.durationMinutes + (rental.extraMinutes ?? 0);
    text += `⏱ Текущая длительность: <b>${fmtDuration(totalMin)}</b>\n`;
  }
  if (overdue > 0) {
    text += `\n⚠️ <b>Просрочка: ${fmtDuration(overdue)}</b>\n`;
    text += `<i>Просрочка будет покрыта из времени продления.</i>\n`;
  }
  text += `\nВыберите время продления:`;

  const kb = new InlineKeyboard();
  if (overdue > 0) {
    kb.text(`🔄 Закрыть просрочку (${fmtDuration(overdue)})`, `admin:close_overdue:${rentalId}`).row();
  }
  for (const t of tariffs) {
    const net = overdue > 0 ? Math.max(0, t.durationMinutes - overdue) : t.durationMinutes;
    const label = overdue > 0
      ? `+${fmtDuration(t.durationMinutes)} (нетто ${fmtDuration(net)}) — ${fmtPrice(t.price)}`
      : `+${fmtDuration(t.durationMinutes)} — ${fmtPrice(t.price)}`;
    kb.text(label, `admin:extend_confirm:${rentalId}:${t.id}`).row();
  }
  kb.text("⬅️ Назад", `admin:board_detail:${rental.boardId}`).text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/**
 * Закрытие просрочки без продления.
 *
 * Покрывает просрочку за доплату, но не даёт дополнительного времени.
 * Аренда возвращается в статус RENTED.
 */
extensionsHandlers.callbackQuery(/^admin:close_overdue:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  try {
    const result = await rentalService.closeOverdue(rentalId, ctx.dbUser!.id);
    const rental = await prisma.rental.findUniqueOrThrow({
      where: { id: rentalId },
      include: { board: true, user: true, tariff: true },
    });
    const client = escapeHtml(rental.clientName ?? rental.user.name);

    await ctx.editMessageText(
      `✅ Просрочка закрыта!\n\n` +
      `🏄 Доска: <b>${rental.board.code}</b>\n` +
      `👤 Клиент: <b>${client}</b>\n` +
      `⏱ Покрыто: <b>${fmtDuration(result.closedMinutes)}</b>\n` +
      `💰 Доплата: <b>${fmtPrice(result.overdueCost)}</b>\n` +
      `Аренда снова активна (без дополнительного времени).`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("⏱ Продлить", `admin:extend:${rentalId}`)
          .row()
          .text("🔄 Возвраты", "admin:returns")
          .text("🏄 Доски", "admin:boards")
          .row()
          .text("⬅️ Меню", "back:menu"),
      }
    );

    await notify(
      ctx.api,
      rental.user.tgId,
      `⏱ Просрочка по доске <b>${rental.board.code}</b> закрыта.\n` +
      `Покрыто: <b>${fmtDuration(result.closedMinutes)}</b>. Аренда продолжается.`
    );
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ ${e.message}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Назад", "admin:returns"),
    });
  }
});

/** Подтверждение продления от админа — мгновенное применение */
extensionsHandlers.callbackQuery(/^admin:extend_confirm:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);
  const tariffId = parseInt(ctx.match[2]);

  const extensionTariff = await prisma.tariff.findUniqueOrThrow({ where: { id: tariffId } });
  const minutes = extensionTariff.durationMinutes;

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, tariff: true, user: true },
  });

  try {
    const result = await rentalService.extendRental(rentalId, minutes, ctx.dbUser!.id, extensionTariff.price);
    const totalMin = (rental.tariff?.durationMinutes ?? 0) + (rental.extraMinutes ?? 0) + minutes;
    const client = escapeHtml(rental.clientName ?? rental.user.name);

    let msg = `✅ Аренда доски <b>${rental.board.code}</b> продлена!\n`;
    msg += `👤 Клиент: ${client}\n`;
    msg += `⏱ Добавлено: <b>${fmtDuration(minutes)}</b> — ${fmtPrice(extensionTariff.price)}\n`;
    if (result.overdueMinutes > 0) {
      msg += `⚠️ Покрыто просрочки: <b>${fmtDuration(result.overdueMinutes)}</b>\n`;
      msg += `✅ Чистое время: <b>${fmtDuration(result.netMinutes)}</b>\n`;
    }
    msg += `Общая длительность: <b>${fmtDuration(totalMin)}</b>`;

    await ctx.editMessageText(msg, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🔄 Возвраты", "admin:returns")
        .text("🏄 Доски", "admin:boards")
        .row()
        .text("⬅️ Меню", "back:menu"),
    });

    let clientMsg = `⏱ Ваша аренда доски <b>${rental.board.code}</b> продлена на <b>${fmtDuration(minutes)}</b> (${fmtPrice(extensionTariff.price)})!\n`;
    if (result.overdueMinutes > 0) {
      clientMsg += `⚠️ Из них покрыто просрочки: ${fmtDuration(result.overdueMinutes)}\n`;
    }
    clientMsg += `Общая длительность: <b>${fmtDuration(totalMin)}</b>. Приятного катания! 🌊`;
    await notify(ctx.api, rental.user.tgId, clientMsg);
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ ${e.message}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Назад", "admin:returns"),
    });
  }
});
