/**
 * Управление досками (администратор).
 *
 * Обрабатывает:
 *  - admin:boards — список всех досок с пагинацией и статусами
 *  - admin:board_detail — детальная карточка доски с действиями
 *  - board:service — перевод доски на обслуживание (блокировка)
 *  - board:available — возврат доски в доступные (разблокировка)
 *
 * В отличие от клиентского просмотра, админ видит:
 *  - имя арендатора
 *  - оставшееся время / просрочку
 *  - кнопки управления (завершить, продлить, заблокировать)
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import {
  fmtPrice, fmtDuration, fmtDate,
  escapeHtml, paginate, addPaginationRow,
} from "../../ui/helpers";
import * as rentalService from "../../services/rental";
import { BoardStatus } from "@prisma/client";

export const boardsHandlers = new Composer<BotContext>();

/** Список досок с пагинацией, статистикой и таймерами */
boardsHandlers.callbackQuery(/^admin:boards(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");

  const boards = await prisma.board.findMany({
    include: {
      rentals: {
        where: { status: { in: ["RENTED", "WAIT_RETURN"] } },
        include: { user: true, tariff: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: { code: "asc" },
  });

  const totalBoards = boards.length;
  const available = boards.filter((b) => b.status === BoardStatus.AVAILABLE).length;
  const rented = boards.filter((b) => b.status === BoardStatus.RENTED).length;
  const service = boards.filter((b) => b.status === BoardStatus.SERVICE).length;

  const paged = paginate(boards, page, 10);

  let text = `🏄 <b>Доски</b>\n\n`;
  text += `Всего: <b>${totalBoards}</b> | ✅ ${available} | 🔴 ${rented} | 🔧 ${service}\n\n`;

  const kb = new InlineKeyboard();
  const now = new Date();
  for (const b of paged.items) {
    const rental = b.rentals[0];
    const hasWaitReturn = rental?.status === "WAIT_RETURN";
    let icon: string, label: string, timeInfo = "";
    if (b.status === BoardStatus.AVAILABLE) {
      icon = "✅"; label = "свободна";
    } else if (b.status === BoardStatus.SERVICE) {
      icon = "🔧"; label = "на обслуживании";
    } else if (b.status === BoardStatus.RENTED && rental?.startAt && rental?.tariff) {
      const totalMin = rental.tariff.durationMinutes + (rental.extraMinutes ?? 0);
      const endAt = new Date(rental.startAt.getTime() + totalMin * 60_000);
      if (hasWaitReturn) {
        const overdue = Math.ceil((now.getTime() - endAt.getTime()) / 60_000);
        icon = "⏰"; label = "ожидает возврата";
        timeInfo = overdue > 0 ? ` +${fmtDuration(overdue)}` : "";
      } else {
        const remaining = Math.max(0, Math.ceil((endAt.getTime() - now.getTime()) / 60_000));
        icon = "🔴"; label = `в аренде — ${fmtDuration(remaining)}`;
        timeInfo = ` ${fmtDuration(remaining)}`;
      }
    } else if (b.status === BoardStatus.RENTED) {
      icon = hasWaitReturn ? "⏰" : "🔴";
      label = hasWaitReturn ? "ожидает возврата" : "в аренде";
    } else {
      icon = "📅"; label = "забронирована";
    }
    text += `${icon} <b>${b.code}</b> — ${label}\n`;
    kb.text(`${icon} ${b.code}${timeInfo}`, `admin:board_detail:${b.id}`).row();
  }

  addPaginationRow(kb, paged.page, paged.totalPages, "admin:boards:");
  kb.row().text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/**
 * Детальная карточка доски.
 *
 * Действия зависят от статуса:
 *  - AVAILABLE → заблокировать
 *  - SERVICE → разблокировать
 *  - RENTED → принять возврат, продлить, завершить
 */
boardsHandlers.callbackQuery(/^admin:board_detail:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const boardId = parseInt(ctx.match[1]);

  const board = await prisma.board.findUniqueOrThrow({
    where: { id: boardId },
    include: {
      rentals: {
        where: { status: { in: ["RENTED", "WAIT_RETURN"] } },
        include: { user: true, tariff: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  const kb = new InlineKeyboard();
  let text = "";

  if (board.status === BoardStatus.AVAILABLE) {
    text = `✅ <b>${board.code}</b> — свободна\n\nДоска доступна для аренды клиентами.`;
    kb.text("🔧 Заблокировать", `board:service:${board.id}`).row();

  } else if (board.status === BoardStatus.SERVICE) {
    text = `🔧 <b>${board.code}</b> — заблокирована\n\nДоска недоступна для клиентов.`;
    kb.text("✅ Разблокировать", `board:available:${board.id}`).row();

  } else if (board.status === BoardStatus.RENTED) {
    const rental = board.rentals[0];
    if (rental) {
      const client = escapeHtml(rental.clientName ?? rental.user.name);
      text = `🔴 <b>${board.code}</b> — в аренде\n\n`;
      text += `👤 Клиент: <b>${client}</b>\n`;
      if (rental.startAt) text += `⏱ Старт: ${fmtDate(rental.startAt)}\n`;
      if (rental.tariff) {
        const totalMin = rental.tariff.durationMinutes + (rental.extraMinutes ?? 0);
        text += `💰 Тариф: ${rental.tariff.name} — ${fmtPrice(rental.tariff.price)}\n`;
        if (rental.startAt) {
          const endAt = new Date(rental.startAt.getTime() + totalMin * 60_000);
          const now = new Date();
          const remaining = Math.max(0, Math.ceil((endAt.getTime() - now.getTime()) / 60_000));
          if (rental.status === "WAIT_RETURN") {
            text += `⏰ <b>Время вышло! Ожидает возврата</b>\n`;
          } else if (remaining > 0) {
            text += `⏳ Осталось: <b>${fmtDuration(remaining)}</b>\n`;
          }
        }
      }

      if (rental.status === "WAIT_RETURN") {
        const overdue = await rentalService.getOverdueMinutes(rental);
        if (overdue > 0) {
          const cost = overdue * rentalService.OVERDUE_RATE_PER_MIN;
          text += `⚠️ <b>Просрочка: ${fmtDuration(overdue)} — ${fmtPrice(cost)}</b> (${rentalService.OVERDUE_RATE_PER_MIN} сом/мин)\n`;
        }
        kb.text("✅ Принять возврат", `seller:return:${rental.id}`).row();
        if (overdue > 0) {
          const cost = overdue * rentalService.OVERDUE_RATE_PER_MIN;
          kb.text(`🔄 Закрыть просрочку (${fmtDuration(overdue)} — ${fmtPrice(cost)})`, `admin:close_overdue:${rental.id}`).row();
        }
      }
      kb.text("⏱ Продлить", `admin:extend:${rental.id}`).row();
      kb.text("✅ Завершить аренду", `admin:complete_rental_confirm:${rental.id}`).row();
    } else {
      text = `🔴 <b>${board.code}</b> — в аренде (данные не найдены)`;
    }
  }

  kb.text("⬅️ К доскам", "admin:boards").row();
  kb.text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/** Блокировка доски (перевод в SERVICE) */
boardsHandlers.callbackQuery(/^board:(service|available):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const action = ctx.match[1];
  const boardId = parseInt(ctx.match[2]);
  const newStatus = action === "service" ? BoardStatus.SERVICE : BoardStatus.AVAILABLE;

  await prisma.board.update({ where: { id: boardId }, data: { status: newStatus } });

  await ctx.editMessageText(
    `✅ Доска #${boardId} переведена в статус ${newStatus}.`,
    {
      reply_markup: new InlineKeyboard()
        .text("🏄 Доски", "admin:boards")
        .text("⬅️ Меню", "back:menu"),
    }
  );
});
