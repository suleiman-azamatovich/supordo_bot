import { Composer, InlineKeyboard, InputFile } from "grammy";
import path from "path";
import { BotContext } from "../bot/context";
import { prisma } from "../db/prisma";
import { mainMenuKeyboard } from "../ui/keyboards";
import {
  fmtPrice,
  fmtDuration,
  fmtDate,
  paginate,
  addPaginationRow,
} from "../ui/helpers";
import * as rentalService from "../services/rental";
import { getNotifications } from "../services/notify";
import { notify } from "../services/notify";
import { BoardStatus, BookingStatus, RentalStatus } from "@prisma/client";

export const clientModule = new Composer<BotContext>();

// ──────── /start with deep link ────────
clientModule.command("start", async (ctx) => {
  const payload = ctx.match; // text after /start
  if (payload && typeof payload === "string" && payload.startsWith("board_")) {
    const boardCode = payload.replace("board_", "");
    return handleRentalByQR(ctx, boardCode);
  }

  const role = ctx.dbUser?.role ?? "CLIENT";
  await ctx.reply(
    `Привет, ${ctx.dbUser?.name ?? "друг"}! 👋\nВаша роль: <b>${role}</b>\n\nВыберите действие:`,
    { parse_mode: "HTML", reply_markup: mainMenuKeyboard(role) }
  );
});

// ──────── /menu ────────
clientModule.command("menu", async (ctx) => {
  const role = ctx.dbUser?.role ?? "CLIENT";
  ctx.session.chatWithAdminTgId = undefined;
  ctx.session.chatReplyProofId = undefined;
  await ctx.reply("📋 <b>Главное меню</b>", {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(role),
  });
});

// ──────── QR Hint ────────
clientModule.callbackQuery("client:qr_hint", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "🏄 <b>Аренда по QR</b>\n\n" +
    "1️⃣ Откройте <b>камеру телефона</b> (не в Telegram)\n" +
    "2️⃣ Наведите на QR-код на доске\n" +
    "3️⃣ Нажмите на ссылку — бот откроется автоматически\n\n" +
    "Или нажмите кнопку ниже и введите номер доски (например: <code>SUP-05</code>)",
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🔢 Ввести код доски", "client:enter_code")
        .row()
        .text("⬅️ Меню", "back:menu"),
    }
  );
});

// ──────── Enter board code manually ────────
clientModule.callbackQuery("client:enter_code", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.waitingBoardCode = true;
  await ctx.editMessageText(
    "🔢 Введите код доски (например: <code>SUP-05</code>):",
    { parse_mode: "HTML" }
  );
});

// ──────── Back to menu ────────
clientModule.callbackQuery("back:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  const role = ctx.dbUser?.role ?? "CLIENT";
  await ctx.editMessageText("📋 <b>Главное меню</b>", {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(role),
  });
});

// ──────── Clear chat ────────
clientModule.callbackQuery("clear:chat", async (ctx) => {
  await ctx.answerCallbackQuery("Очистка чата...");
  const chatId = ctx.chat!.id;
  const sourceId = ctx.callbackQuery.message?.message_id;

  // Delete all tracked bot messages except the current one
  const ids = (ctx.session.lastBotMsgIds ?? []).filter((id) => id !== sourceId);
  if (ids.length > 0) {
    // Bulk delete in chunks of 100
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      try { await ctx.api.deleteMessages(chatId, chunk); } catch { }
    }
  }

  // Also try to delete recent untracked messages (notifications etc.)
  if (sourceId) {
    const untrackedIds: number[] = [];
    for (let id = sourceId - 1; id > sourceId - 200 && id > 0; id--) {
      if (!ids.includes(id)) untrackedIds.push(id);
    }
    for (let i = 0; i < untrackedIds.length; i += 100) {
      const chunk = untrackedIds.slice(i, i + 100);
      try { await ctx.api.deleteMessages(chatId, chunk); } catch { }
    }
  }

  // Show fresh menu in place of the current message
  const role = ctx.dbUser?.role ?? "CLIENT";
  ctx.session.lastBotMsgIds = sourceId ? [sourceId] : [];
  await ctx.editMessageText("📋 <b>Главное меню</b>\n\n✅ Чат очищен.", {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(role),
  });
});

// ──────── All boards with status ────────
clientModule.callbackQuery(/^client:boards(:(\d+))?$/, async (ctx) => {
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
  kb.row().text("� Ввести код доски", "client:enter_code");
  kb.row().text("⬅️ Меню", "back:menu");

  text += `\n\n💡 <i>Также можно отсканировать QR-код на доске камерой телефона — бот откроется автоматически!</i>`;

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

// ──────── Board info (when occupied) ────────
clientModule.callbackQuery(/^client:board_info:(\d+)$/, async (ctx) => {
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
    const booking = await prisma.booking.findFirst({
      where: { boardId: board.id, status: { in: [BookingStatus.WAIT_PAYMENT, BookingStatus.WAIT_ADMIN, BookingStatus.CONFIRMED] } },
      orderBy: { startAt: "asc" },
    });
    if (booking) {
      text += `📅 Забронирована.\nБронь с <b>${fmtDate(booking.startAt)}</b> до <b>${fmtDate(booking.endAt)}</b>`;
    } else {
      text += `📅 Забронирована.`;
    }
  } else if (board.status === BoardStatus.SERVICE) {
    text += `🔧 На обслуживании. Временно недоступна.`;
  }

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard().text("⬅️ К доскам", "client:boards").row().text("⬅️ Меню", "back:menu"),
  });
});

// ──────── Rent board from available list ────────
clientModule.callbackQuery(/^client:rent_board:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const boardCode = ctx.match[1];
  return handleRentalByQR(ctx, boardCode);
});

// ──────── Rental by QR flow (deep link) ────────
async function handleRentalByQR(ctx: BotContext, boardCode: string) {
  if (ctx.dbUser?.role === "ADMIN") {
    return ctx.reply("⛔ Администратор не может арендовать доски.");
  }

  const board = await prisma.board.findUnique({
    where: { code: boardCode },
    include: { spot: true },
  });

  if (!board) {
    return ctx.reply("❌ Доска с таким кодом не найдена.");
  }
  if (board.status !== BoardStatus.AVAILABLE) {
    return ctx.reply(
      `⚠️ Доска <b>${board.code}</b> сейчас недоступна (статус: ${board.status}).`,
      { parse_mode: "HTML" }
    );
  }

  const tariffs = await prisma.tariff.findMany({
    where: { spotId: board.spotId },
    orderBy: { durationMinutes: "asc" },
  });

  if (tariffs.length === 0) {
    return ctx.reply("❌ Для этой точки нет тарифов.");
  }

  const kb = new InlineKeyboard();
  for (const t of tariffs) {
    kb.text(
      `${t.name} — ${fmtPrice(t.price)}`,
      `rent:pick_tariff:${board.id}:${t.id}`
    ).row();
  }
  kb.text("⬅️ Меню", "back:menu");

  await ctx.reply(
    `🏄 Доска: <b>${board.code}</b>\n` +
    `📍 Точка: ${board.spot.name}\n\n` +
    `Выберите тариф:`,
    { parse_mode: "HTML", reply_markup: kb }
  );
}

// ──────── Pick tariff for rental ────────
clientModule.callbackQuery(/^rent:pick_tariff:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const boardId = parseInt(ctx.match[1]);
  const tariffId = parseInt(ctx.match[2]);

  const board = await prisma.board.findUniqueOrThrow({
    where: { id: boardId },
    include: { spot: true },
  });
  const tariff = await prisma.tariff.findUniqueOrThrow({
    where: { id: tariffId },
  });

  if (board.status !== BoardStatus.AVAILABLE) {
    return ctx.editMessageText("⚠️ Доска уже занята. Попробуйте другую.");
  }

  // Show safety memo and require confirmation before creating rental
  const kb = new InlineKeyboard()
    .text("✅ Принимаю условия", `rent:accept_safety:${boardId}:${tariffId}`)
    .row()
    .text("⬅️ Назад", `client:board:${boardId}`)
    .text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(
    `📋 <b>Аренда SUP-борда</b>\n\n` +
    `🏄 Доска: <b>${board.code}</b>\n` +
    `📍 Точка: ${board.spot.name}\n` +
    `⏱ Тариф: ${tariff.name} (${fmtDuration(tariff.durationMinutes)})\n` +
    `💰 Сумма: <b>${fmtPrice(tariff.price)}</b>\n\n` +
    `⚠️ <b>Памятка по технике безопасности:</b>\n` +
    `1. Обязательно используйте спасательный жилет\n` +
    `2. Не отплывайте далеко от берега\n` +
    `3. Не передавайте доску третьим лицам\n` +
    `4. При ухудшении погоды немедленно возвращайтесь\n` +
    `5. За повреждение оборудования взимается компенсация\n\n` +
    `📌 <b>Нажимая «Принимаю условия», вы подтверждаете, что ознакомлены с правилами безопасности и несёте полную ответственность за своё здоровье и сохранность оборудования.</b>`,
    { parse_mode: "HTML", reply_markup: kb }
  );
});

// ──────── Accept safety memo → create rental ────────
clientModule.callbackQuery(/^rent:accept_safety:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const boardId = parseInt(ctx.match[1]);
  const tariffId = parseInt(ctx.match[2]);

  const board = await prisma.board.findUniqueOrThrow({
    where: { id: boardId },
    include: { spot: true },
  });
  const tariff = await prisma.tariff.findUniqueOrThrow({
    where: { id: tariffId },
  });

  if (board.status !== BoardStatus.AVAILABLE) {
    return ctx.editMessageText("⚠️ Доска уже занята. Попробуйте другую.");
  }

  // Create rental and immediately send to admin for confirmation
  const { rental } = await rentalService.createRental({
    userId: ctx.dbUser!.id,
    spotId: board.spotId,
    boardId: board.id,
    tariffId: tariff.id,
  });

  await rentalService.moveToWaitPayment(rental.id, ctx.dbUser!.id);

  // Auto-submit payment proof (amount known)
  const { proof } = await rentalService.submitPayment({
    rentalId: rental.id,
    userId: ctx.dbUser!.id,
    amount: tariff.price,
  });

  const kb = new InlineKeyboard()
    .text("❌ Отмена", `rent:cancel:${rental.id}`)
    .row()
    .text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(
    `📋 <b>Аренда #${rental.id}</b>\n\n` +
    `🏄 Доска: ${board.code}\n` +
    `📍 Точка: ${board.spot.name}\n` +
    `⏱ Тариф: ${tariff.name} (${fmtDuration(tariff.durationMinutes)})\n` +
    `💰 Сумма: <b>${fmtPrice(tariff.price)}</b>\n\n` +
    `💳 <b>Оплата через MBank:</b>\n` +
    `Переведите <b>${fmtPrice(tariff.price)}</b> по QR-коду ниже.\n` +
    `Заявка отправлена администратору. После подтверждения оплаты вам придёт уведомление.`,
    { parse_mode: "HTML", reply_markup: kb }
  );

  // Send MBank QR if configured
  await sendMBankQR(ctx, tariff.price);

  // Notify admins
  await notifyAdminsNewPayment(ctx, proof.id);
});



// ──────── Photo handler for payment proof ────────
clientModule.on("message:photo", async (ctx) => {
  // If in chat with admin, forward the photo
  if (ctx.session.chatWithAdminTgId && ctx.session.chatReplyProofId) {
    const adminTgId = ctx.session.chatWithAdminTgId;
    const proofId = ctx.session.chatReplyProofId;
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const userName = ctx.dbUser?.name ?? "Клиент";
    try {
      const admins = await prisma.user.findMany({ where: { role: "ADMIN" } });
      for (const admin of admins) {
        try {
          await ctx.api.sendPhoto(Number(admin.tgId), fileId, {
            caption: `📎 <b>${userName}</b> (оплата #${proofId}) отправил(а) фото`,
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("✅ Подтвердить оплату", `pay:approve:${proofId}`)
              .text("❌ Отклонить", `pay:reject:${proofId}`)
              .row()
              .text("💬 Ответить", `admin:chat_client:${proofId}`),
          });
        } catch { }
      }
      await ctx.reply("✅ Фото отправлено администратору.");
    } catch {
      await ctx.reply("⚠️ Не удалось отправить фото.");
    }
    return;
  }

  // Attach latest photo to the latest SUBMITTED proof of this user
  const latestProof = await prisma.paymentProof.findFirst({
    where: { userId: ctx.dbUser!.id, status: "SUBMITTED", fileId: null },
    orderBy: { createdAt: "desc" },
  });

  if (!latestProof) return; // No pending proof — ignore

  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  await prisma.paymentProof.update({
    where: { id: latestProof.id },
    data: { fileId },
  });

  await ctx.reply("📎 Фото чека прикреплено к заявке. Ожидайте подтверждения.", {
    reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
  });
});

// ──────── Cancel rental ────────
clientModule.callbackQuery(/^rent:cancel:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);
  try {
    await rentalService.cancelRental(rentalId, ctx.dbUser!.id);
    await ctx.editMessageText("❌ Аренда отменена.", {
      reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
    });
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ ${e.message}`);
  }
});

// ──────── BOOKING (disabled) ────────

// Booking disabled — stub handlers for old inline buttons
clientModule.callbackQuery(/^client:book/, async (ctx) => {
  await ctx.answerCallbackQuery("Бронирование временно отключено");
  await ctx.editMessageText("⚠️ Функция бронирования временно отключена.", {
    reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
  });
});

clientModule.callbackQuery(/^book:(board|tariff|time|cancel):/, async (ctx) => {
  await ctx.answerCallbackQuery("Бронирование временно отключено");
});

// ──────── My rentals list ────────
const rentalStatusLabel: Record<string, string> = {
  CREATED: "⏳ Создана",
  WAIT_PAYMENT: "💳 Ожидает оплаты",
  WAIT_ADMIN: "🔍 Проверка оплаты",
  RENTED: "🏄 В аренде",
  WAIT_RETURN: "⏰ Верните доску!",
  RETURNED: "✅ Завершена",
  CANCELLED: "❌ Отменена",
};

clientModule.callbackQuery(/^client:my_list(:(\d+))?$/, async (ctx) => {
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
        text += `   ⏰ Время истекло — верните доску на пляж\n`;
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
  // Add extend and close overdue buttons for active rentals
  for (const r of paged.items) {
    if (r.status === "WAIT_RETURN") {
      // Show overdue info and close overdue button
      const overdue = rentalService.getOverdueMinutes(r);
      if (overdue > 0) {
        kb.text(`🔄 Закрыть просрочку ${r.board.code} (${fmtDuration(overdue)})`, `client:close_overdue:${r.id}`).row();
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

// ──────── Client close overdue ────────
clientModule.callbackQuery(/^client:close_overdue:(\d+)$/, async (ctx) => {
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
    const result = await rentalService.closeOverdue(rentalId, ctx.dbUser!.id);

    await ctx.editMessageText(
      `✅ Просрочка закрыта!\n\n` +
      `🏄 Доска: <b>${rental.board.code}</b>\n` +
      `⏱ Покрыто: <b>${fmtDuration(result.closedMinutes)}</b>\n` +
      `💰 Доплата: <b>${fmtPrice(result.overdueCost)}</b>\n` +
      `Аренда снова активна.`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("📋 Мои аренды", "client:my_list")
          .text("⬅️ Меню", "back:menu"),
      }
    );

    // Notify admins
    const admins = await prisma.user.findMany({ where: { role: "ADMIN" } });
    for (const admin of admins) {
      try {
        await ctx.api.sendMessage(
          Number(admin.tgId),
          `🔄 Клиент <b>${ctx.dbUser!.name}</b> закрыл просрочку по доске <b>${rental.board.code}</b> (${fmtDuration(result.closedMinutes)}).`,
          { parse_mode: "HTML" }
        );
      } catch { }
    }
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ ${e.message}`, {
      reply_markup: new InlineKeyboard().text("📋 Мои аренды", "client:my_list"),
    });
  }
});

// ──────── Client extend rental — pick duration ────────
clientModule.callbackQuery(/^client:extend:(\d+)$/, async (ctx) => {
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
    where: { spotId: rental.spotId },
    orderBy: { durationMinutes: "asc" },
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

// ──────── Client extend confirm — send request to admin ────────
clientModule.callbackQuery(/^client:extend_confirm:(\d+):(\d+)$/, async (ctx) => {
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

    // Notify admins about extension request
    const admins = await prisma.user.findMany({ where: { role: "ADMIN" } });
    for (const admin of admins) {
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
    }
  } catch (e: any) {
    await ctx.editMessageText(`⚠️ ${e.message}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Назад", "client:my_list"),
    });
  }
});

// ──────── Client reply to admin about extension ────────
clientModule.callbackQuery(/^client:chat_ext:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  const admins = await prisma.user.findMany({ where: { role: "ADMIN" } });
  if (admins.length === 0) {
    return ctx.reply("⚠️ Администратор недоступен.");
  }

  ctx.session.chatWithAdminTgId = -1; // flag: chat active (broadcasts to all admins)
  ctx.session.chatReplyRentalId = rentalId;
  ctx.session.chatReplyProofId = undefined;

  await ctx.reply(
    `💬 <b>Чат с администратором</b> (продление аренды #${rentalId})\n\n` +
    `Напишите сообщение — оно будет отправлено администратору.\n` +
    `Для выхода нажмите /menu`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🛑 Завершить чат", "client:end_chat"),
    }
  );
});

// ──────── Client chat with admin (enter reply mode) ────────
clientModule.callbackQuery(/^client:chat_admin:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const proofId = parseInt(ctx.match[1]);

  const proof = await prisma.paymentProof.findUniqueOrThrow({
    where: { id: proofId },
  });

  // Find admins to reply to
  const admins = await prisma.user.findMany({ where: { role: "ADMIN" } });
  if (admins.length === 0) {
    return ctx.reply("⚠️ Администратор недоступен.");
  }

  ctx.session.chatWithAdminTgId = -1; // flag: chat active (broadcasts to all admins)
  ctx.session.chatReplyProofId = proofId;

  await ctx.reply(
    `💬 <b>Чат с администратором</b> (оплата #${proofId})\n\n` +
    `Напишите сообщение — оно будет отправлено администратору.\n` +
    `Для выхода нажмите /menu`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🛑 Завершить чат", "client:end_chat"),
    }
  );
});

// ──────── Client end chat ────────
clientModule.callbackQuery("client:end_chat", async (ctx) => {
  await ctx.answerCallbackQuery("Чат завершён");
  ctx.session.chatWithAdminTgId = undefined;
  ctx.session.chatReplyProofId = undefined;
  ctx.session.chatReplyRentalId = undefined;
  const role = ctx.dbUser?.role ?? "CLIENT";
  await ctx.editMessageText("🛑 Чат завершён.", {
    reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
  });
});

// ──────── Client text → forward to admin OR manual board code ────────
clientModule.on("message:text", async (ctx, next) => {
  // Chat with admin about payment
  if (ctx.session.chatWithAdminTgId && ctx.session.chatReplyProofId) {
    const proofId = ctx.session.chatReplyProofId;

    const userName = ctx.dbUser?.name ?? "Клиент";
    try {
      const admins = await prisma.user.findMany({ where: { role: "ADMIN" } });
      for (const admin of admins) {
        try {
          await ctx.api.sendMessage(
            Number(admin.tgId),
            `💬 <b>${userName}</b> (оплата #${proofId}):\n\n${ctx.message.text}`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard()
                .text("✅ Подтвердить оплату", `pay:approve:${proofId}`)
                .text("❌ Отклонить", `pay:reject:${proofId}`)
                .row()
                .text("💬 Ответить", `admin:chat_client:${proofId}`),
            }
          );
        } catch { }
      }
      await ctx.reply("✅ Сообщение отправлено администратору.", {
        reply_markup: new InlineKeyboard()
          .text("🛑 Завершить чат", "client:end_chat"),
      });
    } catch (e) {
      await ctx.reply("⚠️ Не удалось отправить сообщение.");
    }
    return;
  }

  // Chat with admin about extension
  if (ctx.session.chatWithAdminTgId && ctx.session.chatReplyRentalId) {
    const rentalId = ctx.session.chatReplyRentalId;

    const userName = ctx.dbUser?.name ?? "Клиент";
    try {
      const admins = await prisma.user.findMany({ where: { role: "ADMIN" } });
      for (const admin of admins) {
        try {
          await ctx.api.sendMessage(
            Number(admin.tgId),
            `💬 <b>${userName}</b> (продление #${rentalId}):\n\n${ctx.message.text}`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard()
                .text("✅ Подтвердить", `ext:approve:${rentalId}`)
                .text("❌ Отклонить", `ext:reject:${rentalId}`)
                .row()
                .text("💬 Ответить", `ext:chat:${rentalId}`),
            }
          );
        } catch { }
      }
      await ctx.reply("✅ Сообщение отправлено администратору.", {
        reply_markup: new InlineKeyboard()
          .text("🛑 Завершить чат", "client:end_chat"),
      });
    } catch (e) {
      await ctx.reply("⚠️ Не удалось отправить сообщение.");
    }
    return;
  }

  // Manual board code entry
  if (!ctx.session.waitingBoardCode) return next();

  const code = ctx.message.text.trim().toUpperCase();
  ctx.session.waitingBoardCode = false;

  if (!/^SUP-\d{2}$/.test(code)) {
    await ctx.reply(
      "⚠️ Неверный формат. Введите код вида <code>SUP-05</code> или нажмите /menu",
      { parse_mode: "HTML" }
    );
    return;
  }

  return handleRentalByQR(ctx, code);
});

// ──────── Notifications ────────
clientModule.callbackQuery("client:notifications", async (ctx) => {
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
      .text("🔄 Обновить", "client:notifications")
      .text("⬅️ Меню", "back:menu"),
  });
});

// ──────── Help ────────
clientModule.callbackQuery("client:help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "❓ <b>Помощь</b>\n\n" +
    "• <b>Доски:</b> посмотрите статус всех досок и арендуйте свободную.\n" +
    "• <b>Аренда по QR:</b> отсканируйте QR-код на доске камерой телефона.\n" +
    "• <b>Оплата:</b> переведите сумму через MBank по QR-коду.\n" +
    "• Администратор подтвердит оплату, и продавец выдаст вам доску.\n\n" +
    "По вопросам свяжитесь с администрацией.",
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu") }
  );
});

// ──────── Notify admins about new payment ────────
async function notifyAdminsNewPayment(ctx: BotContext, proofId: number) {
  const proof = await prisma.paymentProof.findUniqueOrThrow({
    where: { id: proofId },
    include: { user: true },
  });

  let refText = "";
  if (proof.kind === "RENTAL") {
    const rental = await prisma.rental.findUnique({
      where: { id: proof.refId },
      include: { board: true, spot: true },
    });
    refText = rental
      ? `Аренда #${rental.id}\nДоска: ${rental.board.code}\nТочка: ${rental.spot.name}`
      : `Аренда #${proof.refId}`;
  } else {
    const booking = await prisma.booking.findUnique({
      where: { id: proof.refId },
      include: { spot: true },
    });
    refText = booking
      ? `Бронь #${booking.id}\nТочка: ${booking.spot.name}\nНачало: ${fmtDate(booking.startAt)}`
      : `Бронь #${proof.refId}`;
  }

  const text =
    `💳 <b>Новая заявка на оплату #${proof.id}</b>\n\n` +
    `👤 ${proof.user.name} (tg: ${proof.user.tgId})\n` +
    `📋 ${refText}\n` +
    `💰 Сумма: ${fmtPrice(proof.amount)}\n` +
    `📎 Чек: ${proof.fileId ? "приложен" : "нет"}`;

  const kb = new InlineKeyboard()
    .text("✅ Подтвердить", `pay:approve:${proof.id}`)
    .text("❌ Отклонить", `pay:reject:${proof.id}`)
    .row()
    .text("💬 Запросить инфо", `pay:request_info:${proof.id}`);

  // Find all admins
  const admins = await prisma.user.findMany({ where: { role: "ADMIN" } });
  for (const admin of admins) {
    // Save notification to DB for admin's bell
    await prisma.notification.create({
      data: {
        userId: admin.id,
        text: `💳 Новая оплата #${proof.id} от ${proof.user.name} — ${fmtPrice(proof.amount)}`,
      },
    });

    try {
      const msg: { chat: { id: number }; message_id?: number } & Record<string, any> =
        proof.fileId
          ? await ctx.api.sendPhoto(Number(admin.tgId), proof.fileId, {
            caption: text,
            parse_mode: "HTML",
            reply_markup: kb,
          })
          : await ctx.api.sendMessage(Number(admin.tgId), text, {
            parse_mode: "HTML",
            reply_markup: kb,
          });
    } catch (e) {
      console.error(`Failed to notify admin ${admin.tgId}:`, e);
    }
  }
}

// ──────── Send MBank QR code to client ────────
const MBANK_QR_PATH = path.join(__dirname, "..", "..", "qr-bank", "mbank_qr.jpeg");

async function sendMBankQR(ctx: BotContext, amount: number) {
  try {
    await ctx.replyWithPhoto(new InputFile(MBANK_QR_PATH), {
      caption:
        `💳 <b>Оплата через MBank</b>\n\n` +
        `Отсканируйте QR-код в приложении MBank и переведите <b>${fmtPrice(amount)}</b>.\n` +
        `После перевода администратор подтвердит оплату.`,
      parse_mode: "HTML",
    });
  } catch (e) {
    console.error("Failed to send MBank QR:", e);
    await ctx.reply(
      `💳 Переведите <b>${fmtPrice(amount)}</b> через MBank. Обратитесь к администрации за реквизитами.`,
      { parse_mode: "HTML" }
    );
  }
}

// noop for pagination indicator
clientModule.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());
