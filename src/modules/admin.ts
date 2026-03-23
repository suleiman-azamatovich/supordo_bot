import { Composer, InlineKeyboard, InputFile } from "grammy";
import { BotContext } from "../bot/context";
import { guardRole } from "../bot/middleware";
import { prisma } from "../db/prisma";
import {
  fmtDate,
  fmtPrice,
  fmtDuration,
  paginate,
  addPaginationRow,
} from "../ui/helpers";
import * as paymentService from "../services/payment";
import * as rentalService from "../services/rental";
import * as reports from "../services/reports";
import { notify, getNotifications } from "../services/notify";
import { Role, BoardStatus, BookingStatus, RentalStatus, PaymentProofStatus } from "@prisma/client";
import { config } from "../bot/config";

export const adminModule = new Composer<BotContext>();

adminModule.use(guardRole(Role.ADMIN));

// ──────── Admin Notifications ────────
adminModule.callbackQuery("admin:notifications", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.dbUser!.id;
  const items = await getNotifications(userId);

  let text = "🔔 <b>Уведомления</b>\n\n";
  if (items.length === 0) {
    text += "Нет уведомлений за последние 24 часа.";
  } else {
    for (const n of items) {
      const time = n.createdAt.toLocaleTimeString("ru-RU", {
        timeZone: "Asia/Bishkek",
        hour: "2-digit",
        minute: "2-digit",
      });
      text += `<code>${time}</code>  ${n.text}\n\n`;
    }
  }

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text("🔄 Обновить", "admin:notifications")
      .text("⬅️ Меню", "back:menu"),
  });
});

// ──────── Dashboard — live summary ────────
adminModule.callbackQuery("admin:dashboard", async (ctx) => {
  await ctx.answerCallbackQuery();

  const [pendingPayments, activeRentals, waitReturns, availableBoards, totalBoards] = await Promise.all([
    prisma.paymentProof.count({ where: { status: PaymentProofStatus.SUBMITTED } }),
    prisma.rental.count({ where: { status: RentalStatus.RENTED } }),
    prisma.rental.count({ where: { status: RentalStatus.WAIT_RETURN } }),
    prisma.board.count({ where: { status: BoardStatus.AVAILABLE } }),
    prisma.board.count(),
  ]);

  const now = new Date();
  let text = `📋 <b>Панель управления</b>\n\n`;

  if (pendingPayments > 0) {
    text += `🔔 <b>Ожидают подтверждения оплаты: ${pendingPayments}</b>\n`;
  } else {
    text += `✅ Нет ожидающих оплат\n`;
  }

  if (waitReturns > 0) {
    text += `⏰ <b>Ожидают возврата: ${waitReturns}</b>\n`;
  }

  text += `\n🏄 В аренде: <b>${activeRentals}</b>\n`;
  text += `✅ Свободных досок: <b>${availableBoards}</b> из ${totalBoards}\n`;

  // Show active rentals with timers
  if (activeRentals > 0 || waitReturns > 0) {
    const rentals = await prisma.rental.findMany({
      where: { status: { in: [RentalStatus.RENTED, RentalStatus.WAIT_RETURN] } },
      include: { board: true, user: true, tariff: true },
      orderBy: { startAt: "asc" },
    });

    text += `\n<b>Активные аренды:</b>\n`;
    for (const r of rentals) {
      const client = r.clientName ?? r.user.name;
      const isExpired = r.status === RentalStatus.WAIT_RETURN;
      const icon = isExpired ? "⏰" : "🟢";

      text += `${icon} <b>${r.board.code}</b> → ${client}`;
      if (r.startAt && r.tariff) {
        const endAt = new Date(r.startAt.getTime() + r.tariff.durationMinutes * 60_000);
        const remaining = Math.max(0, Math.ceil((endAt.getTime() - now.getTime()) / 60_000));
        if (isExpired) {
          text += ` — <b>ВОЗВРАТ!</b>`;
        } else if (remaining > 0) {
          text += ` — ${fmtDuration(remaining)}`;
        }
      }
      text += `\n`;
    }
  }

  const kb = new InlineKeyboard();
  if (pendingPayments > 0) {
    kb.text(`💳 Оплаты (${pendingPayments})`, "admin:payments").row();
  }
  if (waitReturns > 0) {
    kb.text(`⏰ Принять возвраты (${waitReturns})`, "admin:returns").row();
  }
  if (activeRentals > 0) {
    kb.text(`🏄 Все в аренде (${activeRentals})`, "seller:rented").row();
  }
  kb.text("🔄 Обновить", "admin:dashboard").row();
  kb.text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

// ──────── Admin returns — unified list ────────
adminModule.callbackQuery(/^admin:returns(:(\d+))?$/, async (ctx) => {
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
  text += `🔴 Ожидают возврата: <b>${waitReturn}</b>  ·  🟢 Активных: <b>${active}</b>\n\n`;
  if (paged.items.length === 0) {
    text += "Нет активных аренд.";
  }

  const kb = new InlineKeyboard();
  for (const r of paged.items) {
    const client = r.clientName ?? r.user.name;
    const isExpired = r.status === RentalStatus.WAIT_RETURN;
    const icon = isExpired ? "🔴" : "🟢";

    text += `${icon} <b>${r.board.code}</b> → ${client}`;
    if (r.startAt && r.tariff) {
      const endAt = new Date(r.startAt.getTime() + r.tariff.durationMinutes * 60_000);
      if (isExpired) {
        const overdue = Math.ceil((now.getTime() - endAt.getTime()) / 60_000);
        if (overdue > 0) text += ` — <b>+${fmtDuration(overdue)}</b>`;
      } else {
        const remaining = Math.max(0, Math.ceil((endAt.getTime() - now.getTime()) / 60_000));
        text += ` — ${fmtDuration(remaining)}`;
      }
    }
    text += `\n`;
    kb.text(`✅ Принять ${r.board.code}`, `seller:return:${r.id}`).row();
  }
  addPaginationRow(kb, paged.page, paged.totalPages, "admin:returns:");
  kb.text("🔄 Обновить", "admin:returns").row();
  kb.text("📋 Панель", "admin:dashboard").text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

// ──────── Pending payments ────────
adminModule.callbackQuery(/^admin:payments(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");

  const { items, total, totalPages } = await paymentService.getPendingPayments(page, 5);

  let text = `💳 <b>Оплаты на проверку</b> (${total})\n\n`;
  if (items.length === 0) {
    text += "Нет ожидающих оплат.";
  }

  const kb = new InlineKeyboard();
  for (const p of items) {
    text += `#${p.id} — ${p.kind} #${p.refId} — ${fmtPrice(p.amount)} — ${p.user.name}\n`;
    kb.text(`✅ #${p.id}`, `pay:approve:${p.id}`)
      .text(`❌ #${p.id}`, `pay:reject:${p.id}`)
      .row();
  }
  addPaginationRow(kb, page, totalPages, "admin:payments:");
  kb.row().text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

// ──────── Approve payment ────────
adminModule.callbackQuery(/^pay:approve:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.chatWithClientTgId = undefined;
  ctx.session.chatProofId = undefined;
  const proofId = parseInt(ctx.match[1]);

  try {
    const proof = await paymentService.approvePayment(proofId, ctx.dbUser!.id);

    // Notify client — timer started
    const clientUser = await prisma.user.findUniqueOrThrow({ where: { id: proof.userId } });

    if (proof.kind === "RENTAL") {
      const rental = await prisma.rental.findUnique({
        where: { id: proof.refId },
        include: { board: true, spot: true, user: true, tariff: true },
      });
      if (rental) {
        await notify(
          ctx.api,
          clientUser.tgId,
          `✅ Оплата подтверждена!\n\n` +
          `🏄 Доска: <b>${rental.board.code}</b>\n` +
          `⏱ Время пошло: <b>${rental.tariff ? fmtDuration(rental.tariff.durationMinutes) : ""}</b>\n\n` +
          `Приятного катания! 🌊`
        );
      }
    } else {
      await notify(ctx.api, clientUser.tgId, `✅ Ваша оплата подтверждена! Бронирование активно.`);
    }

    await ctx.editMessageText(`✅ Оплата #${proofId} подтверждена. Аренда запущена.`, {
      reply_markup: new InlineKeyboard()
        .text("💳 К оплатам", "admin:payments")
        .text("⬅️ Меню", "back:menu"),
    });
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ Ошибка: ${e.message}`);
  }
});

// ──────── Reject payment ────────
adminModule.callbackQuery(/^pay:reject:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.chatWithClientTgId = undefined;
  ctx.session.chatProofId = undefined;
  const proofId = parseInt(ctx.match[1]);

  try {
    const proof = await paymentService.rejectPayment(proofId, ctx.dbUser!.id);

    const clientUser = await prisma.user.findUniqueOrThrow({ where: { id: proof.userId } });
    await notify(ctx.api, clientUser.tgId, `❌ Ваша оплата #${proof.id} отклонена.\nПопробуйте оплатить повторно или свяжитесь с администрацией.`);

    await ctx.editMessageText(`❌ Оплата #${proofId} отклонена.`, {
      reply_markup: new InlineKeyboard()
        .text("💳 К оплатам", "admin:payments")
        .text("⬅️ Меню", "back:menu"),
    });
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ Ошибка: ${e.message}`);
  }
});

// ──────── Request info (start chat with client) ────────
adminModule.callbackQuery(/^pay:request_info:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const proofId = parseInt(ctx.match[1]);

  const proof = await prisma.paymentProof.findUniqueOrThrow({
    where: { id: proofId },
    include: { user: true },
  });

  // Enter chat mode — admin can now type messages to this client
  ctx.session.chatWithClientTgId = Number(proof.user.tgId);
  ctx.session.chatProofId = proofId;

  try {
    await ctx.api.sendMessage(
      Number(proof.user.tgId),
      `💬 <b>Сообщение от администратора</b> (оплата #${proof.id})\n\n` +
      `Администратор запрашивает дополнительную информацию.\n` +
      `Нажмите кнопку ниже, чтобы ответить:`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("💬 Ответить администратору", `client:chat_admin:${proof.id}`),
      }
    );
  } catch { }

  await ctx.editMessageText(
    `💬 <b>Чат с клиентом</b> (оплата #${proofId})\n\n` +
    `Клиент: ${proof.user.name}\n` +
    `Вы в режиме переписки. Напишите сообщение — оно будет отправлено клиенту.\n\n` +
    `Для завершения чата нажмите кнопку ниже.`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("✅ Подтвердить оплату", `pay:approve:${proofId}`)
        .text("❌ Отклонить", `pay:reject:${proofId}`)
        .row()
        .text("🛑 Завершить чат", `admin:end_chat`)
        .row()
        .text("💳 К оплатам", "admin:payments")
        .text("⬅️ Меню", "back:menu"),
    }
  );
});

// ──────── End chat mode ────────
adminModule.callbackQuery("admin:end_chat", async (ctx) => {
  await ctx.answerCallbackQuery("Чат завершён");
  ctx.session.chatWithClientTgId = undefined;
  ctx.session.chatProofId = undefined;
  await ctx.editMessageText("🛑 Режим переписки завершён.", {
    reply_markup: new InlineKeyboard()
      .text("💳 К оплатам", "admin:payments")
      .text("⬅️ Меню", "back:menu"),
  });
});

// ──────── Re-enter chat mode from client reply ────────
adminModule.callbackQuery(/^admin:chat_client:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const proofId = parseInt(ctx.match[1]);

  const proof = await prisma.paymentProof.findUniqueOrThrow({
    where: { id: proofId },
    include: { user: true },
  });

  ctx.session.chatWithClientTgId = Number(proof.user.tgId);
  ctx.session.chatProofId = proofId;

  await ctx.reply(
    `💬 <b>Чат с клиентом ${proof.user.name}</b> (оплата #${proofId})\n\n` +
    `Напишите сообщение — оно будет отправлено клиенту.`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("✅ Подтвердить оплату", `pay:approve:${proofId}`)
        .text("❌ Отклонить", `pay:reject:${proofId}`)
        .row()
        .text("🛑 Завершить чат", `admin:end_chat`),
    }
  );
});

// ──────── Admin text → forward to client ────────
adminModule.on("message:text", async (ctx, next) => {
  if (ctx.session.waitingMBankQR) return next();

  if (ctx.session.chatWithClientTgId && ctx.session.chatProofId) {
    const clientTgId = ctx.session.chatWithClientTgId;
    const proofId = ctx.session.chatProofId;

    try {
      await ctx.api.sendMessage(
        clientTgId,
        `💬 <b>Администратор</b> (оплата #${proofId}):\n\n${ctx.message.text}`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("💬 Ответить", `client:chat_admin:${proofId}`),
        }
      );
      await ctx.reply("✅ Сообщение отправлено клиенту.", {
        reply_markup: new InlineKeyboard()
          .text("✅ Подтвердить оплату", `pay:approve:${proofId}`)
          .text("❌ Отклонить", `pay:reject:${proofId}`)
          .row()
          .text("🛑 Завершить чат", `admin:end_chat`),
      });
    } catch (e) {
      await ctx.reply("⚠️ Не удалось отправить сообщение клиенту.");
    }
    return;
  }

  return next();
});

// ──────── Reports menu ────────
adminModule.callbackQuery("admin:reports", async (ctx) => {
  await ctx.answerCallbackQuery();

  // Show today snapshot right away
  const today = await reports.todayReport();
  const todayText = reports.formatTodayReport(today);

  const kb = new InlineKeyboard()
    .text("📈 Неделя по дням", "report:week")
    .row()
    .text("💵 По тарифам", "report:tariffs")
    .row()
    .text("🔄 Обновить", "admin:reports")
    .text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(todayText, {
    parse_mode: "HTML",
    reply_markup: kb,
  });
});

// ──────── Week report ────────
adminModule.callbackQuery("report:week", async (ctx) => {
  await ctx.answerCallbackQuery();
  const data = await reports.weekReport();
  const text = reports.formatWeekReport(data);

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text("📊 Отчёты", "admin:reports")
      .text("⬅️ Меню", "back:menu"),
  });
});

// ──────── Tariff report ────────
adminModule.callbackQuery("report:tariffs", async (ctx) => {
  await ctx.answerCallbackQuery();
  const data = await reports.tariffReport();
  const text = reports.formatTariffReport(data);

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text("📊 Отчёты", "admin:reports")
      .text("⬅️ Меню", "back:menu"),
  });
});

// ──────── Boards dashboard (like client but with admin actions) ────────
adminModule.callbackQuery(/^admin:boards(:(\d+))?$/, async (ctx) => {
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
    text += `${icon} <b>${b.code}</b> — ${label}\n`;
    kb.text(`${icon} ${b.code}`, `admin:board_detail:${b.id}`).row();
  }

  addPaginationRow(kb, paged.page, paged.totalPages, "admin:boards:");
  kb.row().text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

// ──────── Board detail with context-aware actions ────────
adminModule.callbackQuery(/^admin:board_detail:(\d+)$/, async (ctx) => {
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
      const client = rental.clientName ?? rental.user.name;
      text = `🔴 <b>${board.code}</b> — в аренде\n\n`;
      text += `👤 Клиент: <b>${client}</b>\n`;
      if (rental.startAt) text += `⏱ Старт: ${fmtDate(rental.startAt)}\n`;
      if (rental.tariff) {
        text += `💰 Тариф: ${rental.tariff.name} — ${fmtPrice(rental.tariff.price)}\n`;
        if (rental.startAt) {
          const endAt = new Date(rental.startAt.getTime() + rental.tariff.durationMinutes * 60_000);
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
        kb.text("✅ Принять возврат", `seller:return:${rental.id}`).row();
      }
      kb.text("❌ Отменить аренду", `admin:cancel_rental_confirm:${rental.id}`).row();
    } else {
      text = `🔴 <b>${board.code}</b> — в аренде (данные не найдены)`;
    }
  }

  kb.text("⬅️ К доскам", "admin:boards").row();
  kb.text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

// ──────── Cancel rental confirm ────────
adminModule.callbackQuery(/^admin:cancel_rental_confirm:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, user: true, tariff: true },
  });

  const client = rental.clientName ?? rental.user.name;
  let text = `⚠️ <b>Отменить аренду #${rental.id}?</b>\n\n`;
  text += `Доска: <b>${rental.board.code}</b>\n`;
  text += `Клиент: <b>${client}</b>\n`;
  if (rental.tariff) text += `Тариф: ${rental.tariff.name} — ${fmtPrice(rental.tariff.price)}\n`;
  text += `\n⚠️ Доска будет возвращена в доступные. Клиент получит уведомление.`;

  const kb = new InlineKeyboard()
    .text("❌ Да, отменить", `admin:cancel_rental:${rentalId}`)
    .text("⬅️ Назад", `admin:board_detail:${rental.boardId}`)
    .row()
    .text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

// ──────── Cancel rental execute ────────
adminModule.callbackQuery(/^admin:cancel_rental:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  try {
    const rental = await rentalService.cancelRental(rentalId, ctx.dbUser!.id);
    const board = await prisma.board.findUniqueOrThrow({ where: { id: rental.boardId } });

    // Notify client
    const rentalData = await prisma.rental.findUniqueOrThrow({
      where: { id: rentalId },
      include: { user: true },
    });
    await notify(ctx.api, rentalData.user.tgId, `❌ Ваша аренда доски <b>${board.code}</b> была отменена администратором.`);

    await ctx.editMessageText(
      `✅ Аренда #${rentalId} отменена. Доска <b>${board.code}</b> освобождена.`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🔄 Возвраты", "admin:returns")
          .text("🏄 Доски", "admin:boards")
          .row()
          .text("⬅️ Меню", "back:menu"),
      }
    );
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ Ошибка: ${e.message}`);
  }
});

// ──────── Toggle board status ────────
adminModule.callbackQuery(/^board:(service|available):(\d+)$/, async (ctx) => {
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

// ──────── Tariffs list ────────
adminModule.callbackQuery(/^admin:tariffs(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");

  const tariffs = await prisma.tariff.findMany({
    include: { spot: true },
    orderBy: { id: "asc" },
  });
  const paged = paginate(tariffs, page);

  let text = "💰 <b>Тарифы</b>\n\n";
  for (const t of paged.items) {
    text += `#${t.id} ${t.name} (${fmtDuration(t.durationMinutes)}) — ${fmtPrice(t.price)} — ${t.spot.name}\n`;
  }
  if (paged.items.length === 0) text += "Нет тарифов.";

  const kb = new InlineKeyboard();
  addPaginationRow(kb, paged.page, paged.totalPages, "admin:tariffs:");
  kb.row().text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

// ──────── Sellers management ────────
adminModule.callbackQuery(/^admin:sellers(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");

  const sellers = await prisma.user.findMany({
    where: { role: Role.SELLER },
    include: { spot: true },
    orderBy: { id: "asc" },
  });
  const paged = paginate(sellers, page);

  let text = "👥 <b>Продавцы</b>\n\n";
  for (const s of paged.items) {
    text += `#${s.id} ${s.name} (tg: ${s.tgId}) — ${s.spot?.name ?? "не привязан"}\n`;
  }
  if (paged.items.length === 0) text += "Нет продавцов.\n";

  text += "\nЧтобы добавить продавца, используйте:\n<code>/add_seller TG_ID SPOT_ID</code>";

  const kb = new InlineKeyboard();
  addPaginationRow(kb, paged.page, paged.totalPages, "admin:sellers:");
  kb.row().text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

// ──────── Add seller command ────────
adminModule.command("add_seller", async (ctx) => {
  if (ctx.dbUser?.role !== Role.ADMIN) {
    return ctx.reply("⛔ Только для админа.");
  }

  const args = (ctx.match as string)?.split(" ").filter(Boolean);
  if (!args || args.length < 2) {
    return ctx.reply(
      "Использование: /add_seller <TG_ID> <SPOT_ID>\n\nПример: /add_seller 123456789 1"
    );
  }

  const tgId = BigInt(args[0]);
  const spotId = parseInt(args[1]);

  const spot = await prisma.spot.findUnique({ where: { id: spotId } });
  if (!spot) {
    return ctx.reply(`❌ Точка #${spotId} не найдена.`);
  }

  const user = await prisma.user.upsert({
    where: { tgId },
    update: { role: Role.SELLER, spotId },
    create: { tgId, name: `Seller ${tgId}`, role: Role.SELLER, spotId },
  });

  await ctx.reply(
    `✅ Пользователь tg:${user.tgId} назначен продавцом на точку «${spot.name}».`
  );
});

// ──────── Remove seller command ────────
adminModule.command("remove_seller", async (ctx) => {
  if (ctx.dbUser?.role !== Role.ADMIN) {
    return ctx.reply("⛔ Только для админа.");
  }

  const tgIdStr = (ctx.match as string)?.trim();
  if (!tgIdStr) {
    return ctx.reply("Использование: /remove_seller <TG_ID>");
  }

  const tgId = BigInt(tgIdStr);
  const user = await prisma.user.findUnique({ where: { tgId } });
  if (!user || user.role !== Role.SELLER) {
    return ctx.reply("❌ Продавец не найден.");
  }

  await prisma.user.update({
    where: { tgId },
    data: { role: Role.CLIENT, spotId: null },
  });

  await ctx.reply(`✅ Пользователь tg:${tgId} снят с роли продавца.`);
});

// ──────── Approve booking ────────
adminModule.callbackQuery(/^admin:approve_book:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const bookingId = parseInt(ctx.match[1]);

  try {
    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { user: true, board: true },
    });

    if (booking.status !== BookingStatus.WAIT_ADMIN) {
      return ctx.editMessageText(`⚠️ Бронь #${bookingId} уже обработана (${booking.status}).`);
    }

    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.CONFIRMED },
    });

    // Notify client
    await notify(ctx.api, booking.user.tgId, `✅ Ваше бронирование #${bookingId}${booking.board ? ` (доска ${booking.board.code})` : ""} подтверждено!`);

    await ctx.editMessageText(`✅ Бронь #${bookingId} подтверждена.`, {
      reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
    });
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ Ошибка: ${e.message}`);
  }
});

// ──────── Reject booking ────────
adminModule.callbackQuery(/^admin:reject_book:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const bookingId = parseInt(ctx.match[1]);

  try {
    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      include: { user: true, board: true },
    });

    if (booking.status !== BookingStatus.WAIT_ADMIN) {
      return ctx.editMessageText(`⚠️ Бронь #${bookingId} уже обработана (${booking.status}).`);
    }

    await prisma.booking.update({
      where: { id: bookingId },
      data: { status: BookingStatus.CANCELLED },
    });

    // Release board back to AVAILABLE
    if (booking.boardId) {
      await prisma.board.update({
        where: { id: booking.boardId },
        data: { status: BoardStatus.AVAILABLE },
      });
    }

    // Notify client
    await notify(ctx.api, booking.user.tgId, `❌ Ваше бронирование #${bookingId}${booking.board ? ` (доска ${booking.board.code})` : ""} отклонено.`);

    await ctx.editMessageText(`❌ Бронь #${bookingId} отклонена. Доска освобождена.`, {
      reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
    });
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ Ошибка: ${e.message}`);
  }
});

// ──────── Set MBank QR code ────────
adminModule.command("set_mbank_qr", async (ctx) => {
  if (ctx.dbUser?.role !== Role.ADMIN) {
    return ctx.reply("⛔ Только для админа.");
  }

  ctx.session.waitingMBankQR = true;
  await ctx.reply(
    "📷 Отправьте фото QR-кода MBank для оплаты.\n" +
    "Это изображение будет показываться клиентам при аренде и бронировании."
  );
});

adminModule.on("message:photo", async (ctx, next) => {
  if (!ctx.session.waitingMBankQR) return next();

  ctx.session.waitingMBankQR = false;
  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  config.MBANK_QR_FILE_ID = fileId;

  await ctx.reply(
    `✅ QR-код MBank сохранён!\n\n` +
    `<code>MBANK_QR_FILE_ID=${fileId}</code>\n\n` +
    `⚠️ Чтобы QR не сбросился при перезапуске бота, добавьте эту строку в файл <code>.env</code>`,
    { parse_mode: "HTML" }
  );
});
