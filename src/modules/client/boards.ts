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
  const myTgId = ctx.dbUser?.tgId;

  const spotId = ctx.dbUser?.spotId ?? undefined;
  const boards = await prisma.board.findMany({
    where: spotId ? { spotId } : undefined,
    include: {
      rentals: {
        where: { status: { in: ["CREATED", "WAIT_PAYMENT", "WAIT_ADMIN", "RENTED", "WAIT_RETURN"] } },
        select: {
          id: true,
          status: true,
          user: { select: { tgId: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: { code: "asc" },
  });

  const paged = paginate(boards, page);
  const freeCount = boards.filter((b) => b.status === BoardStatus.AVAILABLE).length;

  let text = `🏄 <b>Доски</b> (свободных: ${freeCount} из ${boards.length})\n\n`;
  text += `👇 Нажмите на свободную доску (✅), чтобы арендовать.\n`;
  text += `Или отсканируйте 📷 QR-код на доске.\n`;

  const kb = new InlineKeyboard();
  for (const b of paged.items) {
    const rental = b.rentals[0];
    const isMine = rental && myTgId ? rental.user.tgId === myTgId : false;
    const mineTag = isMine ? " 👈 моя" : "";

    let icon: string, label: string;
    if (b.status === BoardStatus.AVAILABLE) {
      icon = "✅"; label = "свободна";
    } else if (b.status === BoardStatus.SERVICE) {
      icon = "🔧"; label = "на обслуживании";
    } else if (rental?.status === "WAIT_RETURN") {
      icon = "⏰"; label = "ожидает возврата";
    } else if (rental && ["CREATED", "WAIT_PAYMENT", "WAIT_ADMIN"].includes(rental.status)) {
      icon = "💳"; label = "ожидает оплаты";
    } else if (b.status === BoardStatus.RENTED) {
      icon = "🔵"; label = "в аренде";
    } else {
      icon = "📅"; label = "забронирована";
    }
    if (b.status === BoardStatus.AVAILABLE) {
      kb.text(`${icon} ${b.code} — ${label}`, `client:rent_board:${b.code}`).row();
    } else if (isMine && rental) {
      kb.text(`${icon} ${b.code} — ${label}${mineTag}`, `client:my_detail:${rental.id}`).row();
    } else {
      kb.text(`${icon} ${b.code} — ${label}${mineTag}`, `client:board_info:${b.id}`).row();
    }
  }
  addPaginationRow(kb, paged.page, paged.totalPages, "client:boards:");
  kb.row().text("🔄 Обновить", `client:boards:${paged.page}`).text("⬅️ Меню", "back:menu");
  kb.row().text("🧹 Убрать лишнее", "clear:chat");

  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch (e: any) {
    if (!e.description?.includes("message is not modified")) throw e;
  }
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
      if (freeAt.getTime() < Date.now()) {
        text += `🔵 Сейчас в аренде.\n⏰ Время аренды истекло — ожидается возврат.`;
      } else {
        text += `🔵 Сейчас в аренде.\nОриентировочно освободится: <b>${fmtDate(freeAt)}</b>`;
      }
    } else {
      text += `🔵 Сейчас в аренде.`;
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
