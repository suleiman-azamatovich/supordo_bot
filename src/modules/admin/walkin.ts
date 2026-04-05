/**
 * Walk-in аренда — выдача доски клиенту на месте (администратор).
 *
 * Обрабатывает 4-шаговый поток:
 *  1. seller:walkin — выбор свободной доски из списка
 *  2. walkin:board — выбор тарифа после выбора доски
 *  3. walkin:tariff — запрос имени клиента
 *  4. message:text — получение имени и создание аренды
 *
 * Walk-in аренда отличается от обычной:
 *  - Не требует оплаты через бот (наличные или терминал на месте)
 *  - Аренда сразу в статусе RENTED
 *  - Клиент указывается по имени (не привязан к Telegram)
 *  - В отчётах помечается как «👤 админ» (есть sellerUserId)
 *
 * Состояние walk-in хранится в ctx.session.walkin:
 *  - boardId: выбранная доска
 *  - tariffId: выбранный тариф
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import {
  fmtPrice, fmtDuration, fmtDate,
  escapeHtml, paginate, addPaginationRow,
} from "../../ui/helpers";
import * as rentalService from "../../services/rental";
import { BoardStatus, Role } from "@prisma/client";

export const walkinHandlers = new Composer<BotContext>();

/** Шаг 1: Выбор свободной доски */
walkinHandlers.callbackQuery(/^seller:walkin(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");
  const spotId = ctx.dbUser!.spotId;
  if (!spotId) {
    return ctx.editMessageText("⚠️ Вы не привязаны к точке.");
  }

  // Сбрасываем состояние walk-in
  ctx.session.walkin = undefined;

  const boards = await prisma.board.findMany({
    where: { spotId, status: BoardStatus.AVAILABLE },
    orderBy: { code: "asc" },
  });

  const paged = paginate(boards, page, 10);
  let text = `➕ <b>Выдать доску клиенту</b>\n\nВыберите доску:\n\n`;
  if (paged.items.length === 0) {
    text += "Нет свободных досок.";
  }

  const kb = new InlineKeyboard();
  for (const b of paged.items) {
    kb.text(`${b.code}`, `walkin:board:${b.id}`).row();
  }
  addPaginationRow(kb, paged.page, paged.totalPages, "seller:walkin:");
  kb.row().text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/** Шаг 2: Выбор тарифа после выбора доски */
walkinHandlers.callbackQuery(/^walkin:board:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const boardId = parseInt(ctx.match[1]);
  const spotId = ctx.dbUser!.spotId;
  if (!spotId) return;

  ctx.session.walkin = { boardId };

  const tariffs = await prisma.tariff.findMany({
    where: { spotId, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { durationMinutes: "asc" }],
  });

  const board = await prisma.board.findUniqueOrThrow({ where: { id: boardId } });

  let text = `➕ <b>Выдать доску клиенту</b>\n\nДоска: <b>${board.code}</b>\nВыберите тариф:\n`;

  const kb = new InlineKeyboard();
  for (const t of tariffs) {
    kb.text(`${t.name} — ${fmtPrice(t.price)}`, `walkin:tariff:${t.id}`).row();
  }
  kb.row().text("⬅️ Назад", "seller:walkin").text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/** Шаг 3: Запрос имени клиента текстом */
walkinHandlers.callbackQuery(/^walkin:tariff:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const tariffId = parseInt(ctx.match[1]);

  if (!ctx.session.walkin?.boardId) {
    return ctx.editMessageText("⚠️ Начните сначала.", {
      reply_markup: new InlineKeyboard().text("➕ Оформить аренду", "seller:walkin"),
    });
  }

  ctx.session.walkin.tariffId = tariffId;

  await ctx.editMessageText(
    "➕ <b>Выдать доску</b>\n\nВведите имя клиента (текстом):",
    { parse_mode: "HTML" }
  );
});

/**
 * Шаг 4: Получение имени клиента и создание аренды.
 *
 * Если сессия walkin не заполнена — пропускаем через next().
 * Создаёт аренду через rentalService.createWalkinRental.
 */
walkinHandlers.on("message:text", async (ctx, next) => {
  const w = ctx.session.walkin;
  if (!w?.boardId || !w?.tariffId) {
    return next();
  }

  const spotId = ctx.dbUser!.spotId;
  if (!spotId) return;

  const clientName = ctx.message.text.trim();
  if (!clientName || clientName.length > 100) {
    return ctx.reply("⚠️ Введите имя клиента (до 100 символов):");
  }

  try {
    const { rental, tariff } = await rentalService.createWalkinRental({
      sellerUserId: ctx.dbUser!.id,
      spotId,
      boardId: w.boardId,
      tariffId: w.tariffId,
      clientName,
    });

    const board = await prisma.board.findUniqueOrThrow({ where: { id: rental.boardId } });

    ctx.session.walkin = undefined;

    await ctx.reply(
      `✅ <b>Аренда оформлена</b>\n\n` +
      `Доска: ${board.code}\n` +
      `Тариф: ${tariff.name} — ${fmtPrice(tariff.price)}\n` +
      `Клиент: ${escapeHtml(clientName)}\n` +
      `Старт: ${fmtDate(rental.startAt!)}`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("➕ Ещё одну", "seller:walkin")
          .text("🔄 Возвраты", "admin:returns")
          .row()
          .text("⬅️ Меню", "back:menu"),
      }
    );
  } catch (e: any) {
    ctx.session.walkin = undefined;
    await ctx.reply(`⚠️ Ошибка: ${e.message}`);
  }
});
