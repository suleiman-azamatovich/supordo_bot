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
import { notify } from "../../services/notify";
import { BoardStatus, PaymentProofStatus } from "@prisma/client";

export const boardsHandlers = new Composer<BotContext>();

/** Список досок с пагинацией, статистикой и таймерами */
boardsHandlers.callbackQuery(/^admin:boards(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");

  const boards = await prisma.board.findMany({
    include: {
      rentals: {
        where: { status: { in: ["CREATED", "WAIT_PAYMENT", "WAIT_ADMIN", "RENTED", "WAIT_RETURN"] } },
        include: { user: true, tariff: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: { code: "asc" },
  });

  const totalBoards = boards.length;
  const available = boards.filter((b) => b.status === BoardStatus.AVAILABLE).length;
  const service = boards.filter((b) => b.status === BoardStatus.SERVICE).length;

  // Считаем по статусам аренд (для RENTED досок)
  let paying = 0, active = 0, waitReturn = 0;
  for (const b of boards) {
    if (b.status !== BoardStatus.RENTED) continue;
    const r = b.rentals[0];
    if (!r) continue;
    if (["CREATED", "WAIT_PAYMENT", "WAIT_ADMIN"].includes(r.status)) paying++;
    else if (r.status === "WAIT_RETURN") waitReturn++;
    else active++;
  }

  const paged = paginate(boards, page, 5);

  let text = `🏄 <b>Доски</b> (${totalBoards})\n\n`;
  text += `✅ — свободна (${available})\n`;
  text += `💳 — ожидает оплаты (${paying})\n`;
  text += `🔵 — в аренде (${active})\n`;
  text += `⏰ — ожидает возврата (${waitReturn})\n`;
  text += `🔧 — обслуживание (${service})`;

  const kb = new InlineKeyboard();
  const now = new Date();
  for (const b of paged.items) {
    const rental = b.rentals[0];
    const hasWaitReturn = rental?.status === "WAIT_RETURN";
    let icon: string, timeInfo = "";
    if (b.status === BoardStatus.AVAILABLE) {
      icon = "✅";
    } else if (b.status === BoardStatus.SERVICE) {
      icon = "🔧";
    } else if (rental && ["CREATED", "WAIT_PAYMENT", "WAIT_ADMIN"].includes(rental.status)) {
      icon = "💳";
    } else if (b.status === BoardStatus.RENTED && rental?.startAt && rental?.tariff) {
      const totalMin = rental.tariff.durationMinutes + (rental.extraMinutes ?? 0);
      const endAt = new Date(rental.startAt.getTime() + totalMin * 60_000);
      if (hasWaitReturn) {
        const overdue = Math.ceil((now.getTime() - endAt.getTime()) / 60_000);
        icon = "⏰";
        timeInfo = overdue > 0 ? ` +${fmtDuration(overdue)}` : "";
      } else {
        const remaining = Math.max(0, Math.ceil((endAt.getTime() - now.getTime()) / 60_000));
        icon = "🔵";
        timeInfo = ` ${fmtDuration(remaining)}`;
      }
    } else if (b.status === BoardStatus.RENTED) {
      icon = hasWaitReturn ? "⏰" : "🔵";
    } else {
      icon = "📅";
    }
    kb.text(`${icon} ${b.code}${timeInfo}`, `admin:board_detail:${b.id}`).row();
  }

  addPaginationRow(kb, paged.page, paged.totalPages, "admin:boards:");
  kb.row().text("🔄 Обновить", `admin:boards:${paged.page}`).text("⬅️ Меню", "back:menu");
  kb.row().text("🧹 Убрать лишнее", "clear:chat");

  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch (e: any) {
    if (!e.description?.includes("message is not modified")) throw e;
  }
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
        where: { status: { in: ["CREATED", "WAIT_PAYMENT", "WAIT_ADMIN", "RENTED", "WAIT_RETURN"] } },
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
    kb.text("➕ Выдать клиенту", `walkin:board:${board.id}`).row();
    kb.text("🔧 Заблокировать", `board:service:${board.id}`).row();

  } else if (board.status === BoardStatus.SERVICE) {
    text = `🔧 <b>${board.code}</b> — заблокирована\n\nДоска недоступна для клиентов.`;
    kb.text("✅ Разблокировать", `board:available:${board.id}`).row();

  } else if (board.status === BoardStatus.RENTED) {
    const rental = board.rentals[0];
    if (rental) {
      const client = escapeHtml(rental.clientName ?? rental.user.name);

      // Аренда в стадии оплаты (💳)
      if (["CREATED", "WAIT_PAYMENT", "WAIT_ADMIN"].includes(rental.status)) {
        text = `💳 <b>${board.code}</b> — ожидает оплаты\n\n`;
        text += `👤 Клиент: <b>${client}</b>\n`;
        if (rental.tariff) {
          text += `💰 Тариф: ${rental.tariff.name} — ${fmtPrice(rental.tariff.price)}\n`;
        }
        text += `📅 Создана: ${fmtDate(rental.createdAt)}\n`;

        if (rental.status === "CREATED" || rental.status === "WAIT_PAYMENT") {
          text += `\n⏳ <i>Клиент ещё не отправил чек оплаты.</i>`;
        } else {
          // WAIT_ADMIN — ищем отправленный чек
          const proof = await prisma.paymentProof.findFirst({
            where: { kind: "RENTAL", refId: rental.id, status: PaymentProofStatus.SUBMITTED },
            orderBy: { createdAt: "desc" },
          });
          if (proof) {
            text += `\n📎 <b>Чек оплаты #${proof.id}</b> — ожидает проверки\n`;
            text += `💰 Сумма: <b>${fmtPrice(proof.amount)}</b>\n`;
            kb.text(`✅ Подтвердить`, `pay:approve:${proof.id}`)
              .text(`❌ Отклонить`, `pay:reject:${proof.id}`)
              .row();
          } else {
            text += `\n⏳ <i>Ожидает подтверждения администратора.</i>`;
          }
        }

        // Активная аренда (🔵 / ⏰)
      } else {
        text = `🔵 <b>${board.code}</b> — в аренде\n\n`;
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
          kb.text("📩 Напомнить о возврате", `admin:remind_return:${rental.id}`).row();
        } else if (rental.status === "RENTED") {
          kb.text("📩 Напомнить клиенту", `admin:remind_active:${rental.id}`).row();
        }
        kb.text("⏱ Продлить", `admin:extend:${rental.id}`).row();
        kb.text("✅ Принять доску", `return:confirm:${rental.id}`).row();
        kb.text("✉️ Написать клиенту", `admin:board_msg:${rental.id}`).row();
      }
    } else {
      text = `💳 <b>${board.code}</b> — в аренде (данные не найдены)`;
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

/** Напоминание клиенту о возврате доски */
boardsHandlers.callbackQuery(/^admin:remind_return:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, user: true, tariff: true },
  });

  const overdue = await rentalService.getOverdueMinutes(rental);
  const cost = overdue > 0 ? overdue * rentalService.OVERDUE_RATE_PER_MIN : 0;

  let msg = `⏰ <b>Напоминание о возврате</b>\n\n`;
  msg += `Уважаемый клиент, время аренды доски <b>${rental.board.code}</b> истекло.\n`;
  msg += `Пожалуйста, верните доску на точку проката.\n`;
  if (cost > 0) {
    msg += `\n⚠️ Каждая минута просрочки — <b>${rentalService.OVERDUE_RATE_PER_MIN} сом</b>.`;
    msg += `\nТекущая просрочка: <b>${fmtDuration(overdue)} — ${fmtPrice(cost)}</b>.`;
  }
  msg += `\n\nСпасибо за понимание! 🙏`;

  try {
    await notify(ctx.api, Number(rental.user.tgId), msg);
    await ctx.answerCallbackQuery({ text: "📩 Напоминание отправлено клиенту", show_alert: true });
  } catch {
    await ctx.answerCallbackQuery({ text: "⚠️ Не удалось отправить напоминание", show_alert: true });
  }
});

/** Напоминание клиенту во время активной аренды (без просрочки) */
boardsHandlers.callbackQuery(/^admin:remind_active:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, user: true, tariff: true },
  });

  let remaining = 0;
  if (rental.startAt && rental.tariff) {
    const totalMin = rental.tariff.durationMinutes + (rental.extraMinutes ?? 0);
    const endAt = new Date(rental.startAt.getTime() + totalMin * 60_000);
    remaining = Math.max(0, Math.ceil((endAt.getTime() - Date.now()) / 60_000));
  }

  let msg = `🏄 <b>Напоминание</b>\n\n`;
  msg += `Уважаемый клиент, напоминаем — вы арендуете доску <b>${rental.board.code}</b>.\n`;
  if (remaining > 0) {
    msg += `⏳ Осталось: <b>${fmtDuration(remaining)}</b>.\n`;
  }
  msg += `\nПожалуйста, рассчитывайте время и возвращайтесь на берег вовремя. 🙏`;

  try {
    await notify(ctx.api, Number(rental.user.tgId), msg);
    await ctx.answerCallbackQuery({ text: "📩 Напоминание отправлено", show_alert: true });
  } catch {
    await ctx.answerCallbackQuery({ text: "⚠️ Не удалось отправить", show_alert: true });
  }
});

/** Админ хочет написать сообщение клиенту конкретной доски */
boardsHandlers.callbackQuery(/^admin:board_msg:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true },
  });

  ctx.session.boardMsgRentalId = rentalId;

  await ctx.editMessageText(
    `✉️ Напишите сообщение для клиента доски <b>${rental.board.code}</b>.\n\n` +
    `<i>Введите текст ниже — он будет отправлен клиенту.</i>`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("❌ Отмена", `admin:board_detail:${rental.boardId}`),
    }
  );
});

/** Обработка текста — отправка сообщения клиенту доски */
boardsHandlers.on("message:text", async (ctx, next) => {
  const rentalId = ctx.session.boardMsgRentalId;
  if (!rentalId) return next();

  ctx.session.boardMsgRentalId = undefined;
  const text = ctx.message.text;

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, user: true },
  });

  const adminName = ctx.dbUser?.name ?? "Администратор";

  await notify(
    ctx.api,
    Number(rental.user.tgId),
    `📢 <b>Сообщение от администрации</b>\n\n` +
    `🏄 Доска: <b>${rental.board.code}</b>\n\n` +
    `${escapeHtml(text)}`
  );

  await ctx.reply(
    `✅ Сообщение отправлено клиенту <b>${escapeHtml(rental.user.name)}</b> (доска ${rental.board.code}).`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🏄 К доске", `admin:board_detail:${rental.boardId}`)
        .text("⬅️ Меню", "back:menu"),
    }
  );
});
