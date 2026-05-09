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
  escapeHtml, paginate, addPaginationRow, staffRoleLabel,
} from "../../ui/helpers";
import * as rentalService from "../../services/rental";
import { notify } from "../../services/notify";
import { BoardStatus, PaymentProofStatus } from "@prisma/client";

export const boardsHandlers = new Composer<BotContext>();

/** Список досок с пагинацией, статистикой и таймерами */
boardsHandlers.callbackQuery(/^admin:boards(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");

  const spotId = ctx.dbUser?.spotId ?? undefined;
  const boards = await prisma.board.findMany({
    where: spotId ? { spotId } : undefined,
    include: {
      rentals: {
        where: { status: { in: ["CREATED", "WAIT_PAYMENT", "WAIT_ADMIN", "RENTED", "WAIT_RETURN"] } },
        include: { user: true, tariff: true, seller: true },
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

  const paged = paginate(boards, page, 10);

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
    // Пробрасываем текущую страницу — чтобы из карточки можно было вернуться сюда
    kb.text(`${icon} ${b.code}${timeInfo}`, `admin:board_detail:${b.id}:${paged.page}`).row();
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
boardsHandlers.callbackQuery(/^admin:board_detail:(\d+)(?::(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const boardId = parseInt(ctx.match[1]);
  // Страница списка, с которой пришли — чтобы вернуть на неё кнопкой «К доскам»
  const fromPage = ctx.match[2] ? parseInt(ctx.match[2]) : undefined;

  const board = await prisma.board.findUniqueOrThrow({
    where: { id: boardId },
    include: {
      rentals: {
        where: { status: { in: ["CREATED", "WAIT_PAYMENT", "WAIT_ADMIN", "RENTED", "WAIT_RETURN"] } },
        include: { user: true, tariff: true, seller: true },
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
        const isWalkinPay = !!rental.sellerUserId;
        text = `💳 <b>${board.code}</b> — ожидает оплаты\n\n`;
        text += `👤 Клиент: <b>${client}</b>\n`;
        if (isWalkinPay && rental.seller) {
          text += `🛡 Оформил: <b>${escapeHtml(rental.seller.name)}</b> <i>[${staffRoleLabel(rental.seller.role)}]</i>\n`;
        }
        if (rental.tariff) {
          const listPrice = rental.tariffPriceKgs ?? rental.tariff.price;
          const originalPrice = rental.tariffOriginalPriceKgs;
          const netPrice = rental.basePriceKgs ?? listPrice;
          if (originalPrice && originalPrice > listPrice) {
            text += `🎁 Акция: <s>${fmtPrice(originalPrice)}</s> → <b>${fmtPrice(listPrice)}</b>\n`;
          }
          if ((rental.discountPercent ?? 0) > 0) {
            text += `💰 Тариф: ${rental.tariff.name} — <s>${fmtPrice(listPrice)}</s> → <b>${fmtPrice(netPrice)}</b> 🎁 −${rental.discountPercent}%\n`;
          } else {
            text += `💰 Тариф: ${rental.tariff.name} — ${fmtPrice(netPrice)}\n`;
          }
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
        const isWalkin = !!rental.sellerUserId;
        text = isWalkin
          ? `👤 <b>${board.code}</b> — выдана на месте\n\n`
          : `🔵 <b>${board.code}</b> — в аренде\n\n`;
        text += `👤 Клиент: <b>${client}</b>\n`;
        if (isWalkin && rental.seller) {
          text += `🛡 Выдал: <b>${escapeHtml(rental.seller.name)}</b> <i>[${staffRoleLabel(rental.seller.role)}]</i>\n`;
        }
        if (rental.startAt) text += `⏱ Старт: ${fmtDate(rental.startAt)}\n`;
        if (rental.tariff) {
          const totalMin = rental.tariff.durationMinutes + (rental.extraMinutes ?? 0);
          const listPrice = rental.tariffPriceKgs ?? rental.tariff.price;
          const originalPrice = rental.tariffOriginalPriceKgs;
          const netPrice = rental.basePriceKgs ?? listPrice;
          if (originalPrice && originalPrice > listPrice) {
            text += `🎁 Акция: <s>${fmtPrice(originalPrice)}</s> → <b>${fmtPrice(listPrice)}</b>\n`;
          }
          if ((rental.discountPercent ?? 0) > 0) {
            text += `💰 Тариф: ${rental.tariff.name} — <s>${fmtPrice(listPrice)}</s> → <b>${fmtPrice(netPrice)}</b> 🎁 −${rental.discountPercent}%\n`;
          } else {
            text += `💰 Тариф: ${rental.tariff.name} — ${fmtPrice(netPrice)}\n`;
          }
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

        if (isWalkin) {
          text += `\n📵 <i>Клиент без Telegram — связь только лично на точке.</i>\n`;
        }

        // Сумма просрочки — нужна для текста и для кнопок завершения
        let overdueCost = 0;
        if (rental.status === "WAIT_RETURN") {
          const overdueMin = await rentalService.getOverdueMinutes(rental);
          if (overdueMin > 0) {
            const overdueRate = await rentalService.getOverdueRate();
            overdueCost = overdueMin * overdueRate;
            text += `⚠️ <b>Просрочка: ${fmtDuration(overdueMin)} — ${fmtPrice(overdueCost)}</b> (${overdueRate} сом/мин)\n`;
          }
          if (!isWalkin) {
            kb.text("📩 Напомнить о возврате", `admin:remind_return:${rental.id}`).row();
          }
        } else if (rental.status === "RENTED" && !isWalkin) {
          kb.text("📩 Напомнить клиенту", `admin:remind_active:${rental.id}`).row();
        }
        kb.text("⏱ Продлить", `admin:extend:${rental.id}`).row();
        const hasDiscount = (rental.discountPercent ?? 0) > 0;
        const discountBtnLabel = hasDiscount
          ? `🎁 Изменить скидку (−${rental.discountPercent}%)`
          : "🎁 Выдать скидку";
        kb.text(discountBtnLabel, `admin:board_discount:${rental.id}`).row();

        // Завершение аренды:
        //  - если есть просрочка → две кнопки прямо в карточке (без промежуточного confirm),
        //    каждая сразу завершает аренду по своему сценарию
        //  - иначе → одна кнопка «Принять доску» с экраном подтверждения
        if (overdueCost > 0) {
          kb.text("✅ Закрыть без оплаты", `return:complete:${rental.id}`).row();
          if (isWalkin) {
            kb.text(`💵 Закрыть с оплатой (наличные ${fmtPrice(overdueCost)})`, `return:cash:${rental.id}`).row();
          } else {
            kb.text(`💰 Закрыть с оплатой (счёт ${fmtPrice(overdueCost)})`, `return:invoice:${rental.id}`).row();
          }
        } else {
          kb.text("✅ Принять доску", `return:confirm:${rental.id}`).row();
        }

        if (!isWalkin) {
          kb.text("✉️ Написать клиенту", `admin:board_msg:${rental.id}`).row();
        }
      }
    } else {
      text = `💳 <b>${board.code}</b> — в аренде (данные не найдены)`;
    }
  }

  // Возврат на ту же страницу списка, с которой пришли
  const backToBoardsCb = fromPage ? `admin:boards:${fromPage}` : "admin:boards";
  kb.text("⬅️ К доскам", backToBoardsCb).row();
  kb.text("⬅️ Меню", "back:menu");

  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch (e: any) {
    if (!e.description?.includes("message is not modified")) throw e;
  }
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
  const overdueRate = await rentalService.getOverdueRate();
  const cost = overdue > 0 ? overdue * overdueRate : 0;

  let msg = `⏰ <b>Напоминание о возврате</b>\n\n`;
  msg += `Уважаемый клиент, время аренды доски <b>${rental.board.code}</b> истекло.\n`;
  msg += `Пожалуйста, верните доску на точку проката.\n`;
  if (cost > 0) {
    msg += `\n⚠️ Каждая минута просрочки — <b>${overdueRate} сом</b>.`;
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

/** Меню выдачи скидки на активную аренду */
boardsHandlers.callbackQuery(/^admin:board_discount:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);
  ctx.session.rentalDiscountDraft = undefined;
  ctx.session.inputMode = undefined;

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, tariff: true },
  });

  const listPrice = rental.tariffPriceKgs ?? rental.tariff?.price ?? 0;
  const currentBase = rental.basePriceKgs ?? listPrice;
  const currentSaved = listPrice - currentBase;
  const hasDiscount = currentSaved > 0;

  let text = hasDiscount
    ? `🎁 <b>Изменить скидку — аренда #${rental.id}</b>\n\n`
    : `🎁 <b>Выдать скидку — аренда #${rental.id}</b>\n\n`;
  text += `🏄 Доска: <b>${rental.board.code}</b>\n`;
  if (rental.tariff) {
    text += `⏱ Тариф: ${rental.tariff.name}  ·  💰 Прайс: ${fmtPrice(listPrice)}\n`;
  }
  if (currentSaved > 0) {
    const pct = rental.discountPercent ?? 0;
    const pctLabel = pct > 0 ? ` −${pct}%` : "";
    text += `✅ Текущая скидка:${pctLabel} <b>−${fmtPrice(currentSaved)}</b>  →  к оплате: <b>${fmtPrice(currentBase)}</b>\n`;
  } else {
    text += `<i>Скидка ещё не установлена.</i>\n`;
  }

  const kb = new InlineKeyboard();
  // Пресеты
  for (const pct of [10, 20, 30]) {
    const discounted = Math.round(listPrice * (100 - pct) / 100);
    kb.text(`${pct}%  (${fmtPrice(discounted)})`, `admin:bd_pct:${rentalId}:${pct}`);
  }
  kb.row();
  kb.text("✏️ Свой %", `admin:bd_custom_pct:${rentalId}`)
    .text("💰 Сумма (сом)", `admin:bd_custom_amt:${rentalId}`).row();
  if (currentSaved > 0) {
    kb.text("❌ Убрать скидку", `admin:bd_pct:${rentalId}:0`).row();
  }
  kb.text("⬅️ К доске", `admin:board_detail:${rental.boardId}`);

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/** Применить пресет (или сброс) скидки по проценту */
boardsHandlers.callbackQuery(/^admin:bd_pct:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);
  const pct = parseInt(ctx.match[2]);

  try {
    const rental = await prisma.rental.findUniqueOrThrow({
      where: { id: rentalId },
      include: { board: true, user: true, tariff: true },
    });

    const { basePriceKgs, discountPercent, savedKgs } =
      await rentalService.applyRentalDiscount(rentalId, { type: "percent", value: pct }, ctx.dbUser!.id);

    // Уведомляем клиента
    const prevSaved = (rental.tariffPriceKgs ?? rental.tariff?.price ?? 0) - (rental.basePriceKgs ?? rental.tariffPriceKgs ?? rental.tariff?.price ?? 0);
    const hadDiscount = prevSaved > 0;
    if (!rental.sellerUserId && rental.user.tgId) {
      const listPrice = rental.tariffPriceKgs ?? rental.tariff?.price ?? 0;
      if (savedKgs > 0) {
        const pctLabel = discountPercent > 0 ? ` (−${discountPercent}%)` : "";
        const title = hadDiscount
          ? `🎁 <b>Администратор обновил вашу скидку!</b>`
          : `🎁 <b>Администратор выдал вам скидку!</b>`;
        await notify(
          ctx.api,
          Number(rental.user.tgId),
          `${title}\n\n` +
          `🏄 Доска: <b>${rental.board.code}</b>\n` +
          `💰 Прайс: ${fmtPrice(listPrice)}\n` +
          `🎁 Скидка${pctLabel}: <b>−${fmtPrice(savedKgs)}</b>\n` +
          `✅ К оплате: <b>${fmtPrice(basePriceKgs)}</b>`,
        );
      } else {
        await notify(
          ctx.api,
          Number(rental.user.tgId),
          `ℹ️ Скидка на аренду доски <b>${rental.board.code}</b> отменена.\n` +
          `💰 К оплате: <b>${fmtPrice(basePriceKgs)}</b>`,
        );
      }
    }

    const pctLabel = discountPercent > 0 ? ` (−${discountPercent}%)` : "";
    const msg = savedKgs > 0
      ? `✅ Скидка${pctLabel} <b>−${fmtPrice(savedKgs)}</b> применена. К оплате: <b>${fmtPrice(basePriceKgs)}</b>`
      : `✅ Скидка снята. К оплате: <b>${fmtPrice(basePriceKgs)}</b>`;

    await ctx.editMessageText(msg, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🎁 Изменить скидку", `admin:board_discount:${rentalId}`)
        .text("⬅️ К доске", `admin:board_detail:${rental.boardId}`),
    });
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ ${escapeHtml(e.message ?? "Ошибка")}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Назад", `admin:board_discount:${rentalId}`),
    });
  }
});

/** Запрос кастомного процента */
boardsHandlers.callbackQuery(/^admin:bd_custom_pct:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);
  ctx.session.rentalDiscountDraft = { rentalId };
  ctx.session.inputMode = "rental_discount_pct";

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, tariff: true },
  });
  const listPrice = rental.tariffPriceKgs ?? rental.tariff?.price ?? 0;

  await ctx.editMessageText(
    `✏️ <b>Скидка в процентах</b>\n\n` +
    `🏄 Доска: <b>${rental.board.code}</b>  ·  Прайс: ${fmtPrice(listPrice)}\n\n` +
    `Введите процент скидки от <b>1</b> до <b>100</b>:`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("❌ Отмена", `admin:board_discount:${rentalId}`),
    }
  );
});

/** Запрос кастомной суммы в сомах */
boardsHandlers.callbackQuery(/^admin:bd_custom_amt:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);
  ctx.session.rentalDiscountDraft = { rentalId };
  ctx.session.inputMode = "rental_discount_amt";

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, tariff: true },
  });
  const listPrice = rental.tariffPriceKgs ?? rental.tariff?.price ?? 0;

  await ctx.editMessageText(
    `💰 <b>Скидка в сомах</b>\n\n` +
    `🏄 Доска: <b>${rental.board.code}</b>  ·  Прайс: ${fmtPrice(listPrice)}\n\n` +
    `Введите сумму скидки в сомах (не более ${fmtPrice(listPrice)}):`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("❌ Отмена", `admin:board_discount:${rentalId}`),
    }
  );
});

/** Обработка текста — ввод скидки или отправка сообщения клиенту доски */
boardsHandlers.on("message:text", async (ctx, next) => {
  // ── Ввод кастомной скидки на аренду ──
  const inputMode = ctx.session.inputMode;
  const discountDraft = ctx.session.rentalDiscountDraft;

  if ((inputMode === "rental_discount_pct" || inputMode === "rental_discount_amt") && discountDraft) {
    ctx.session.inputMode = undefined;
    ctx.session.rentalDiscountDraft = undefined;
    const raw = ctx.message.text.trim().replace(/\s+/g, "");
    const val = parseFloat(raw);

    if (isNaN(val) || val < 0) {
      return ctx.reply("⚠️ Введите корректное положительное число.", {
        reply_markup: new InlineKeyboard().text("⬅️ К аренде", `admin:board_discount:${discountDraft.rentalId}`),
      });
    }

    if (inputMode === "rental_discount_pct" && val > 100) {
      return ctx.reply("⚠️ Процент не может превышать 100.", {
        reply_markup: new InlineKeyboard().text("⬅️ Назад", `admin:board_discount:${discountDraft.rentalId}`),
      });
    }

    try {
      const rental = await prisma.rental.findUniqueOrThrow({
        where: { id: discountDraft.rentalId },
        include: { board: true, user: true, tariff: true },
      });

      const discount = inputMode === "rental_discount_pct"
        ? { type: "percent" as const, value: Math.round(val) }
        : { type: "amount" as const, value: Math.round(val) };

      const { basePriceKgs, discountPercent, savedKgs } =
        await rentalService.applyRentalDiscount(discountDraft.rentalId, discount, ctx.dbUser!.id);

      // Уведомляем клиента если он пришёл через Telegram
      if (!rental.sellerUserId && rental.user.tgId) {
        const listPrice = rental.tariffPriceKgs ?? rental.tariff?.price ?? 0;
        const pctLabel = discountPercent > 0 ? ` (−${discountPercent}%)` : "";
        await notify(
          ctx.api,
          Number(rental.user.tgId),
          `🎁 <b>Администратор выдал вам скидку!</b>\n\n` +
          `🏄 Доска: <b>${rental.board.code}</b>\n` +
          `💰 Прайс: ${fmtPrice(listPrice)}\n` +
          `🎁 Скидка${pctLabel}: <b>−${fmtPrice(savedKgs)}</b>\n` +
          `✅ К оплате: <b>${fmtPrice(basePriceKgs)}</b>`,
        );
      }

      const pctLabel = discountPercent > 0 ? ` (−${discountPercent}%)` : "";
      await ctx.reply(
        `✅ <b>Скидка применена!</b>\n\n` +
        `🏄 Доска: <b>${rental.board.code}</b>\n` +
        `🎁 Скидка${pctLabel}: <b>−${fmtPrice(savedKgs)}</b>\n` +
        `💳 Новая сумма: <b>${fmtPrice(basePriceKgs)}</b>`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("⬅️ К доске", `admin:board_detail:${rental.boardId}`)
            .text("⬅️ Доски", "admin:boards"),
        }
      );
    } catch (e: any) {
      await ctx.reply(`⚠️ Ошибка: ${escapeHtml(e.message ?? "неизвестно")}`);
    }
    return;
  }

  // ── Отправка сообщения клиенту доски ──
  const rentalId = ctx.session.boardMsgRentalId;
  if (!rentalId) return next();

  ctx.session.boardMsgRentalId = undefined;
  const text = ctx.message.text;

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, user: true },
  });

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
