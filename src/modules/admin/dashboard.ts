/**
 * Панель управления администратора.
 *
 * Обрабатывает:
 *  - admin:dashboard — основная панель со сводкой по аренде, оплатам, возвратам
 *  - admin:toggle_mode — переключение между режимами ТЕСТ / РАБОТА
 *  - admin:notifications — уведомления админа за 24 часа
 *
 * Панель показывает:
 *  - количество ожидающих оплат
 *  - запросы на продление
 *  - ожидающие возврата
 *  - активные аренды с таймерами
 *  - количество свободных досок
 *  - текущий режим (тест/работа)
 *
 * Переключение ТЕСТ/РАБОТА меняет длительность всех тарифов:
 *  - РАБОТА: 1ч / 1.5ч / 2ч
 *  - ТЕСТ: 1мин / 2мин / 3мин
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import {
  fmtDuration, fmtPrice, escapeHtml,
} from "../../ui/helpers";
import * as rentalService from "../../services/rental";
import * as audit from "../../services/audit";
import { getNotifications } from "../../services/notify";
import { RentalStatus, BoardStatus, PaymentProofStatus, AuditAction } from "@prisma/client";
import { config } from "../../bot/config";

export const dashboardHandlers = new Composer<BotContext>();

/** Тарифы для рабочего режима */
const WORK_TARIFFS = [
  { durationMinutes: 60, name: "1 час" },
  { durationMinutes: 90, name: "1,5 часа" },
  { durationMinutes: 120, name: "2 часа" },
];

/** Тарифы для тестового режима (укороченные для проверки) */
const TEST_TARIFFS = [
  { durationMinutes: 1, name: "1 мин" },
  { durationMinutes: 2, name: "2 мин" },
  { durationMinutes: 3, name: "3 мин" },
];

/**
 * Рендерит панель управления — сводку по текущему состоянию системы.
 * Используется в admin:dashboard и admin:toggle_mode.
 */
async function renderDashboard(ctx: BotContext) {
  const [pendingPayments, activeRentals, waitReturns, availableBoards, totalBoards, pendingExtensions, testMode] = await Promise.all([
    prisma.paymentProof.count({ where: { status: PaymentProofStatus.SUBMITTED } }),
    prisma.rental.count({ where: { status: RentalStatus.RENTED } }),
    prisma.rental.count({ where: { status: RentalStatus.WAIT_RETURN } }),
    prisma.board.count({ where: { status: BoardStatus.AVAILABLE } }),
    prisma.board.count(),
    prisma.rental.count({ where: { pendingExtraMinutes: { not: null } } }),
    rentalService.isTestMode(),
  ]);

  const now = new Date();
  const modeLabel = testMode ? "🧪 ТЕСТ" : "🏭 РАБОТА";
  let text = `📋 <b>Панель управления</b>  [${modeLabel}]\n\n`;

  if (pendingPayments > 0) {
    text += `🔔 <b>Ожидают подтверждения оплаты: ${pendingPayments}</b>\n`;
  } else {
    text += `✅ Нет ожидающих оплат\n`;
  }

  if (pendingExtensions > 0) {
    text += `⏱ <b>Запросы продления: ${pendingExtensions}</b>\n`;
  }

  if (waitReturns > 0) {
    text += `⏰ <b>Ожидают возврата: ${waitReturns}</b>\n`;
  }

  text += `\n🏄 В аренде: <b>${activeRentals}</b>\n`;
  text += `✅ Свободных досок: <b>${availableBoards}</b> из ${totalBoards}\n`;

  if (activeRentals > 0 || waitReturns > 0) {
    const rentals = await prisma.rental.findMany({
      where: { status: { in: [RentalStatus.RENTED, RentalStatus.WAIT_RETURN] } },
      include: { board: true, user: true, tariff: true },
      orderBy: { startAt: "asc" },
    });

    text += `\n<b>Активные аренды:</b>\n`;
    for (const r of rentals) {
      const client = escapeHtml(r.clientName ?? r.user.name);
      const isExpired = r.status === RentalStatus.WAIT_RETURN;
      const icon = isExpired ? "⏰" : "🟢";

      text += `${icon} <b>${r.board.code}</b> → ${client}`;
      if (r.startAt && r.tariff) {
        const totalMin = r.tariff.durationMinutes + (r.extraMinutes ?? 0);
        const endAt = new Date(r.startAt.getTime() + totalMin * 60_000);
        const remaining = Math.max(0, Math.ceil((endAt.getTime() - now.getTime()) / 60_000));
        if (isExpired) {
          text += ` — <b>ВОЗВРАТ!</b>`;
        } else if (remaining > 0) {
          text += ` — ${fmtDuration(remaining)}`;
        }
      }
      if (r.pendingExtraMinutes) {
        text += ` ⏱ <i>запрос +${fmtDuration(r.pendingExtraMinutes)}</i>`;
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
  const modeBtn = testMode
    ? "🏭 Переключить на РАБОТУ"
    : "🧪 Переключить на ТЕСТ";
  kb.text(modeBtn, "admin:toggle_mode").row();
  kb.text("🔄 Обновить", "admin:dashboard").row();
  kb.text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
}

/** Открытие панели управления */
dashboardHandlers.callbackQuery("admin:dashboard", async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderDashboard(ctx);
});

/**
 * Переключение режима ТЕСТ ↔ РАБОТА.
 *
 * Обновляет длительность и название первых N тарифов в БД.
 * Сбрасывает кэш isTestMode и записывает действие в аудит.
 */
dashboardHandlers.callbackQuery("admin:toggle_mode", async (ctx) => {
  const testMode = await rentalService.isTestMode();
  const target = testMode ? WORK_TARIFFS : TEST_TARIFFS;

  const existing = await prisma.tariff.findMany({ orderBy: { price: "asc" } });

  await Promise.all(
    existing.slice(0, target.length).map((t, i) =>
      prisma.tariff.update({
        where: { id: t.id },
        data: { durationMinutes: target[i].durationMinutes, name: target[i].name },
      })
    )
  );

  const newMode = testMode ? "🏭 РАБОТА" : "🧪 ТЕСТ";
  rentalService.clearTestModeCache();
  await audit.log(ctx.dbUser!.id, "system", 0, AuditAction.MODE_TOGGLED, { mode: newMode });
  await ctx.answerCallbackQuery({ text: `Режим: ${newMode}` });
  await renderDashboard(ctx);
});

/** Уведомления администратора за последние 24 часа */
dashboardHandlers.callbackQuery("admin:notifications", async (ctx) => {
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
      .text("🔄 Обновить", "admin:notifications")
      .text("⬅️ Меню", "back:menu"),
  });
});
