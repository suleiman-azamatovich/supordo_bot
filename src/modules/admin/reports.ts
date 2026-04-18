/**
 * Отчёты (администратор) — реформированный раздел.
 *
 * UX:
 *  - Хаб `admin:reports`: компактная карточка «сегодня vs вчера» +
 *    быстрые переходы (Вчера, 7 дней, 30 дней, Детали сегодня, Календарь).
 *  - Детальный отчёт дня: полная сводка с навигацией по соседним дням.
 *  - Периодные отчёты 7/30 дней: мини-график, сравнение с предыдущим периодом.
 *  - Календарь месяца: визуальный выбор любой даты.
 *
 * Callback-карта:
 *  - admin:reports                — хаб
 *  - admin:report_today           — детальный отчёт за сегодня
 *  - admin:report:YYYY-MM-DD      — детальный отчёт за день
 *  - admin:period:7 | 30          — период
 *  - admin:cal:YYYY-MM            — календарь месяца
 */

import { Composer, GrammyError, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import * as reports from "../../services/reports";
import { fmtPrice } from "../../ui/helpers";
import { config } from "../../bot/config";

export const reportsHandlers = new Composer<BotContext>();

/**
 * Безопасный `editMessageText` — игнорирует ошибку Telegram "message is not modified",
 * которая возникает при нажатии кнопки «🔄 Обновить» на том же экране.
 */
async function safeEdit(
  ctx: BotContext,
  text: string,
  reply_markup: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup });
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 400 &&
      err.description.includes("message is not modified")) {
      // Контент идентичен — просто отвечаем на callback, чтобы спиннер ушёл
      return;
    }
    throw err;
  }
}

/** Короткий формат даты: "пн, 18 апр" */
function fmtShortDate(d: Date): string {
  return d.toLocaleDateString("ru-RU", {
    timeZone: config.TIMEZONE,
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
}

/** Вчера относительно указанной даты (сдвиг -24 ч) */
function yesterday(d: Date = new Date()): Date {
  return new Date(d.getTime() - 24 * 60 * 60 * 1000);
}

/** Стрелка сравнения: ↑ +X% / ↓ −X% */
function arrow(cur: number, prev: number): string {
  if (prev === 0) return cur > 0 ? "🆕 новый" : "—";
  const delta = ((cur - prev) / prev) * 100;
  if (Math.abs(delta) < 1) return "≈";
  return delta > 0 ? `↑ +${delta.toFixed(0)}%` : `↓ ${delta.toFixed(0)}%`;
}

/** Ключ месяца YYYY-MM в TZ Бишкека */
function fmtMonthKey(d: Date): string {
  const s = d.toLocaleDateString("en-CA", { timeZone: config.TIMEZONE });
  return s.slice(0, 7);
}

// ────────────────────────────────────────────────────────────
// ХАБ: главная панель отчётов
// ────────────────────────────────────────────────────────────

/** Отрисовать хаб отчётов с компактной карточкой «сегодня vs вчера» */
async function renderHub(ctx: BotContext): Promise<void> {
  const today = new Date();
  const yday = yesterday(today);

  const [todayStats, ydayStats] = await Promise.all([
    reports.quickDayStats(today),
    reports.quickDayStats(yday),
  ]);

  const todayLabel = today.toLocaleDateString("ru-RU", {
    timeZone: config.TIMEZONE, day: "2-digit", month: "long", weekday: "long",
  });

  let text = `📊 <b>Отчёты</b>\n`;
  text += `🗓 Сегодня: ${todayLabel}\n\n`;

  text += `<b>💰 Выручка</b>\n`;
  text += `   Сегодня: <b>${fmtPrice(todayStats.revenue)}</b>  ${arrow(todayStats.revenue, ydayStats.revenue)}\n`;
  text += `   Вчера:   ${fmtPrice(ydayStats.revenue)}\n\n`;

  text += `<b>🏄 Аренды</b>\n`;
  text += `   Сегодня: <b>${todayStats.paidRentals}</b>  ${arrow(todayStats.paidRentals, ydayStats.paidRentals)}\n`;
  text += `   Вчера:   ${ydayStats.paidRentals}\n`;
  if (todayStats.activeRentals > 0) {
    text += `   🔵 Сейчас активны: <b>${todayStats.activeRentals}</b>\n`;
  }

  text += `\n<i>Выберите отчёт ниже:</i>`;

  const kb = new InlineKeyboard()
    .text("📋 Детали за сегодня", "admin:report_today").row()
    .text("🌙 Вчера", `admin:report:${reports.dayKey(yday)}`)
    .text("🔄 Обновить", "admin:reports").row()
    .text("📈 7 дней", "admin:period:7")
    .text("📈 30 дней", "admin:period:30").row()
    .text("📅 Календарь", `admin:cal:${fmtMonthKey(today)}`).row()
    .text("⬅️ Меню", "back:menu");

  await safeEdit(ctx, text, kb);
}

reportsHandlers.callbackQuery("admin:reports", async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderHub(ctx);
});

// ────────────────────────────────────────────────────────────
// ДЕТАЛЬНЫЙ ОТЧЁТ ЗА ДЕНЬ
// ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// ДЕТАЛЬНЫЙ ОТЧЁТ ЗА ДЕНЬ — секционный интерфейс
// ────────────────────────────────────────────────────────────

/** Разделы детального отчёта за день */
type DaySection = "overview" | "revenue" | "rentals" | "payments" | "ext" | "tariffs" | "boards";

/** Добавить ряд навигации по соседним дням */
async function addDayNavRow(kb: InlineKeyboard, day: Date): Promise<void> {
  const key = reports.dayKey(day);
  const [prev, next] = await Promise.all([
    reports.adjacentReportDay(day, "prev"),
    reports.adjacentReportDay(day, "next"),
  ]);
  if (prev) kb.text(`◀ ${fmtShortDate(prev.date)}`, `admin:report:${prev.key}`);
  kb.text("🔄", `admin:report:${key}`);
  if (next) kb.text(`${fmtShortDate(next.date)} ▶`, `admin:report:${next.key}`);
  kb.row();
}

/** Отрисовать обзор дня с кнопками разделов */
async function renderDayReport(ctx: BotContext, day: Date): Promise<void> {
  const data = await reports.dailyReport(day);
  const text = reports.formatDailyOverview(data, day);
  const key = reports.dayKey(day);

  const kb = new InlineKeyboard();

  // Секции — каждая с индикатором количества (бейджем)
  const hasRevenue = data.totalRevenue > 0;
  const hasRentals = data.totalRentals > 0;
  const paymentsTotal = data.approvedPayments + data.rejectedPayments + data.pendingPayments;
  const hasExt = data.extensionCount > 0 || data.overdueCount > 0;
  const hasTariffs = data.tariffStats.size > 0;

  kb.text(
    hasRevenue ? `💰 Выручка (${fmtPrice(data.totalRevenue)})` : "💰 Выручка",
    `admin:rs:${key}:revenue`,
  ).row();

  kb.text(
    hasRentals ? `🏄 Аренды · ${data.totalRentals}` : "🏄 Аренды",
    `admin:rs:${key}:rentals`,
  ).text(
    paymentsTotal > 0 ? `💳 Оплаты · ${paymentsTotal}` : "💳 Оплаты",
    `admin:rs:${key}:payments`,
  ).row();

  kb.text(
    hasExt ? `⏱ Продл/Просрочки · ${data.extensionCount + data.overdueCount}` : "⏱ Продл/Просрочки",
    `admin:rs:${key}:ext`,
  ).row();

  kb.text(
    hasTariffs ? `📋 Тарифы · ${data.tariffStats.size}` : "📋 Тарифы",
    `admin:rs:${key}:tariffs`,
  ).text(
    `🏄 Парк · ${data.totalBoards}`,
    `admin:rs:${key}:boards`,
  ).row();

  await addDayNavRow(kb, day);

  kb.text("📅 Календарь", `admin:cal:${key.slice(0, 7)}`)
    .text("📊 Хаб", "admin:reports").row();
  kb.text("⬅️ Меню", "back:menu");

  await safeEdit(ctx, text, kb);
}

/** Отрисовать конкретную секцию отчёта */
async function renderDaySection(ctx: BotContext, day: Date, section: DaySection): Promise<void> {
  if (section === "overview") {
    return renderDayReport(ctx, day);
  }

  const data = await reports.dailyReport(day);
  const key = reports.dayKey(day);

  let text: string;
  switch (section) {
    case "revenue": text = reports.formatDailyRevenue(data, day); break;
    case "rentals": text = reports.formatDailyRentals(data, day); break;
    case "payments": text = reports.formatDailyPayments(data, day); break;
    case "ext": text = reports.formatDailyExtensionsOverdue(data, day); break;
    case "tariffs": text = reports.formatDailyTariffs(data, day); break;
    case "boards": text = reports.formatDailyBoards(data, day); break;
  }

  const kb = new InlineKeyboard();

  // Кнопки быстрых переходов между разделами (кроме текущего)
  const quickNav: [DaySection, string][] = [
    ["revenue", "💰"], ["rentals", "🏄"], ["payments", "💳"],
    ["ext", "⏱"], ["tariffs", "📋"], ["boards", "📦"],
  ];
  const row = quickNav.filter(([s]) => s !== section);
  for (const [s, emoji] of row) {
    kb.text(emoji, `admin:rs:${key}:${s}`);
  }
  kb.row();

  kb.text("⬅️ К отчёту", `admin:report:${key}`)
    .text("🔄", `admin:rs:${key}:${section}`).row();
  kb.text("📊 Хаб", "admin:reports").text("⬅️ Меню", "back:menu");

  await safeEdit(ctx, text, kb);
}

reportsHandlers.callbackQuery("admin:report_today", async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderDayReport(ctx, new Date());
});

reportsHandlers.callbackQuery(/^admin:report:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const day = reports.parseDayKey(ctx.match[1]);
  if (!day) {
    await ctx.reply("❌ Некорректная дата");
    return;
  }
  await renderDayReport(ctx, day);
});

/** Секция детального отчёта за день: admin:rs:YYYY-MM-DD:section */
reportsHandlers.callbackQuery(
  /^admin:rs:(\d{4}-\d{2}-\d{2}):(revenue|rentals|payments|ext|tariffs|boards)$/,
  async (ctx) => {
    await ctx.answerCallbackQuery();
    const day = reports.parseDayKey(ctx.match[1]);
    if (!day) {
      await ctx.reply("❌ Некорректная дата");
      return;
    }
    await renderDaySection(ctx, day, ctx.match[2] as DaySection);
  },
);

// ────────────────────────────────────────────────────────────
// ПЕРИОДНЫЙ ОТЧЁТ (7 / 30 дней)
// ────────────────────────────────────────────────────────────

/** Период «последние N дней, включая сегодня» */
function lastNDaysPeriod(n: number): { from: Date; until: Date } {
  const until = reports.endOfDayBishkek(new Date());
  const from = new Date(until.getTime() - n * 24 * 60 * 60 * 1000);
  return { from, until };
}

reportsHandlers.callbackQuery(/^admin:period:(7|30)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const n = parseInt(ctx.match[1], 10);
  const { from, until } = lastNDaysPeriod(n);
  const data = await reports.periodReport(from, until);
  const text = reports.formatPeriodReport(data);

  const kb = new InlineKeyboard();
  if (n !== 7) kb.text("📈 7 дней", "admin:period:7");
  if (n !== 30) kb.text("📈 30 дней", "admin:period:30");
  kb.text("🔄", `admin:period:${n}`).row();
  kb.text("📅 Календарь", `admin:cal:${fmtMonthKey(new Date())}`)
    .text("📊 Хаб", "admin:reports").row();
  kb.text("⬅️ Меню", "back:menu");

  await safeEdit(ctx, text, kb);
});

// ────────────────────────────────────────────────────────────
// КАЛЕНДАРЬ МЕСЯЦА
// ────────────────────────────────────────────────────────────

/** Парсинг ключа месяца YYYY-MM */
function parseMonthKey(key: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/** Получить ключ соседнего месяца (YYYY-MM) */
function shiftMonth(year: number, month: number, delta: -1 | 1): string {
  let m = month + delta;
  let y = year;
  if (m < 1) { m = 12; y--; }
  if (m > 12) { m = 1; y++; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

reportsHandlers.callbackQuery(/^admin:cal:(\d{4}-\d{2})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const parsed = parseMonthKey(ctx.match[1]);
  if (!parsed) {
    await ctx.reply("❌ Некорректный месяц");
    return;
  }

  const cal = await reports.monthCalendar(parsed.year, parsed.month);

  let text = `📅 <b>Календарь — ${cal.monthLabel}</b>\n\n`;
  if (cal.totalRentals > 0) {
    text += `📊 За месяц: <b>${cal.totalRentals}</b> аренд  ·  <b>${fmtPrice(cal.totalRevenue)}</b>\n\n`;
  } else {
    text += `<i>В этом месяце аренд не было.</i>\n\n`;
  }
  text += `<i>🟢 — есть активность  ·  📌 — сегодня</i>\n`;
  text += `<i>Нажмите на день, чтобы открыть отчёт.</i>`;

  const kb = new InlineKeyboard();

  kb.text("Пн", "noop").text("Вт", "noop").text("Ср", "noop")
    .text("Чт", "noop").text("Пт", "noop").text("Сб", "noop").text("Вс", "noop").row();

  const firstWeekday = cal.days[0]?.weekday ?? 0;
  for (let i = 0; i < firstWeekday; i++) kb.text(" ", "noop");

  let colsInRow = firstWeekday;
  for (const d of cal.days) {
    let label: string;
    if (d.isToday) label = `📌${d.day}`;
    else if (d.hasActivity) label = `🟢${d.day}`;
    else label = `·${d.day}`;
    kb.text(label, `admin:report:${d.key}`);
    colsInRow++;
    if (colsInRow === 7) {
      kb.row();
      colsInRow = 0;
    }
  }
  if (colsInRow > 0) {
    for (let i = colsInRow; i < 7; i++) kb.text(" ", "noop");
    kb.row();
  }

  const prevKey = shiftMonth(parsed.year, parsed.month, -1);
  const nextKey = shiftMonth(parsed.year, parsed.month, 1);
  const todayMonth = fmtMonthKey(new Date());
  kb.text("◀", `admin:cal:${prevKey}`);
  if (ctx.match[1] !== todayMonth) {
    kb.text("📌 Текущий", `admin:cal:${todayMonth}`);
  } else {
    kb.text("•", "noop");
  }
  kb.text("▶", `admin:cal:${nextKey}`).row();

  kb.text("📊 Хаб", "admin:reports").text("⬅️ Меню", "back:menu");

  await safeEdit(ctx, text, kb);
});

// ────────────────────────────────────────────────────────────
// Служебные
// ────────────────────────────────────────────────────────────

/** Заглушка для неактивных ячеек календаря */
reportsHandlers.callbackQuery("noop", async (ctx) => {
  await ctx.answerCallbackQuery();
});

/** LEGACY: старый URL списка дней — редирект в хаб */
reportsHandlers.callbackQuery(/^admin:reports:list:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderHub(ctx);
});
