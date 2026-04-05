/**
 * Клиентские вспомогательные функции.
 *
 * Содержит общие утилиты, используемые в разных частях клиентского модуля:
 * - handleRentalByQR — начало аренды по коду доски (QR / deep-link / ручной ввод)
 * - notifyAdminsNewPayment — рассылка всем админам о новом платеже
 * - sendMBankQR — отправка QR-кода MBank клиенту для оплаты
 */

import path from "path";
import { InlineKeyboard, InputFile } from "grammy";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import { BoardStatus, Role } from "@prisma/client";
import { fmtPrice, fmtDuration } from "../../ui/helpers";

/** Путь к файлу QR-кода MBank на диске */
const MBANK_QR_PATH = path.join(__dirname, "..", "..", "..", "qr-bank", "mbank_qr.jpeg");

/**
 * Начало аренды по коду доски.
 *
 * Вызывается из:
 *  - deep link `/start?startapp=SUP-XX`
 *  - кнопки «Арендовать» в списке досок
 *  - ручного ввода кода доски
 *
 * Проверяет доступность доски и показывает список тарифов.
 */
export async function handleRentalByQR(ctx: BotContext, boardCode: string) {
  if (ctx.dbUser?.role === "ADMIN" || ctx.dbUser?.role === "CASHIER") {
    return ctx.reply("⛔ Администратор и кассир не могут арендовать доски.");
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
    where: { spotId: board.spotId, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { durationMinutes: "asc" }],
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

/**
 * Уведомляет всех админов о новом платеже.
 *
 * Для каждого админа:
 *  1. Создаёт запись в таблице уведомлений (колокольчик в меню)
 *  2. Отправляет Telegram-сообщение с фото чека (если есть) и кнопками
 *     «Подтвердить» / «Отклонить» / «Запросить инфо»
 */
export async function notifyAdminsNewPayment(ctx: BotContext, proofId: number) {
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
  } else if (proof.kind === "OVERDUE") {
    const rental = await prisma.rental.findUnique({
      where: { id: proof.refId },
      include: { board: true, spot: true },
    });
    refText = rental
      ? `⏰ Просрочка по аренде #${rental.id}\nДоска: ${rental.board.code}\nТочка: ${rental.spot.name}`
      : `Просрочка по аренде #${proof.refId}`;
  } else if (proof.kind === "EXTENSION") {
    const rental = await prisma.rental.findUnique({
      where: { id: proof.refId },
      include: { board: true, spot: true },
    });
    refText = rental
      ? `⏱ Продление аренды #${rental.id}\nДоска: ${rental.board.code}\nТочка: ${rental.spot.name}`
      : `Продление аренды #${proof.refId}`;
  } else {
    refText = `Платёж #${proof.refId}`;
  }

  const text =
    `💳 <b>Новая заявка на оплату #${proof.id}</b>\n\n` +
    `👤 ${proof.user.name} (tg: ${proof.user.tgId})\n` +
    `📋 ${refText}\n` +
    `💰 Сумма: ${fmtPrice(proof.amount)}`;

  const kb = new InlineKeyboard()
    .text("💰 Открыть кассу", "cashier:payments");

  const adminsAndCashiers = await prisma.user.findMany({
    where: { role: { in: [Role.ADMIN, Role.CASHIER] } },
  });
  await Promise.all(adminsAndCashiers.map(async (user) => {
    await prisma.notification.create({
      data: {
        userId: user.id,
        text: `💳 Новая оплата #${proof.id} от ${proof.user.name} — ${fmtPrice(proof.amount)}`,
      },
    });

    // Push-сообщение отправляем только кассирам, админам — только уведомление в колокольчик
    if (user.role !== Role.CASHIER) return;

    try {
      proof.fileId
        ? await ctx.api.sendPhoto(Number(user.tgId), proof.fileId, {
          caption: text,
          parse_mode: "HTML",
          reply_markup: kb,
        })
        : await ctx.api.sendMessage(Number(user.tgId), text, {
          parse_mode: "HTML",
          reply_markup: kb,
        });
    } catch (e) {
      console.error(`Failed to notify user ${user.tgId}:`, e);
    }
  }));
}

/**
 * Отправляет клиенту QR-код MBank для оплаты указанной суммы.
 *
 * Под QR-кодом — кнопки «Я оплатил» и «Отмена».
 * Если файл QR-кода не найден на диске, отправляет текстовое сообщение.
 *
 * @param kind — 'rental' (по умолчанию) или 'extension' — определяет callback-prefix
 */
export async function sendMBankQR(ctx: BotContext, amount: number, rentalId: number, kind: "rental" | "extension" = "rental") {
  const paidCb = kind === "extension" ? `ext:paid:${rentalId}` : `rent:paid:${rentalId}`;
  const cancelCb = kind === "extension" ? `client:my_detail:${rentalId}` : `rent:cancel:${rentalId}`;

  const kb = new InlineKeyboard()
    .text("✅ Я оплатил", paidCb)
    .row()
    .text("❌ Отмена", cancelCb)
    .text("⬅️ Меню", "back:menu");

  try {
    await ctx.replyWithPhoto(new InputFile(MBANK_QR_PATH), {
      caption:
        `💳 <b>Оплата: ${fmtPrice(amount)}</b>\n\n` +
        `📱 Отсканируйте QR-код через <b>любой мобильный банкинг</b> (MBank, O!, Бакай и др.)\n` +
        `💵 Или оплатите <b>наличными</b> на точке проката.\n\n` +
        `После оплаты нажмите <b>«✅ Я оплатил»</b>.`,
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } catch (e) {
    console.error("[helpers] Failed to send MBank QR:", e);
    await ctx.reply(
      `💳 К оплате: <b>${fmtPrice(amount)}</b>\n\n` +
      `📱 Оплатите через <b>мобильный банкинг</b> или 💵 <b>наличными</b> на точке.\n` +
      `После оплаты нажмите <b>«✅ Я оплатил»</b>.`,
      { parse_mode: "HTML", reply_markup: kb }
    );
  }
}
