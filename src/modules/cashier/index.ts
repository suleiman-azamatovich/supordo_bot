/**
 * Модуль кассы — единый интерфейс для обработки оплат.
 *
 * Доступен пользователям с ролью CASHIER и ADMIN.
 * Обрабатывает:
 *  - cashier:payments / admin:cashbox — список ожидающих оплат с пагинацией
 *  - cashier:history — история обработанных оплат за сегодня
 *  - cashier:notifications — уведомления кассира
 *  - cashier:photo — просмотр фото чека
 *
 * Интерфейс одинаковый для обеих ролей.
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { guardRole } from "../../bot/middleware";
import { prisma } from "../../db/prisma";
import { fmtPrice, addPaginationRow } from "../../ui/helpers";
import { getNotifications } from "../../services/notify";
import * as paymentService from "../../services/payment";
import { Role, PaymentProofStatus } from "@prisma/client";
import { config } from "../../bot/config";

export const cashierModule = new Composer<BotContext>();

// Проверка оплат доступна и ADMIN, и CASHIER
cashierModule.use(guardRole(Role.CASHIER, Role.ADMIN));

/** Главная страница кассы (общий вход для обеих ролей) */
cashierModule.callbackQuery(/^(cashier:payments|admin:cashbox)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderCashierPayments(ctx, 1);
});

/** Пагинация списка оплат */
cashierModule.callbackQuery(/^cashier:payments:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match[1]);
  await renderCashierPayments(ctx, page);
});

/** Рендер списка ожидающих оплат для кассира */
async function renderCashierPayments(ctx: BotContext, page: number) {
  const chatId = ctx.chat!.id;

  // Удаляем старые карточки оплат и навигацию
  const oldIds = ctx.session.cashierMsgIds ?? [];
  const sourceId = ctx.callbackQuery?.message?.message_id;
  if (sourceId) oldIds.push(sourceId);
  if (oldIds.length > 0) {
    try { await ctx.api.deleteMessages(chatId, oldIds); } catch { }
    ctx.session.cashierMsgIds = [];
  }

  const { items, total, totalPages } = await paymentService.getPendingPayments(page, 5);

  // Отправляем каждую оплату отдельным сообщением с кнопками
  const newMsgIds: number[] = [];
  for (const p of items) {
    const rental = await prisma.rental.findUnique({
      where: { id: p.refId },
      include: { board: true, tariff: true },
    });
    const kindLabel = p.kind === "OVERDUE" ? "⚠️ Просрочка"
      : p.kind === "EXTENSION" ? "⏱ Продление"
      : "🏄 Аренда";
    const boardCode = rental?.board?.code ?? "—";
    const tariffInfo = rental?.tariff ? ` · ${rental.tariff.durationMinutes} мин` : "";
    const extInfo = p.kind === "EXTENSION" && rental?.pendingExtraMinutes
      ? ` · +${rental.pendingExtraMinutes} мин`
      : "";

    let cardText = `<b>#${p.id}</b> ${kindLabel}\n`;
    cardText += `📋 Доска: <b>${boardCode}</b>${tariffInfo}${extInfo}\n`;
    cardText += `👤 ${p.user.name} — <b>${fmtPrice(p.amount)}</b>`;

    const cardKb = new InlineKeyboard();
    if (p.kind === "OVERDUE") {
      cardKb.text(`✅ Подтвердить`, `pay:approve:${p.id}`)
        .text(`🔄 Списать`, `pay:reject:${p.id}`);
    } else {
      cardKb.text(`✅ Подтвердить`, `pay:approve:${p.id}`)
        .text(`❌ Отклонить`, `pay:reject:${p.id}`);
    }

    try {
      const msg = await ctx.api.sendMessage(chatId, cardText, {
        parse_mode: "HTML",
        reply_markup: cardKb,
      });
      newMsgIds.push(msg.message_id);
    } catch (e) {
      console.error(`[cashier] Ошибка отправки карточки #${p.id}:`, e);
    }
  }

  // Навигация внизу (новое сообщение)
  let headerText = `✅ <b>Проверка оплат</b> (${total})`;
  if (items.length === 0) {
    headerText += "\n\n✅ Нет ожидающих оплат.";
  }

  const navKb = new InlineKeyboard();
  addPaginationRow(navKb, page, totalPages, "cashier:payments:");
  navKb.text("🔄 Обновить", "cashier:payments").text("⬅️ Меню", "back:menu");
  navKb.row().text("🧹 Убрать лишнее", "clear:chat");

  try {
    const navMsg = await ctx.api.sendMessage(chatId, headerText, {
      parse_mode: "HTML",
      reply_markup: navKb,
    });
    newMsgIds.push(navMsg.message_id);
  } catch (e) {
    console.error("[cashier] Ошибка отправки навигации:", e);
  }

  ctx.session.cashierMsgIds = newMsgIds;
}

/** История обработанных оплат за сегодня */
cashierModule.callbackQuery(/^cashier:history(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");
  const pageSize = 10;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const where = {
    status: { not: PaymentProofStatus.SUBMITTED },
    reviewedAt: { gte: todayStart },
  };

  const [items, total] = await Promise.all([
    prisma.paymentProof.findMany({
      where,
      orderBy: { reviewedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { user: true },
    }),
    prisma.paymentProof.count({ where }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  let text = `📊 <b>История оплат за сегодня</b> (${total})\n\n`;
  if (items.length === 0) {
    text += "Нет обработанных оплат.";
  } else {
    for (const p of items) {
      const statusIcon = p.status === PaymentProofStatus.APPROVED ? "✅" : "❌";
      const kindLabel = p.kind === "OVERDUE" ? "просрочка"
        : p.kind === "EXTENSION" ? "продление"
        : "аренда";
      const time = p.reviewedAt!.toLocaleTimeString("ru-RU", {
        timeZone: config.TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
      });
      text += `${statusIcon} <code>${time}</code> #${p.id} ${kindLabel} — ${p.user.name} — ${fmtPrice(p.amount)}\n`;
    }
  }

  const kb = new InlineKeyboard();
  addPaginationRow(kb, page, totalPages, "cashier:history:");
  kb.row().text("✅ Проверка оплат", "cashier:payments").text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});

/** Уведомления кассира за последние 24 часа */
cashierModule.callbackQuery("cashier:notifications", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.dbUser!.id;
  const items = await getNotifications(userId);

  let text = "🔔 <b>Уведомления</b>\n\n";
  if (items.length === 0) {
    text += "Нет уведомлений за последние 24 часа.";
  } else {
    for (const n of items) {
      const time = n.createdAt.toLocaleTimeString("ru-RU", {
        timeZone: config.TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
      });
      text += `<code>${time}</code>  ${n.text}\n\n`;
    }
  }

  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text("🔄 Обновить", "cashier:notifications")
      .text("⬅️ Меню", "back:menu"),
  });
});


