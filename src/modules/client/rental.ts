/**
 * Поток аренды доски клиентом.
 *
 * Обрабатывает:
 *  - rent:pick_tariff — выбор тарифа после выбора доски
 *  - rent:accept_safety — принятие памятки по ТБ → создание аренды
 *  - message:photo — фото чека (пересылка админу если в чате, иначе привязка к платежу)
 *  - rent:cancel — отмена аренды до начала
 *
 * Поток:
 *  1. Клиент выбирает доску (boards.ts / helpers.ts)
 *  2. Выбирает тариф → rent:pick_tariff
 *  3. Читает памятку по ТБ → rent:accept_safety
 *  4. Создаётся аренда, отправляется QR MBank и уведомление админам
 *  5. Клиент может прикрепить фото чека (message:photo)
 *  6. Или отменить аренду (rent:cancel)
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import { BoardStatus, Role } from "@prisma/client";
import { fmtPrice, fmtDuration, fmtDate, escapeHtml, fmtTariffPriceLine } from "../../ui/helpers";
import * as rentalService from "../../services/rental";
import { applyDiscount, normalizePercent, tariffEffectivePrice } from "../../services/pricing";
import { sendMBankQR, notifyAdminsNewPayment } from "./helpers";

export const rentalHandlers = new Composer<BotContext>();

/** Выбор тарифа — показывает памятку по ТБ с кнопкой подтверждения */
rentalHandlers.callbackQuery(/^rent:pick_tariff:(\d+):(\d+)$/, async (ctx) => {
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

  const discountPct = normalizePercent(ctx.dbUser?.discountPercent ?? 0);
  const effectivePrice = tariffEffectivePrice(tariff);
  const finalPrice = applyDiscount(effectivePrice, discountPct);

  const kb = new InlineKeyboard()
    .text("✅ Принимаю условия", `rent:accept_safety:${boardId}:${tariffId}`)
    .row()
    .text("⬅️ Назад", `client:board_info:${boardId}`)
    .text("⬅️ Меню", "back:menu");

  // Блок цены: акция + скидка клиента (в любом сочетании)
  let priceBlock: string;
  const hasPromo = effectivePrice < tariff.price;
  if (hasPromo && discountPct > 0) {
    priceBlock =
      `💰 Прайс: <s>${fmtPrice(tariff.price)}</s> → <b>${fmtPrice(effectivePrice)}</b> 🎁 <i>акция</i>\n` +
      `🎁 Ваша скидка: <b>−${discountPct}%</b>\n` +
      `💳 К оплате: <b>${fmtPrice(finalPrice)}</b>`;
  } else if (hasPromo) {
    priceBlock =
      `💰 Прайс: <s>${fmtPrice(tariff.price)}</s> → <b>${fmtPrice(effectivePrice)}</b> 🎁 <i>акция</i>\n` +
      `💳 К оплате: <b>${fmtPrice(finalPrice)}</b>`;
  } else if (discountPct > 0) {
    priceBlock =
      `💰 Прайс: <s>${fmtPrice(tariff.price)}</s>\n` +
      `🎁 Ваша скидка: <b>−${discountPct}%</b>\n` +
      `💳 К оплате: <b>${fmtPrice(finalPrice)}</b>`;
  } else {
    priceBlock = `💰 Сумма: <b>${fmtPrice(finalPrice)}</b>`;
  }

  await ctx.editMessageText(
    `📋 <b>Аренда SUP-борда</b>\n\n` +
    `🏄 Доска: <b>${board.code}</b>\n` +
    `📍 Точка: ${board.spot.name}\n` +
    `⏱ Тариф: ${tariff.name} (${fmtDuration(tariff.durationMinutes)})\n` +
    priceBlock + `\n\n` +
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

/**
 * Принятие ТБ → создание аренды.
 *
 * 1. Создаёт аренду (атомарная транзакция в сервисе)
 * 2. Переводит в статус WAIT_PAYMENT
 * 3. Отправляет QR-код MBank с кнопкой «Я оплатил»
 * 4. После нажатия «Я оплатил» → submitPayment + уведомление админам
 */
rentalHandlers.callbackQuery(/^rent:accept_safety:(\d+):(\d+)$/, async (ctx) => {
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

  let rental;
  try {
    ({ rental } = await rentalService.createRental({
      userId: ctx.dbUser!.id,
      spotId: board.spotId,
      boardId: board.id,
      tariffId: tariff.id,
    }));
  } catch {
    // Доска уже занята: проверим, не наша ли это собственная аренда
    const activeOwn = await prisma.rental.findFirst({
      where: {
        boardId: board.id,
        userId: ctx.dbUser!.id,
        status: { in: ["CREATED", "WAIT_PAYMENT", "WAIT_ADMIN", "RENTED", "WAIT_RETURN"] },
      },
      orderBy: { createdAt: "desc" },
    });

    const kb = new InlineKeyboard();
    let msg: string;
    if (activeOwn) {
      msg =
        `⚠️ У вас уже есть активная аренда на доске <b>${board.code}</b>.\n\n` +
        `Откройте её в «Моих арендах», чтобы продолжить.`;
      kb.text("📋 Мои аренды", "client:my_list").row();
    } else {
      msg =
        `⚠️ Доска <b>${board.code}</b> только что была занята другим клиентом.\n\n` +
        `Попробуйте выбрать другую свободную доску.`;
      kb.text("🏄 Другие доски", "client:boards").row();
    }
    kb.text("⬅️ Меню", "back:menu");

    return ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: kb });
  }

  await rentalService.moveToWaitPayment(rental.id, ctx.dbUser!.id);

  // Строим блок «Тариф» с учётом акции и личной скидки
  const effectivePrice = rental.tariffPriceKgs ?? tariff.price; // цена после акции, до скидки клиента
  const originalPrice = rental.tariffOriginalPriceKgs; // цена до акции (null если акции не было)
  const priceToPay = rental.basePriceKgs ?? effectivePrice;

  let tariffBlock = `⏱ Тариф: ${tariff.name} (${fmtDuration(tariff.durationMinutes)})\n`;
  if (originalPrice && originalPrice > effectivePrice) {
    tariffBlock += `💰 Прайс: <s>${fmtPrice(originalPrice)}</s> → <b>${fmtPrice(effectivePrice)}</b> 🎁 <i>акция</i>\n`;
  } else {
    tariffBlock += `💰 Прайс: <b>${fmtPrice(effectivePrice)}</b>\n`;
  }
  if (rental.discountPercent > 0) {
    tariffBlock += `🎁 Скидка клиента: <b>−${rental.discountPercent}%</b>\n`;
  }

  await ctx.editMessageText(
    `📋 <b>Аренда #${rental.id}</b>\n\n` +
    `🏄 Доска: ${board.code}\n` +
    `📍 Точка: ${board.spot.name}\n` +
    tariffBlock +
    `💳 К оплате: <b>${fmtPrice(priceToPay)}</b>\n\n` +
    `💳 Оплатите по QR-коду ниже через MBank.\n` +
    `После оплаты нажмите <b>«✅ Я оплатил»</b>.`,
    { parse_mode: "HTML" }
  );

  await sendMBankQR(ctx, priceToPay, rental.id);
});

/**
 * Клиент нажал «Я оплатил» → создаём/находим запись об оплате и уведомляем админов.
 *
 * Работает для двух сценариев:
 *  - Первичная оплата аренды (WAIT_PAYMENT) → submitPayment + уведомление
 *  - Оплата просрочки (WAIT_RETURN) → proof уже создан → только уведомление
 */
rentalHandlers.callbackQuery(/^rent:paid:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  const rental = await prisma.rental.findUnique({
    where: { id: rentalId },
    include: { board: true, spot: true, tariff: true },
  });

  if (!rental || rental.userId !== ctx.dbUser!.id) {
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    return ctx.reply("⚠️ Аренда не найдена.");
  }

  let proofId: number;

  if (rental.status === "WAIT_PAYMENT") {
    const { proof } = await rentalService.submitPayment({
      rentalId: rental.id,
      userId: ctx.dbUser!.id,
      amount: rental.basePriceKgs ?? rental.tariff!.price,
    });
    proofId = proof.id;
  } else if (rental.status === "WAIT_RETURN" || rental.status === "RETURNED") {
    const existingProof = await prisma.paymentProof.findFirst({
      where: { kind: "OVERDUE", refId: rentalId, status: "SUBMITTED" },
      orderBy: { createdAt: "desc" },
    });
    if (!existingProof) {
      try { await ctx.deleteMessage(); } catch { /* ignore */ }
      return ctx.reply("⚠️ Заявка на оплату просрочки не найдена.", {
        reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
      });
    }
    proofId = existingProof.id;
  } else {
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    return ctx.reply("⚠️ Оплата уже была отправлена или аренда отменена.", {
      reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
    });
  }

  const amount = rental.tariff ? fmtPrice(rental.basePriceKgs ?? rental.tariff.price) : "—";

  try { await ctx.deleteMessage(); } catch { /* ignore */ }
  await ctx.reply(
    `✅ <b>Заявка на оплату отправлена!</b>\n\n` +
    `📋 Аренда #${rental.id}\n` +
    `🏄 Доска: ${rental.board.code}\n` +
    `💰 Сумма: <b>${amount}</b>\n\n` +
    `⏳ Ожидайте подтверждения от администратора.\n` +
    `Вам придёт уведомление, когда оплата будет подтверждена.`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("⬅️ Меню", "back:menu"),
    }
  );

  // Уведомление клиенту в колокольчик
  await prisma.notification.create({
    data: {
      userId: ctx.dbUser!.id,
      text: `💳 Оплата #${proofId} отправлена на проверку — ${rental.board.code}`,
    },
  });

  await notifyAdminsNewPayment(ctx, proofId);
});

/**
 * Обработчик фото от клиента.
 *
 * Два сценария:
 *  1. Клиент в чате с админом → фото пересылается всем админам
 *  2. Есть ожидающий платёж без фото → фото привязывается к нему
 */
rentalHandlers.on("message:photo", async (ctx) => {
  // Если в чате с админом — пересылаем фото
  if (ctx.session.clientChat?.mode === 'payment') {
    const proofId = ctx.session.clientChat.proofId;
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const userName = escapeHtml(ctx.dbUser?.name ?? "Клиент");
    try {
      const admins = await prisma.user.findMany({ where: { role: Role.ADMIN } });
      await Promise.all(admins.map((admin) =>
        ctx.api.sendPhoto(Number(admin.tgId), fileId, {
          caption: `📎 <b>${userName}</b> (оплата #${proofId}) отправил(а) фото`,
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("✅ Подтвердить оплату", `pay:approve:${proofId}`)
            .text("❌ Отклонить", `pay:reject:${proofId}`)
            .row()
            .text("💬 Ответить", `admin:chat_client:${proofId}`),
        }).catch((e) => console.error('[rental] Ошибка отправки фото админу:', e))
      ));
      await ctx.reply("✅ Фото отправлено администратору.");
    } catch {
      await ctx.reply("⚠️ Не удалось отправить фото.");
    }
    return;
  }

  // Привязываем фото к последнему ожидающему платежу
  const latestProof = await prisma.paymentProof.findFirst({
    where: { userId: ctx.dbUser!.id, status: "SUBMITTED", fileId: null },
    orderBy: { createdAt: "desc" },
  });

  if (!latestProof) return;

  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  await prisma.paymentProof.update({
    where: { id: latestProof.id },
    data: { fileId },
  });

  await ctx.reply("📎 Фото чека прикреплено к заявке. Ожидайте подтверждения.", {
    reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
  });
});

/**
 * Отмена аренды (до подтверждения оплаты) — шаг 1: подтверждение.
 *
 * Сообщение с QR-кодом оплаты — это фото; отредактировать его через editMessageText
 * нельзя, поэтому удаляем старое и показываем экран подтверждения.
 */
rentalHandlers.callbackQuery(/^rent:cancel:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  const rental = await prisma.rental.findUnique({
    where: { id: rentalId },
    include: { board: true, tariff: true },
  });

  if (!rental || rental.userId !== ctx.dbUser!.id) {
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    return ctx.reply("⚠️ Аренда не найдена.", {
      reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
    });
  }

  try { await ctx.deleteMessage(); } catch { /* ignore */ }

  const kb = new InlineKeyboard()
    .text("✅ Да, отменить", `rent:cancel_confirm:${rentalId}`)
    .text("⬅️ Назад", "back:menu");

  const amount = rental.tariff ? fmtPrice(rental.basePriceKgs ?? rental.tariff.price) : "—";
  await ctx.reply(
    `❓ <b>Отменить аренду?</b>\n\n` +
    `🏄 Доска: <b>${rental.board.code}</b>\n` +
    `💰 Сумма: ${amount}\n\n` +
    `После отмены доска снова станет доступна другим клиентам.`,
    { parse_mode: "HTML", reply_markup: kb },
  );
});

/** Отмена аренды — шаг 2: финальное действие */
rentalHandlers.callbackQuery(/^rent:cancel_confirm:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);
  try {
    await rentalService.cancelRental(rentalId, ctx.dbUser!.id, true);
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    await ctx.reply("❌ Аренда отменена.", {
      reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
    });
  } catch (e: any) {
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    await ctx.reply(`⚠️ ${e.message}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
    });
  }
});
