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

import { Composer, GrammyError, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import {
  fmtDuration, fmtPrice, escapeHtml, paginate, addPaginationRow,
} from "../../ui/helpers";
import * as rentalService from "../../services/rental";
import * as audit from "../../services/audit";
import { getNotifications } from "../../services/notify";
import { startOfDayBishkek } from "../../services/reports";
import { mainMenuKeyboard } from "../../ui/keyboards";
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
  const modeLabel = testMode ? "🧪 Тестовый режим" : "🟢 Рабочий режим";
  let text = `📋 <b>Панель управления</b>\n⚙️ Режим: <b>${modeLabel}</b>\n\n`;

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
  if (activeRentals > 0) {
    kb.text(`🏄 Все в аренде (${activeRentals})`, "seller:rented").row();
  }
  const modeBtn = testMode
    ? "🟢 Режим → Рабочий"
    : "🧪 Режим → Тестовый";
  kb.text(modeBtn, "admin:toggle_mode").row();
  kb.text("⬅️ Меню", "back:menu").text("🧹 Убрать лишнее", "clear:chat");

  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch (e) {
    if (e instanceof GrammyError && e.description.includes("message is not modified")) return;
    throw e;
  }
}

/** Открытие панели управления */
dashboardHandlers.callbackQuery("admin:dashboard", async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderDashboard(ctx);
});

/**
 * Экран выбора режима — показывает текущий и кнопки переключения.
 */
dashboardHandlers.callbackQuery("admin:mode", async (ctx) => {
  await ctx.answerCallbackQuery();
  const testMode = await rentalService.isTestMode();
  const current = testMode ? "🧪 Тестовый" : "🟢 Рабочий";

  const kb = new InlineKeyboard();
  if (testMode) {
    kb.text("🟢 Переключить на Рабочий", "admin:set_mode:work").row();
  } else {
    kb.text("🧪 Переключить на Тестовый", "admin:set_mode:test").row();
  }
  kb.text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(
    `⚙️ <b>Режим работы</b>\n\nТекущий: <b>${current}</b>`,
    { parse_mode: "HTML", reply_markup: kb },
  );
});

/**
 * Переключение режима ТЕСТ ↔ РАБОТА.
 *
 * Обновляет длительность и название первых N тарифов в БД.
 * Сбрасывает кэш isTestMode и записывает действие в аудит.
 */
dashboardHandlers.callbackQuery(/^admin:set_mode:(work|test)$/, async (ctx) => {
  const wantTest = ctx.match[1] === "test";
  const testMode = await rentalService.isTestMode();

  // Уже в нужном режиме
  if (wantTest === testMode) {
    await ctx.answerCallbackQuery({ text: "Уже в этом режиме" });
    return;
  }

  const target = wantTest ? TEST_TARIFFS : WORK_TARIFFS;

  const existing = await prisma.tariff.findMany({ orderBy: { price: "asc" } });

  await Promise.all(
    existing.slice(0, target.length).map((t, i) =>
      prisma.tariff.update({
        where: { id: t.id },
        data: { durationMinutes: target[i].durationMinutes, name: target[i].name },
      })
    )
  );

  const newMode = wantTest ? "🧪 Тестовый" : "🟢 Рабочий";
  rentalService.clearTestModeCache();
  await audit.log(ctx.dbUser!.id, "system", 0, AuditAction.MODE_TOGGLED, { mode: newMode });
  await ctx.answerCallbackQuery({ text: `Режим: ${newMode}` });

  // Показываем экран режима с обновлённым состоянием
  const kb = new InlineKeyboard();
  if (wantTest) {
    kb.text("🟢 Переключить на Рабочий", "admin:set_mode:work").row();
  } else {
    kb.text("🧪 Переключить на Тестовый", "admin:set_mode:test").row();
  }
  kb.text("⬅️ Меню", "back:menu");

  try {
    await ctx.editMessageText(
      `⚙️ <b>Режим работы</b>\n\nТекущий: <b>${newMode}</b>\n\n✅ Режим переключён.`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  } catch (e) {
    if (e instanceof GrammyError && e.description.includes("message is not modified")) return;
    throw e;
  }
});

/** Определяет иконку по содержимому уведомления */
function notifyIcon(text: string): string {
  if (text.includes("подтверждена") || text.includes("Приятного катания") || text.includes("одобрен")) return "✅";
  if (text.includes("отклонена") || text.includes("отменена") || text.includes("Отменена")) return "❌";
  if (text.includes("Просрочка") || text.includes("просрочк")) return "⚠️";
  if (text.includes("истекло") || text.includes("истекает") || text.includes("Время")) return "⏰";
  if (text.includes("Напоминание") || text.includes("верните") || text.includes("возврат")) return "🔙";
  if (text.includes("Новая оплата") || text.includes("оплат")) return "💳";
  if (text.includes("продлен") || text.includes("Продлен")) return "🔄";
  if (text.includes("досрочно") || text.includes("завершает")) return "🏁";
  if (text.includes("Walk-in") || text.includes("walk-in")) return "🚶";
  return "🔔";
}

/** Уведомления администратора за последние 24 часа с пагинацией */
dashboardHandlers.callbackQuery(/^admin:notifications(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => { });
  const page = parseInt(ctx.match?.[2] ?? "1");
  const userId = ctx.dbUser!.id;
  const allItems = await getNotifications(userId);

  const paged = paginate(allItems, page, 8);
  // Внутри страницы новые внизу (удобно читать)
  const items = [...paged.items].reverse();

  let text = `🔔 <b>Уведомления</b> (${allItems.length})\n`;
  if (allItems.length === 0) {
    text += "\nНет уведомлений за последние 24 часа.";
  } else {
    text += "\n";
    for (const n of items) {
      const time = n.createdAt.toLocaleTimeString("ru-RU", {
        timeZone: config.TIMEZONE,
        hour: "2-digit",
        minute: "2-digit",
      });
      const date = n.createdAt.toLocaleDateString("ru-RU", {
        timeZone: config.TIMEZONE,
        day: "2-digit",
        month: "2-digit",
      });
      const icon = notifyIcon(n.text);
      const shortText = n.text.length > 120 ? n.text.slice(0, 117) + "..." : n.text;
      text += `<code>${date} ${time}</code>\n${icon} ${shortText}\n\n`;
    }
  }

  const kb = new InlineKeyboard();
  addPaginationRow(kb, paged.page, paged.totalPages, "admin:notifications:");
  kb.row().text("🔄 Обновить", "admin:notifications").text("⬅️ Меню", "back:menu");
  kb.row().text("🧹 Убрать лишнее", "clear:chat");

  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch (e: any) {
    if (!e.description?.includes("message is not modified")) throw e;
  }
});

/* ────────────────────────── История транзакций ────────────────────────── */

/** Финансовые действия для истории транзакций */
const TX_ACTIONS = [
  AuditAction.PAYMENT_APPROVED,
  AuditAction.PAYMENT_REJECTED,
  AuditAction.EXTENDED,
  AuditAction.CLOSE_OVERDUE,
];

/** Форматирование времени */
function fmtTime(d: Date): string {
  return d.toLocaleTimeString("ru-RU", {
    timeZone: config.TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Левое выравнивание текста кнопки (добираем до ширины пробелами) */
function padBtn(text: string, width = 38): string {
  const pad = Math.max(0, width - text.length);
  return text + " ".repeat(pad);
}

/** Короткое название вида оплаты */
function shortKind(kind: unknown): string {
  const map: Record<string, string> = { RENTAL: "аренда", OVERDUE: "просрочка", EXTENSION: "продление", BOOKING: "бронь" };
  return map[String(kind)] ?? "";
}

/**
 * Формирует подпись для кнопки финансовой транзакции.
 * Использует meta из аудита для показа суммы, вида, причины.
 */
function txButtonLabel(log: { action: AuditAction; metaJson: unknown }): { icon: string; label: string } {
  const meta = log.metaJson as Record<string, unknown> | null;

  switch (log.action) {
    case AuditAction.PAYMENT_APPROVED: {
      const amount = typeof meta?.amount === "number" ? ` ${fmtPrice(meta.amount)}` : "";
      const kind = meta?.kind ? ` · ${shortKind(meta.kind)}` : "";
      return { icon: "✅", label: `Оплата${amount}${kind}` };
    }
    case AuditAction.PAYMENT_REJECTED: {
      const kind = meta?.kind ? ` · ${shortKind(meta.kind)}` : "";
      return { icon: "❌", label: `Отклонено${kind}` };
    }
    case AuditAction.CLOSE_OVERDUE: {
      const cost = typeof meta?.overdueCost === "number" ? ` ${fmtPrice(meta.overdueCost)}` : "";
      return { icon: "⚠️", label: `Закрытие просрочки${cost}` };
    }
    case AuditAction.EXTENDED: {
      const net = typeof meta?.netMinutes === "number" ? meta.netMinutes : 0;
      const cost = typeof meta?.extensionCost === "number" ? ` ${fmtPrice(meta.extensionCost)}` : "";
      if (net > 0) {
        return { icon: "⏱", label: `Продление +${fmtDuration(net)}${cost}` };
      }
      return { icon: "⚠️", label: `Закрытие просрочки${cost}` };
    }
    default:
      return { icon: "📝", label: String(log.action) };
  }
}

/**
 * История транзакций — только финансовые операции.
 * Кнопки с левым выравниванием, новые внизу на первой странице.
 */
dashboardHandlers.callbackQuery(/^admin:transactions(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = parseInt(ctx.match?.[2] ?? "1");
  const pageSize = 8;

  const todayStart = startOfDayBishkek();

  const where = {
    createdAt: { gte: todayStart },
    action: { in: TX_ACTIONS },
  };

  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const sorted = [...items].reverse();

  let text = `📜 <b>История транзакций</b> — сегодня (${total})`;
  if (sorted.length === 0) {
    text += "\n\nНет финансовых операций за сегодня.";
  }

  const kb = new InlineKeyboard();
  for (const log of sorted) {
    const time = fmtTime(log.createdAt);
    const { icon, label } = txButtonLabel(log);
    kb.text(padBtn(`${time}  ${icon} ${label}`), `admin:tx:${log.id}`).row();
  }

  addPaginationRow(kb, page, totalPages, "admin:transactions:");
  kb.row().text("🔄 Обновить", "admin:transactions").text("⬅️ Меню", "back:menu");
  kb.row().text("🧹 Убрать лишнее", "clear:chat");

  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch (e: any) {
    if (!e.description?.includes("message is not modified")) throw e;
  }
});

/**
 * Детальная карточка финансовой транзакции.
 * Показывает полную информацию: сумма, доска, клиент, что произошло.
 */
dashboardHandlers.callbackQuery(/^admin:tx:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const logId = parseInt(ctx.match[1]);

  const log = await prisma.auditLog.findUnique({
    where: { id: logId },
    include: { actor: true },
  });
  if (!log) return ctx.editMessageText("⚠️ Запись не найдена.");

  const meta = log.metaJson as Record<string, unknown> | null;
  const { icon, label } = txButtonLabel(log);
  const time = fmtTime(log.createdAt);
  const date = log.createdAt.toLocaleDateString("ru-RU", {
    timeZone: config.TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  let text = `${icon} <b>${label}</b>\n\n`;
  text += `🕐 <b>Время:</b> ${date} ${time}\n`;
  text += `👤 <b>Выполнил:</b> ${escapeHtml(log.actor.name)}\n`;

  // ─── PAYMENT_APPROVED / PAYMENT_REJECTED ───
  if (log.action === AuditAction.PAYMENT_APPROVED || log.action === AuditAction.PAYMENT_REJECTED) {
    const proof = await prisma.paymentProof.findUnique({
      where: { id: log.entityId },
      include: { user: true, reviewer: true },
    });
    if (proof) {
      const kindMap: Record<string, string> = {
        RENTAL: "🏄 Аренда",
        OVERDUE: "⚠️ Просрочка",
        EXTENSION: "⏱ Продление",
        BOOKING: "📋 Бронь",
      };
      text += `\n📦 <b>Тип:</b> ${kindMap[proof.kind] ?? proof.kind}\n`;
      text += `💵 <b>Сумма:</b> ${fmtPrice(proof.amount)}\n`;
      text += `👤 <b>Клиент:</b> ${escapeHtml(proof.user.name)}\n`;

      if (proof.reviewer) {
        text += `🔑 <b>Проверил:</b> ${escapeHtml(proof.reviewer.name)}\n`;
      }

      // Причина отклонения: из PaymentProof.text или из meta.reason (fallback)
      if (log.action === AuditAction.PAYMENT_REJECTED) {
        const reason = proof.text || (typeof meta?.reason === "string" ? meta.reason : null);
        if (reason) {
          text += `\n❌ <b>Причина:</b> ${escapeHtml(reason)}\n`;
        } else {
          text += `\n❌ Причина не указана\n`;
        }
      }

      const rental = await prisma.rental.findUnique({
        where: { id: proof.refId },
        include: { board: true, user: true, tariff: true },
      });
      if (rental) {
        text += `\n<b>── Аренда ──</b>\n`;
        text += `🏄 <b>Доска:</b> ${rental.board.code}\n`;
        text += `👤 <b>Клиент:</b> ${escapeHtml(rental.clientName ?? rental.user.name)}\n`;
        if (rental.tariff) {
          text += `⏱ <b>Тариф:</b> ${rental.tariff.name} — ${fmtPrice(rental.tariff.price)}\n`;
        }
      }
    }
  }

  // ─── EXTENDED ───
  if (log.action === AuditAction.EXTENDED) {
    const addedMinutes = typeof meta?.addedMinutes === "number" ? meta.addedMinutes : 0;
    const extensionCost = typeof meta?.extensionCost === "number" ? meta.extensionCost : 0;
    const overdueMinutes = typeof meta?.overdueMinutes === "number" ? meta.overdueMinutes : 0;
    const netMinutes = typeof meta?.netMinutes === "number" ? meta.netMinutes : 0;

    text += `\n💵 <b>Оплачено:</b> ${fmtPrice(extensionCost)}\n`;
    text += `⏱ <b>Куплено времени:</b> ${fmtDuration(addedMinutes)}\n`;

    if (overdueMinutes > 0) {
      text += `⚠️ <b>Списано на просрочку:</b> ${fmtDuration(overdueMinutes)}\n`;
    }

    if (netMinutes > 0) {
      text += `✅ <b>Добавлено к аренде:</b> ${fmtDuration(netMinutes)}\n`;
    } else {
      text += `\n📝 Всё оплаченное время ушло на покрытие просрочки.\n`;
    }

    const rental = await prisma.rental.findUnique({
      where: { id: log.entityId },
      include: { board: true, user: true },
    });
    if (rental) {
      text += `\n<b>── Аренда ──</b>\n`;
      text += `🏄 <b>Доска:</b> ${rental.board.code}\n`;
      text += `👤 <b>Клиент:</b> ${escapeHtml(rental.clientName ?? rental.user.name)}\n`;
    }
  }

  // ─── CLOSE_OVERDUE ───
  if (log.action === AuditAction.CLOSE_OVERDUE) {
    const overdueMinutes = typeof meta?.overdueMinutes === "number" ? meta.overdueMinutes : 0;
    const overdueCost = typeof meta?.overdueCost === "number" ? meta.overdueCost : 0;

    text += `\n⏰ <b>Время просрочки:</b> ${fmtDuration(overdueMinutes)}\n`;
    text += `💵 <b>Стоимость:</b> ${fmtPrice(overdueCost)}\n`;

    const rental = await prisma.rental.findUnique({
      where: { id: log.entityId },
      include: { board: true, user: true },
    });
    if (rental) {
      text += `\n<b>── Аренда ──</b>\n`;
      text += `🏄 <b>Доска:</b> ${rental.board.code}\n`;
      text += `👤 <b>Клиент:</b> ${escapeHtml(rental.clientName ?? rental.user.name)}\n`;
    }
  }

  const kb = new InlineKeyboard()
    .text("⬅️ К списку", "admin:transactions")
    .text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});
