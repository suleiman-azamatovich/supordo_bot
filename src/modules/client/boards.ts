/**
 * Просмотр досок клиентом.
 *
 * Обрабатывает:
 *  - client:boards — список всех досок с пагинацией
 *  - client:board_info — детали занятой/заблокированной доски
 *  - client:rent_board — переход к аренде свободной доски
 *
 * Клиент видит статус каждой доски (свободна / в аренде / обслуживание)
 * и может начать аренду прямо из списка или отсканировав QR-код.
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import { BoardStatus, RentalStatus } from "@prisma/client";
import { paginate, addPaginationRow, fmtDate, fmtDuration } from "../../ui/helpers";
import { handleRentalByQR } from "./helpers";

export const boardsHandlers = new Composer<BotContext>();

/** Список всех досок с пагинацией и кнопками аренды */
boardsHandlers.callbackQuery(/^client:boards(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");

  const boards = await prisma.board.findMany({
    include: {
      rentals: {
        where: { status: { in: ["RENTED", "WAIT_RETURN"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: { code: "asc" },
  });

  const paged = paginate(boards, page, 10);
  const freeCount = boards.filter((b) => b.status === BoardStatus.AVAILABLE).length;

  let text = `🏄 <b>Доски</b> (свободных: ${freeCount} из ${boards.length})\n\n`;
  text += `📷 <i>На каждой доске есть QR-код — отсканируйте его камерой телефона, чтобы начать аренду!</i>`;

  const kb = new InlineKeyboard();
  for (const b of paged.items) {
    const hasWaitReturn = b.rentals[0]?.status === "WAIT_RETURN";
    let icon: string, label: string;
    if (b.status === BoardStatus.AVAILABLE) {
      icon = "✅"; label = "свободна";
    } else if (b.status === BoardStatus.SERVICE) {
      icon = "🔧"; label = "на обслуживании";
    } else if (b.status === BoardStatus.RENTED && hasWaitReturn) {
      icon = "⏰"; label = "ожидает возврата";
    } else if (b.status === BoardStatus.RENTED) {
      icon = "🔴"; label = "в аренде";
    } else {
      icon = "📅"; label = "забронирована";
    }
    if (b.status === BoardStatus.AVAILABLE) {
      kb.text(`${icon} ${b.code} — ${label}`, `client:rent_board:${b.code}`).row();
    } else {
      kb.text(`${icon} ${b.code} — ${label}`, `client:board_info:${b.id}`).row();
    }
  }
  addPaginationRow(kb, paged.page, paged.totalPages, "client:boards:");
  kb.row().text("🔤 Ввести код доски", "client:enter_code");
  kb.row().text("⬅️ Меню", "back:menu");

  text += `\n\n💡 <i>Также можно отсканировать QR-код на доске камерой телефона — бот откроется автоматически!</i>`;

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/** Детали занятой/заблокированной доски (ориентировочное время освобождения) */
boardsHandlers.callbackQuery(/^client:board_info:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const boardId = parseInt(ctx.match[1]);
  const board = await prisma.board.findUniqueOrThrow({ where: { id: boardId } });

  let text = `ℹ️ <b>${board.code}</b>\n\n`;

  if (board.status === BoardStatus.RENTED) {
    const rental = await prisma.rental.findFirst({
      where: { boardId: board.id, status: { in: [RentalStatus.RENTED, RentalStatus.WAIT_RETURN] } },
      include: { tariff: true },
      orderBy: { startAt: "desc" },
    });
    if (rental?.startAt && rental.tariff) {
      const totalMin = rental.tariff.durationMinutes + (rental.extraMinutes ?? 0);
      const freeAt = new Date(rental.startAt.getTime() + totalMin * 60_000);
      text += `🔴 Сейчас в аренде.\nОриентировочно освободится: <b>${fmtDate(freeAt)}</b>`;
    } else {
      text += `🔴 Сейчас в аренде.`;
    }
  } else if (board.status === BoardStatus.BOOKED) {
    text += `📅 Забронирована.`;
  } else if (board.status === BoardStatus.SERVICE) {
    text += `🔧 На обслуживании. Временно недоступна.`;
  }

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text("⬅️ К доскам", "client:boards").row().text("⬅️ Меню", "back:menu"),
  });
});

/** Кнопка «Арендовать» из списка досок → переход к потоку аренды */
boardsHandlers.callbackQuery(/^client:rent_board:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const boardCode = ctx.match[1];
  return handleRentalByQR(ctx, boardCode);
});
