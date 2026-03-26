import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../bot/context";
import { guardRole } from "../bot/middleware";
import { prisma } from "../db/prisma";
import { fmtDate, fmtPrice, fmtDuration, paginate, addPaginationRow } from "../ui/helpers";
import * as rentalService from "../services/rental";
import { notify } from "../services/notify";
import { RentalStatus, BoardStatus, Role } from "@prisma/client";

export const sellerModule = new Composer<BotContext>();

// Apply role guard to all seller handlers
sellerModule.use(guardRole(Role.SELLER, Role.ADMIN));

// ──────── Currently rented ────────
sellerModule.callbackQuery(/^seller:rented(:(\d+))?$/, async (ctx) => {
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
    const client = r.clientName ?? r.user.name;
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
          text += `   ⏰ <b>Время вышло! Ожидает возврата</b>\n`;
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

// ──────── Returns (same as rented for MVP) ────────
sellerModule.callbackQuery(/^seller:returns(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  // Reuse rented list with "return" action
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
    text += `${icon} #${r.id} — ${r.board.code} → ${r.clientName ?? r.user.name}${tag}\n`;
    kb.text(`✅ Принять ${r.board.code}`, `seller:return:${r.id}`).row();
  }
  addPaginationRow(kb, paged.page, paged.totalPages, "seller:returns:");
  kb.row().text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

// ──────── Accept return ────────
sellerModule.callbackQuery(/^seller:return:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  try {
    const { receipt, overdueCost, clientMsg, clientTgId } =
      await rentalService.completeReturn(rentalId, ctx.dbUser!.id);

    // Determine where to go back
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

    // Send receipt to client
    await notify(ctx.api, clientTgId, clientMsg);
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ Ошибка: ${e.message}`);
  }
});

// ──────── Today's history ────────
sellerModule.callbackQuery(/^seller:today(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");
  const spotId = ctx.dbUser!.spotId;
  if (!spotId) {
    return ctx.editMessageText("⚠️ Вы не привязаны к точке.");
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const rentals = await prisma.rental.findMany({
    where: { spotId, createdAt: { gte: todayStart } },
    include: { board: true, user: true, tariff: true },
    orderBy: { createdAt: "desc" },
  });

  const paged = paginate(rentals, page);

  let text = "📊 <b>История за сегодня</b>\n\n";
  if (paged.items.length === 0) {
    text += "Нет записей за сегодня.";
  } else {
    for (const r of paged.items) {
      const client = r.clientName ?? r.user.name;
      const source = r.sellerUserId ? "👤 админ" : "📱 клиент";
      const statusMap: Record<string, string> = {
        RENTED: "🔴", WAIT_RETURN: "⏰", RETURNED: "✅", CANCELLED: "❌", CREATED: "⏳", WAIT_PAYMENT: "💳", WAIT_ADMIN: "🔍",
      };
      const icon = statusMap[r.status] ?? "❓";
      const price = r.tariff ? fmtPrice(r.tariff.price) : "";
      text += `${icon} <b>${r.board.code}</b> → ${client} · ${price} · ${source}\n`;
    }
  }

  const kb = new InlineKeyboard();
  addPaginationRow(kb, paged.page, paged.totalPages, "seller:today:");
  kb.row().text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

// ──────── Walk-in rental: step 1 — pick board ────────
sellerModule.callbackQuery(/^seller:walkin(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");
  const spotId = ctx.dbUser!.spotId;
  if (!spotId) {
    return ctx.editMessageText("⚠️ Вы не привязаны к точке.");
  }

  // Reset walk-in state
  ctx.session.walkin = undefined;

  const boards = await prisma.board.findMany({
    where: { spotId, status: BoardStatus.AVAILABLE },
    orderBy: { code: "asc" },
  });

  const paged = paginate(boards, page, 10);
  const isAdmin = ctx.dbUser!.role === Role.ADMIN;
  const title = isAdmin ? "Выдать доску клиенту" : "Оформить аренду";
  let text = `➕ <b>${title}</b>\n\nВыберите доску:\n\n`;
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

// ──────── Walk-in: step 2 — pick tariff ────────
sellerModule.callbackQuery(/^walkin:board:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const boardId = parseInt(ctx.match[1]);
  const spotId = ctx.dbUser!.spotId;
  if (!spotId) return;

  ctx.session.walkin = { boardId };

  const tariffs = await prisma.tariff.findMany({
    where: { spotId },
    orderBy: { durationMinutes: "asc" },
  });

  const board = await prisma.board.findUniqueOrThrow({ where: { id: boardId } });

  const isAdmin = ctx.dbUser!.role === Role.ADMIN;
  const title = isAdmin ? "Выдать доску клиенту" : "Оформить аренду";
  let text = `➕ <b>${title}</b>\n\nДоска: <b>${board.code}</b>\nВыберите тариф:\n`;

  const kb = new InlineKeyboard();
  for (const t of tariffs) {
    kb.text(`${t.name} — ${fmtPrice(t.price)}`, `walkin:tariff:${t.id}`).row();
  }
  kb.row().text("⬅️ Назад", "seller:walkin").text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

// ──────── Walk-in: step 3 — ask client name ────────
sellerModule.callbackQuery(/^walkin:tariff:(\d+)$/, async (ctx) => {
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

// ──────── Walk-in: step 4 — receive client name, create rental ────────
sellerModule.on("message:text", async (ctx, next) => {
  const w = ctx.session.walkin;
  if (!w?.boardId || !w?.tariffId) {
    return next();
  }

  const spotId = ctx.dbUser!.spotId;
  if (!spotId) return;

  const clientName = ctx.message.text.trim();
  if (!clientName) {
    return ctx.reply("⚠️ Введите имя клиента:");
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

    const isAdmin = ctx.dbUser!.role === Role.ADMIN;

    await ctx.reply(
      `✅ <b>Аренда оформлена</b>\n\n` +
      `Доска: ${board.code}\n` +
      `Тариф: ${tariff.name} — ${fmtPrice(tariff.price)}\n` +
      `Клиент: ${clientName}\n` +
      `Старт: ${fmtDate(rental.startAt!)}`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("➕ Ещё одну", "seller:walkin")
          .text("🔄 Возвраты", isAdmin ? "admin:returns" : "seller:returns")
          .row()
          .text("⬅️ Меню", "back:menu"),
      }
    );
  } catch (e: any) {
    ctx.session.walkin = undefined;
    await ctx.reply(`⚠️ Ошибка: ${e.message}`);
  }
});

// ──────── Booked boards (disabled) ────────
sellerModule.callbackQuery(/^seller:bookings/, async (ctx) => {
  await ctx.answerCallbackQuery("Бронирование временно отключено");
});

sellerModule.callbackQuery(/^seller:cancel_book:/, async (ctx) => {
  await ctx.answerCallbackQuery("Бронирование временно отключено");
});
