/**
 * Модуль управления тарифами (админ) — кнопочный интерфейс.
 *
 * Создание и редактирование — через пикеры:
 *  - Длительность: 12 пресетов + «Свой» (текстовый ввод).
 *  - Цена: кнопки ±10 / ±50 / ±100 вокруг текущего значения + быстрые пресеты
 *    + «Ввести вручную».
 *  - Имя: автогенерация по длительности + кнопка «Своё имя» (текстовый ввод).
 *
 * Поток создания: длительность → цена → подтверждение (с опциональной сменой имени).
 * Поток редактирования: карточка → нажать поле → пикер → сохранение и возврат.
 *
 * Callback namespace: `admin:tf_*`. Состояние: `ctx.session.tariffDraft`.
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { guardRole } from "../../bot/middleware";
import { Role } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { fmtPrice, fmtDuration, escapeHtml } from "../../ui/helpers";
import {
  listTariffs,
  createTariff,
  updateTariff,
  deleteTariff,
} from "../../services/tariffs";
import { getOverdueRate, setOverdueRate } from "../../services/settings";

export const tariffsHandlers = new Composer<BotContext>();
tariffsHandlers.use(guardRole(Role.ADMIN));

// ────────────────────────────────────────────────────────────
// КОНСТАНТЫ ПИКЕРОВ
// ────────────────────────────────────────────────────────────

/** Пресеты длительности (минуты) для кнопочного выбора */
const DURATION_PRESETS: number[] = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440];

/** Быстрые пресеты цены (сом) */
const PRICE_PRESETS: number[] = [100, 200, 300, 500, 800, 1000, 1500, 2000];

/** Шаги корректировки цены (в одну и другую сторону) */
const PRICE_STEPS: number[] = [10, 50, 100];

/** Значение цены по умолчанию при открытии пикера, если не задано */
const DEFAULT_PRICE = 300;

/** Границы длительности (минуты) */
const DURATION_MIN = 1;
const DURATION_MAX = 1440;

/** Границы цены (сом) */
const PRICE_MIN = 0;
const PRICE_MAX = 1_000_000;

// ────────────────────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНОЕ
// ────────────────────────────────────────────────────────────

/** Безопасный editMessageText — если сообщения нет, отправляет новое */
async function safeEdit(
  ctx: BotContext,
  text: string,
  reply_markup: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup });
  } catch {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup });
  }
}

/** Автогенерация названия по длительности */
function autoName(durationMinutes: number): string {
  return fmtDuration(durationMinutes);
}

/** Зажать число в диапазоне */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Сброс черновика тарифа */
function resetDraft(ctx: BotContext): void {
  ctx.session.tariffDraft = undefined;
  ctx.session.inputMode = undefined;
}

// ────────────────────────────────────────────────────────────
// ЭКРАН 1. СПИСОК ВСЕХ ТАРИФОВ
// ────────────────────────────────────────────────────────────

async function renderList(ctx: BotContext) {
  const spots = await prisma.spot.findMany({ orderBy: { id: "asc" } });

  const kb = new InlineKeyboard();
  let text = `💰 <b>Тарифы</b>\n`;

  if (spots.length === 0) {
    text += `\n<i>Нет точек проката.</i>`;
  } else {
    const multiSpot = spots.length > 1;

    for (const s of spots) {
      const tariffs = await listTariffs(s.id, false);

      text += multiSpot ? `\n📍 <b>${escapeHtml(s.name)}</b>\n` : `\n`;

      if (tariffs.length === 0) {
        text += `   <i>нет тарифов</i>\n`;
      } else {
        for (const t of tariffs) {
          const badge = t.isActive ? "✅" : "🔒";
          const promoLine = t.promoPrice != null && t.promoPrice < t.price
            ? ` 🎁 <s>${fmtPrice(t.price)}</s> <b>${fmtPrice(t.promoPrice)}</b>`
            : ` · ${fmtPrice(t.price)}`;
          text += `${badge} <b>${escapeHtml(t.name)}</b> — ${fmtDuration(t.durationMinutes)}${promoLine}\n`;
        }
      }

      // Кнопки тарифов этой точки (по 2 в ряд)
      let col = 0;
      for (const t of tariffs) {
        const icon = t.isActive ? "✏️" : "🔒";
        const priceStr = t.promoPrice != null && t.promoPrice < t.price
          ? `🎁 ${fmtPrice(t.promoPrice)}`
          : fmtPrice(t.price);
        const label = `${icon} ${t.name} · ${priceStr}`;
        kb.text(label, `admin:tf_card:${t.id}`);
        col++;
        if (col === 2) {
          kb.row();
          col = 0;
        }
      }
      if (col === 1) kb.row();

      const newLabel = multiSpot ? `➕ Новый — ${s.name}` : `➕ Новый тариф`;
      kb.text(newLabel, `admin:tf_new:${s.id}`).row();
    }
  }

  const overdueRate = await getOverdueRate();
  kb.text(`⚡ Просрочка: ${overdueRate} сом/мин`, "admin:tf_overdue").row();
  kb.text("⬅️ В админ-панель", "admin:dashboard");

  await safeEdit(ctx, text, kb);
}

tariffsHandlers.callbackQuery("admin:tariffs", async (ctx) => {
  await ctx.answerCallbackQuery();
  resetDraft(ctx);
  ctx.session.inputMode = undefined;
  await renderList(ctx);
});

// ────────────────────────────────────────────────────────────
// ЭКРАН 2. КАРТОЧКА ТАРИФА
// ────────────────────────────────────────────────────────────

async function renderCard(ctx: BotContext, tariffId: number) {
  const t = await prisma.tariff.findUniqueOrThrow({ where: { id: tariffId } });
  const spot = await prisma.spot.findUnique({ where: { id: t.spotId } });
  const related = await prisma.rental.count({ where: { tariffId } });

  const statusLine = t.isActive ? "✅ Активен" : "🔒 Отключён";
  const spotLine = spot ? `📍 ${escapeHtml(spot.name)}\n` : "";

  const hasPromo = t.promoPrice != null && t.promoPrice < t.price;
  const priceLine = hasPromo
    ? `💵 <s>${fmtPrice(t.price)}</s> → <b>${fmtPrice(t.promoPrice!)}</b> 🎁 <i>акция</i>\n`
    : `💵 <b>${fmtPrice(t.price)}</b>\n`;

  const text =
    `💰 <b>${escapeHtml(t.name)}</b>\n\n` +
    spotLine +
    `⏱ <b>${fmtDuration(t.durationMinutes)}</b>\n` +
    priceLine +
    `Статус: ${statusLine}\n` +
    `Аренд с этим тарифом: <b>${related}</b>\n\n` +
    `<i>Нажмите на поле, чтобы изменить.</i>`;

  const promoBtnLabel = hasPromo
    ? `🎁 Акция: ${fmtPrice(t.promoPrice!)} (изменить)`
    : `🎁 Установить акцию`;

  const kb = new InlineKeyboard()
    .text(`🏷 Имя`, `admin:tf_edit:name:${t.id}`).row()
    .text(`⏱ Длительность`, `admin:tf_edit:duration:${t.id}`)
    .text(`💵 Цена`, `admin:tf_edit:price:${t.id}`).row()
    .text(promoBtnLabel, `admin:tf_edit:promo:${t.id}`).row()
    .text(t.isActive ? "🔒 Отключить" : "✅ Включить", `admin:tf_toggle:${t.id}`)
    .text("🗑 Удалить", `admin:tf_delete:${t.id}`).row()
    .text("⬅️ К списку", "admin:tariffs");

  await safeEdit(ctx, text, kb);
}

tariffsHandlers.callbackQuery(/^admin:tf_card:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  resetDraft(ctx);
  await renderCard(ctx, parseInt(ctx.match[1], 10));
});

// ────────────────────────────────────────────────────────────
// СТАРТ СОЗДАНИЯ
// ────────────────────────────────────────────────────────────

tariffsHandlers.callbackQuery(/^admin:tf_new:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const spotId = parseInt(ctx.match[1], 10);
  ctx.session.tariffDraft = { mode: "create", spotId };
  ctx.session.inputMode = undefined;
  await renderDurationPicker(ctx);
});

// ────────────────────────────────────────────────────────────
// СТАРТ РЕДАКТИРОВАНИЯ ПОЛЯ
// ────────────────────────────────────────────────────────────

tariffsHandlers.callbackQuery(/^admin:tf_edit:(name|duration|price|promo):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const field = ctx.match[1] as "name" | "duration" | "price" | "promo";
  const tariffId = parseInt(ctx.match[2], 10);
  const t = await prisma.tariff.findUniqueOrThrow({ where: { id: tariffId } });

  ctx.session.tariffDraft = {
    mode: "edit",
    spotId: t.spotId,
    tariffId: t.id,
    name: t.name,
    durationMinutes: t.durationMinutes,
    price: t.price,
    promoPrice: t.promoPrice,
  };
  ctx.session.inputMode = undefined;

  if (field === "duration") return renderDurationPicker(ctx);
  if (field === "price") return renderPricePicker(ctx);
  if (field === "promo") return renderPromoPicker(ctx);
  // name
  return renderNamePicker(ctx);
});

// ────────────────────────────────────────────────────────────
// ПИКЕР ДЛИТЕЛЬНОСТИ
// ────────────────────────────────────────────────────────────

async function renderDurationPicker(ctx: BotContext) {
  const draft = ctx.session.tariffDraft;
  if (!draft) return;

  const header =
    draft.mode === "create"
      ? `➕ <b>Новый тариф</b>\nШаг 1 из 2: выберите <b>длительность</b>`
      : `⏱ <b>Изменить длительность</b>\nТекущая: <b>${draft.durationMinutes ? fmtDuration(draft.durationMinutes) : "—"}</b>`;

  const text = `${header}\n\n<i>Выберите пресет или введите своё значение.</i>`;

  const kb = new InlineKeyboard();
  // 3 кнопки в ряд
  for (let i = 0; i < DURATION_PRESETS.length; i++) {
    const m = DURATION_PRESETS[i];
    const mark = draft.durationMinutes === m ? "• " : "";
    kb.text(`${mark}${fmtDuration(m)}`, `admin:tf_pick_dur:${m}`);
    if ((i + 1) % 3 === 0) kb.row();
  }

  kb.row();
  kb.text("✏️ Своё значение", "admin:tf_dur_custom").row();

  const backTo =
    draft.mode === "edit" && draft.tariffId
      ? `admin:tf_card:${draft.tariffId}`
      : "admin:tariffs";
  kb.text("❌ Отмена", backTo);

  await safeEdit(ctx, text, kb);
}

tariffsHandlers.callbackQuery(/^admin:tf_pick_dur:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = ctx.session.tariffDraft;
  if (!draft) return;

  const m = clamp(parseInt(ctx.match[1], 10), DURATION_MIN, DURATION_MAX);
  draft.durationMinutes = m;

  if (draft.mode === "edit" && draft.tariffId) {
    await updateTariff(draft.tariffId, { durationMinutes: m }, ctx.dbUser!.id);
    const tariffId = draft.tariffId;
    resetDraft(ctx);
    return renderCard(ctx, tariffId);
  }

  // create: переходим к цене
  if (draft.price === undefined) draft.price = DEFAULT_PRICE;
  return renderPricePicker(ctx);
});

tariffsHandlers.callbackQuery("admin:tf_dur_custom", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = ctx.session.tariffDraft;
  if (!draft) return;

  draft.pendingField = "duration";
  ctx.session.inputMode = "tariff_text";

  const kb = new InlineKeyboard().text("❌ Отмена", "admin:tf_back_dur");
  await safeEdit(
    ctx,
    `✏️ <b>Своя длительность</b>\n\n` +
    `Пришлите число минут (${DURATION_MIN}–${DURATION_MAX}).\n\n` +
    `<i>Пример: <code>75</code> (1 час 15 минут)</i>`,
    kb,
  );
});

// Возврат в пикер длительности из режима ввода
tariffsHandlers.callbackQuery("admin:tf_back_dur", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = ctx.session.tariffDraft;
  if (!draft) return;
  draft.pendingField = undefined;
  ctx.session.inputMode = undefined;
  await renderDurationPicker(ctx);
});

// ────────────────────────────────────────────────────────────
// ПИКЕР ЦЕНЫ
// ────────────────────────────────────────────────────────────

async function renderPricePicker(ctx: BotContext) {
  const draft = ctx.session.tariffDraft;
  if (!draft) return;

  const current = draft.price ?? DEFAULT_PRICE;
  draft.price = current;

  const header =
    draft.mode === "create"
      ? `➕ <b>Новый тариф</b>\nШаг 2 из 2: задайте <b>цену</b>`
      : `💵 <b>Изменить цену</b>`;

  const text =
    `${header}\n\n` +
    `Текущая цена: <b>${fmtPrice(current)}</b>\n\n` +
    `<i>Корректируйте кнопками ± или выберите пресет.</i>`;

  const kb = new InlineKeyboard();

  // Корректировка: −100 −50 −10 | +10 +50 +100
  kb.text(`−${PRICE_STEPS[2]}`, `admin:tf_price_adj:-${PRICE_STEPS[2]}`)
    .text(`−${PRICE_STEPS[1]}`, `admin:tf_price_adj:-${PRICE_STEPS[1]}`)
    .text(`−${PRICE_STEPS[0]}`, `admin:tf_price_adj:-${PRICE_STEPS[0]}`)
    .text(`+${PRICE_STEPS[0]}`, `admin:tf_price_adj:+${PRICE_STEPS[0]}`)
    .text(`+${PRICE_STEPS[1]}`, `admin:tf_price_adj:+${PRICE_STEPS[1]}`)
    .text(`+${PRICE_STEPS[2]}`, `admin:tf_price_adj:+${PRICE_STEPS[2]}`).row();

  // Быстрые пресеты (по 4 в ряд)
  for (let i = 0; i < PRICE_PRESETS.length; i++) {
    const p = PRICE_PRESETS[i];
    const mark = current === p ? "• " : "";
    kb.text(`${mark}${fmtPrice(p)}`, `admin:tf_price_set:${p}`);
    if ((i + 1) % 4 === 0) kb.row();
  }

  kb.text("✏️ Вручную", "admin:tf_price_custom").row();
  kb.text("✅ Сохранить", "admin:tf_price_save").row();

  const backTo =
    draft.mode === "edit" && draft.tariffId
      ? `admin:tf_card:${draft.tariffId}`
      : `admin:tf_back_dur_from_price`;
  kb.text("⬅️ Назад", backTo);

  await safeEdit(ctx, text, kb);
}

// Возврат с шага «Цена» к шагу «Длительность» в режиме создания
tariffsHandlers.callbackQuery("admin:tf_back_dur_from_price", async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderDurationPicker(ctx);
});

tariffsHandlers.callbackQuery(/^admin:tf_price_adj:(-|\+)(\d+)$/, async (ctx) => {
  const draft = ctx.session.tariffDraft;
  if (!draft) {
    await ctx.answerCallbackQuery();
    return;
  }
  const sign = ctx.match[1] === "-" ? -1 : 1;
  const step = parseInt(ctx.match[2], 10);
  const cur = draft.price ?? DEFAULT_PRICE;
  const next = clamp(cur + sign * step, PRICE_MIN, PRICE_MAX);
  draft.price = next;
  await ctx.answerCallbackQuery(`${fmtPrice(next)}`).catch(() => { });
  await renderPricePicker(ctx);
});

tariffsHandlers.callbackQuery(/^admin:tf_price_set:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = ctx.session.tariffDraft;
  if (!draft) return;
  draft.price = clamp(parseInt(ctx.match[1], 10), PRICE_MIN, PRICE_MAX);
  await renderPricePicker(ctx);
});

tariffsHandlers.callbackQuery("admin:tf_price_custom", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = ctx.session.tariffDraft;
  if (!draft) return;
  draft.pendingField = "price";
  ctx.session.inputMode = "tariff_text";

  const kb = new InlineKeyboard().text("❌ Отмена", "admin:tf_back_price");
  await safeEdit(
    ctx,
    `✏️ <b>Своя цена</b>\n\nПришлите число сом (${PRICE_MIN}–${PRICE_MAX.toLocaleString("ru-RU")}).`,
    kb,
  );
});

tariffsHandlers.callbackQuery("admin:tf_back_price", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = ctx.session.tariffDraft;
  if (!draft) return;
  draft.pendingField = undefined;
  ctx.session.inputMode = undefined;
  await renderPricePicker(ctx);
});

tariffsHandlers.callbackQuery("admin:tf_price_save", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = ctx.session.tariffDraft;
  if (!draft) return;

  if (draft.mode === "edit" && draft.tariffId && draft.price !== undefined) {
    await updateTariff(draft.tariffId, { price: draft.price }, ctx.dbUser!.id);
    const id = draft.tariffId;
    resetDraft(ctx);
    return renderCard(ctx, id);
  }

  // create: идём к подтверждению
  if (draft.name === undefined && draft.durationMinutes !== undefined) {
    draft.name = autoName(draft.durationMinutes);
  }
  return renderConfirm(ctx);
});

// ────────────────────────────────────────────────────────────
// ПИКЕР ИМЕНИ (только для режима edit)
// ────────────────────────────────────────────────────────────

async function renderNamePicker(ctx: BotContext) {
  const draft = ctx.session.tariffDraft;
  if (!draft) return;

  const current = draft.name ?? "";
  const auto = draft.durationMinutes ? autoName(draft.durationMinutes) : null;

  let text = `🏷 <b>Изменить имя тарифа</b>\n\n`;
  text += `Текущее: <b>${escapeHtml(current)}</b>\n`;

  const kb = new InlineKeyboard();
  if (auto && auto !== current) {
    text += `\n<i>Можно использовать авто-имя по длительности.</i>`;
    kb.text(`📝 Авто: ${auto}`, `admin:tf_name_auto`).row();
  }
  kb.text("✏️ Ввести своё имя", "admin:tf_name_custom").row();

  const backTo =
    draft.mode === "edit" && draft.tariffId
      ? `admin:tf_card:${draft.tariffId}`
      : "admin:tariffs";
  kb.text("❌ Отмена", backTo);

  await safeEdit(ctx, text, kb);
}

tariffsHandlers.callbackQuery("admin:tf_name_auto", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = ctx.session.tariffDraft;
  if (!draft || draft.durationMinutes === undefined) return;

  const name = autoName(draft.durationMinutes);
  draft.name = name;

  if (draft.mode === "edit" && draft.tariffId) {
    await updateTariff(draft.tariffId, { name }, ctx.dbUser!.id);
    const id = draft.tariffId;
    resetDraft(ctx);
    return renderCard(ctx, id);
  }
  return renderConfirm(ctx);
});

tariffsHandlers.callbackQuery("admin:tf_name_custom", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = ctx.session.tariffDraft;
  if (!draft) return;
  draft.pendingField = "name";
  ctx.session.inputMode = "tariff_text";

  const backTo =
    draft.mode === "edit" && draft.tariffId
      ? `admin:tf_card:${draft.tariffId}`
      : "admin:tf_back_confirm";
  const kb = new InlineKeyboard().text("❌ Отмена", backTo);

  await safeEdit(
    ctx,
    `✏️ <b>Своё имя тарифа</b>\n\nПришлите название (1–50 символов).`,
    kb,
  );
});

// ────────────────────────────────────────────────────────────
// ЭКРАН ПОДТВЕРЖДЕНИЯ СОЗДАНИЯ
// ────────────────────────────────────────────────────────────

async function renderConfirm(ctx: BotContext) {
  const draft = ctx.session.tariffDraft;
  if (!draft || draft.mode !== "create") return;
  if (draft.durationMinutes === undefined || draft.price === undefined) return;

  const name = draft.name ?? autoName(draft.durationMinutes);
  draft.name = name;

  const text =
    `➕ <b>Подтвердите создание</b>\n\n` +
    `🏷 Имя: <b>${escapeHtml(name)}</b>\n` +
    `⏱ Длительность: <b>${fmtDuration(draft.durationMinutes)}</b>\n` +
    `💵 Цена: <b>${fmtPrice(draft.price)}</b>`;

  const kb = new InlineKeyboard()
    .text("✅ Создать", "admin:tf_create_confirm").row()
    .text("🏷 Имя", "admin:tf_name_custom").row()
    .text("⏱ Длительность", "admin:tf_back_dur_from_price")
    .text("💵 Цена", "admin:tf_back_price_from_confirm").row()
    .text("❌ Отмена", "admin:tariffs");

  await safeEdit(ctx, text, kb);
}

tariffsHandlers.callbackQuery("admin:tf_back_confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = ctx.session.tariffDraft;
  if (!draft) return;
  draft.pendingField = undefined;
  ctx.session.inputMode = undefined;
  await renderConfirm(ctx);
});

tariffsHandlers.callbackQuery("admin:tf_back_price_from_confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderPricePicker(ctx);
});

tariffsHandlers.callbackQuery("admin:tf_create_confirm", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = ctx.session.tariffDraft;
  if (!draft || draft.mode !== "create") return;
  if (draft.durationMinutes === undefined || draft.price === undefined) return;

  const name = draft.name ?? autoName(draft.durationMinutes);

  try {
    const created = await createTariff(
      {
        spotId: draft.spotId,
        name,
        durationMinutes: draft.durationMinutes,
        price: draft.price,
      },
      ctx.dbUser!.id,
    );

    resetDraft(ctx);

    const kb = new InlineKeyboard()
      .text("✏️ Открыть", `admin:tf_card:${created.id}`).row()
      .text("⬅️ К списку", "admin:tariffs");
    await safeEdit(
      ctx,
      `✅ <b>Тариф создан!</b>\n\n` +
      `🏷 ${escapeHtml(created.name)}\n` +
      `⏱ ${fmtDuration(created.durationMinutes)}  ·  💵 ${fmtPrice(created.price)}`,
      kb,
    );
  } catch (e: any) {
    const kb = new InlineKeyboard().text("⬅️ К списку", "admin:tariffs");
    await safeEdit(ctx, `⚠️ Ошибка: ${escapeHtml(e.message ?? "неизвестно")}`, kb);
  }
});

// ────────────────────────────────────────────────────────────
// ПИКЕР АКЦИИ (promoPrice)
// ────────────────────────────────────────────────────────────

/** Быстрые скидки относительно price: 10/15/20/25% вниз */
const PROMO_DISCOUNT_PRESETS = [10, 15, 20, 25];

async function renderPromoPicker(ctx: BotContext) {
  const draft = ctx.session.tariffDraft;
  if (!draft || draft.tariffId === undefined) return;

  const t = await prisma.tariff.findUniqueOrThrow({ where: { id: draft.tariffId } });
  const hasPromo = t.promoPrice != null && t.promoPrice < t.price;

  const header = hasPromo
    ? `🎁 <b>Акция на «${escapeHtml(t.name)}»</b>\n\nТекущая акция: <s>${fmtPrice(t.price)}</s> → <b>${fmtPrice(t.promoPrice!)}</b>`
    : `🎁 <b>Установить акцию для «${escapeHtml(t.name)}»</b>\n\nОбычная цена: <b>${fmtPrice(t.price)}</b>`;

  const text =
    `${header}\n\n` +
    `<i>Выберите скидку в процентах или введите свою цену.</i>`;

  const kb = new InlineKeyboard();

  // Кнопки быстрых скидок (показывают итоговую цену)
  for (const pct of PROMO_DISCOUNT_PRESETS) {
    const promo = Math.round((t.price * (100 - pct)) / 100);
    const mark = t.promoPrice === promo ? "• " : "";
    kb.text(`${mark}−${pct}% → ${fmtPrice(promo)}`, `admin:tf_promo_set:${promo}`);
  }
  kb.row();
  kb.text("✏️ Своя цена", "admin:tf_promo_custom").row();
  if (hasPromo) {
    kb.text("❌ Убрать акцию", "admin:tf_promo_clear").row();
  }
  kb.text("⬅️ К тарифу", `admin:tf_card:${t.id}`);

  await safeEdit(ctx, text, kb);
}

/** Применить промо-цену пресетом */
tariffsHandlers.callbackQuery(/^admin:tf_promo_set:(\d+)$/, async (ctx) => {
  const draft = ctx.session.tariffDraft;
  if (!draft || draft.tariffId === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }
  const promo = parseInt(ctx.match[1], 10);
  await updateTariff(draft.tariffId, { promoPrice: promo }, ctx.dbUser!.id);
  await ctx.answerCallbackQuery(`🎁 Акция установлена: ${fmtPrice(promo)}`).catch(() => { });
  const id = draft.tariffId;
  resetDraft(ctx);
  return renderCard(ctx, id);
});

/** Убрать акцию */
tariffsHandlers.callbackQuery("admin:tf_promo_clear", async (ctx) => {
  const draft = ctx.session.tariffDraft;
  if (!draft || draft.tariffId === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }
  await updateTariff(draft.tariffId, { promoPrice: null }, ctx.dbUser!.id);
  await ctx.answerCallbackQuery("❌ Акция убрана").catch(() => { });
  const id = draft.tariffId;
  resetDraft(ctx);
  return renderCard(ctx, id);
});

/** Ручной ввод промо-цены */
tariffsHandlers.callbackQuery("admin:tf_promo_custom", async (ctx) => {
  await ctx.answerCallbackQuery();
  const draft = ctx.session.tariffDraft;
  if (!draft || draft.tariffId === undefined) return;

  draft.pendingField = "promo";
  ctx.session.inputMode = "tariff_text";

  const t = await prisma.tariff.findUniqueOrThrow({ where: { id: draft.tariffId } });
  const kb = new InlineKeyboard().text("❌ Отмена", `admin:tf_edit:promo:${t.id}`);
  await safeEdit(
    ctx,
    `✏️ <b>Акционная цена</b>\n\n` +
    `Обычная цена: <b>${fmtPrice(t.price)}</b>\n\n` +
    `Пришлите акционную цену в сомах (меньше ${fmtPrice(t.price)}).`,
    kb,
  );
});

// ────────────────────────────────────────────────────────────
// ВКЛ/ВЫКЛ, УДАЛЕНИЕ
// ────────────────────────────────────────────────────────────

tariffsHandlers.callbackQuery(/^admin:tf_toggle:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1], 10);
  const t = await prisma.tariff.findUniqueOrThrow({ where: { id } });
  const updated = await updateTariff(id, { isActive: !t.isActive }, ctx.dbUser!.id);
  await ctx.answerCallbackQuery(updated.isActive ? "✅ Включён" : "🔒 Отключён").catch(() => { });
  await renderCard(ctx, id);
});

tariffsHandlers.callbackQuery(/^admin:tf_delete:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = parseInt(ctx.match[1], 10);
  const t = await prisma.tariff.findUniqueOrThrow({ where: { id } });
  const related = await prisma.rental.count({ where: { tariffId: id } });

  const warn =
    related > 0
      ? `\n\n⚠️ Есть <b>${related}</b> связанных аренд.\nТариф будет <i>деактивирован</i> (soft delete) — история сохранится.`
      : `\n\n🗑 Тариф будет <b>полностью удалён</b>.`;

  const kb = new InlineKeyboard()
    .text("✅ Да, удалить", `admin:tf_delete_confirm:${t.id}`).row()
    .text("❌ Отмена", `admin:tf_card:${t.id}`);

  await safeEdit(
    ctx,
    `🗑 <b>Удалить «${escapeHtml(t.name)}»?</b>${warn}`,
    kb,
  );
});

tariffsHandlers.callbackQuery(/^admin:tf_delete_confirm:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1], 10);
  const mode = await deleteTariff(id, ctx.dbUser!.id);
  const note = mode === "hard" ? "Тариф удалён." : "Тариф деактивирован (есть связанные аренды).";
  await ctx.answerCallbackQuery(`✅ ${note}`).catch(() => { });

  const kb = new InlineKeyboard().text("⬅️ К тарифам", "admin:tariffs");
  await safeEdit(ctx, `✅ <b>Готово.</b>\n\n${note}`, kb);
});

// ────────────────────────────────────────────────────────────
// ПИКЕР СТАВКИ ПРОСРОЧКИ
// ────────────────────────────────────────────────────────────

const OVERDUE_RATE_PRESETS = [5, 10, 15, 20, 25, 30, 50];
const OVERDUE_RATE_MIN = 1;
const OVERDUE_RATE_MAX = 1000;

async function renderOverdueRatePicker(ctx: BotContext) {
  const current = await getOverdueRate();

  const text =
    `⚡ <b>Ставка просрочки</b>\n\n` +
    `Текущая: <b>${current} сом/мин</b>\n\n` +
    `<i>Сколько начисляется клиенту за каждую минуту после истечения оплаченного времени.</i>`;

  const kb = new InlineKeyboard();
  for (let i = 0; i < OVERDUE_RATE_PRESETS.length; i++) {
    const r = OVERDUE_RATE_PRESETS[i];
    const mark = current === r ? "• " : "";
    kb.text(`${mark}${r} сом`, `admin:tf_overdue_set:${r}`);
    if ((i + 1) % 4 === 0) kb.row();
  }
  kb.row();
  kb.text("✏️ Вручную", "admin:tf_overdue_custom").row();
  kb.text("⬅️ К тарифам", "admin:tariffs");

  await safeEdit(ctx, text, kb);
}

tariffsHandlers.callbackQuery("admin:tf_overdue", async (ctx) => {
  await ctx.answerCallbackQuery();
  resetDraft(ctx);
  await renderOverdueRatePicker(ctx);
});

tariffsHandlers.callbackQuery(/^admin:tf_overdue_set:(\d+)$/, async (ctx) => {
  const value = parseInt(ctx.match[1], 10);
  await setOverdueRate(value);
  await ctx.answerCallbackQuery(`✅ Ставка: ${value} сом/мин`).catch(() => { });
  await renderList(ctx);
});

tariffsHandlers.callbackQuery("admin:tf_overdue_custom", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.inputMode = "overdue_rate";

  const kb = new InlineKeyboard().text("❌ Отмена", "admin:tf_overdue");
  await safeEdit(
    ctx,
    `✏️ <b>Своя ставка просрочки</b>\n\n` +
    `Пришлите число сом за минуту (${OVERDUE_RATE_MIN}–${OVERDUE_RATE_MAX}).`,
    kb,
  );
});

tariffsHandlers.on("message:text", async (ctx, next) => {
  if (ctx.session.inputMode !== "overdue_rate") return next();

  const raw = ctx.message.text.trim();
  const n = parseInt(raw.replace(/\s+/g, ""), 10);
  if (!Number.isInteger(n) || n < OVERDUE_RATE_MIN || n > OVERDUE_RATE_MAX) {
    return ctx.reply(`⚠️ Введите целое число от ${OVERDUE_RATE_MIN} до ${OVERDUE_RATE_MAX}.`);
  }

  await setOverdueRate(n);
  ctx.session.inputMode = undefined;
  await renderList(ctx);
});

// ────────────────────────────────────────────────────────────
// ОБРАБОТКА КАСТОМНОГО ТЕКСТОВОГО ВВОДА (Имя / Длительность / Цена)
// ────────────────────────────────────────────────────────────

tariffsHandlers.on("message:text", async (ctx, next) => {
  if (ctx.session.inputMode !== "tariff_text") return next();
  const draft = ctx.session.tariffDraft;
  if (!draft || !draft.pendingField) return next();

  const raw = ctx.message.text.trim();
  const field = draft.pendingField;

  try {
    if (field === "name") {
      if (raw.length < 1 || raw.length > 50) {
        return ctx.reply("⚠️ Имя должно быть от 1 до 50 символов.");
      }
      draft.name = raw;
      draft.pendingField = undefined;
      ctx.session.inputMode = undefined;

      if (draft.mode === "edit" && draft.tariffId) {
        await updateTariff(draft.tariffId, { name: raw }, ctx.dbUser!.id);
        const id = draft.tariffId;
        resetDraft(ctx);
        return renderCard(ctx, id);
      }
      return renderConfirm(ctx);
    }

    if (field === "duration") {
      const n = parseInt(raw, 10);
      if (!Number.isInteger(n) || n < DURATION_MIN || n > DURATION_MAX) {
        return ctx.reply(`⚠️ Введите целое число от ${DURATION_MIN} до ${DURATION_MAX}.`);
      }
      draft.durationMinutes = n;
      draft.pendingField = undefined;
      ctx.session.inputMode = undefined;

      if (draft.mode === "edit" && draft.tariffId) {
        await updateTariff(draft.tariffId, { durationMinutes: n }, ctx.dbUser!.id);
        const id = draft.tariffId;
        resetDraft(ctx);
        return renderCard(ctx, id);
      }
      if (draft.price === undefined) draft.price = DEFAULT_PRICE;
      return renderPricePicker(ctx);
    }

    if (field === "price") {
      const p = parseInt(raw.replace(/\s+/g, ""), 10);
      if (!Number.isInteger(p) || p < PRICE_MIN || p > PRICE_MAX) {
        return ctx.reply(`⚠️ Введите целое число от ${PRICE_MIN} до ${PRICE_MAX}.`);
      }
      draft.price = p;
      draft.pendingField = undefined;
      ctx.session.inputMode = undefined;

      if (draft.mode === "edit" && draft.tariffId) {
        await updateTariff(draft.tariffId, { price: p }, ctx.dbUser!.id);
        const id = draft.tariffId;
        resetDraft(ctx);
        return renderCard(ctx, id);
      }
      return renderPricePicker(ctx);
    }

    if (field === "promo") {
      if (!draft.tariffId) return;
      const p = parseInt(raw.replace(/\s+/g, ""), 10);
      if (!Number.isInteger(p) || p < 0 || p > PRICE_MAX) {
        return ctx.reply(`⚠️ Введите целое число от 0 до ${PRICE_MAX}.`);
      }
      const current = await prisma.tariff.findUniqueOrThrow({ where: { id: draft.tariffId } });
      if (p >= current.price) {
        return ctx.reply(`⚠️ Акционная цена должна быть меньше обычной (${fmtPrice(current.price)}).`);
      }
      await updateTariff(draft.tariffId, { promoPrice: p }, ctx.dbUser!.id);
      draft.pendingField = undefined;
      ctx.session.inputMode = undefined;
      const id = draft.tariffId;
      resetDraft(ctx);
      return renderCard(ctx, id);
    }
  } catch (e: any) {
    return ctx.reply(`⚠️ Ошибка: ${escapeHtml(e.message ?? "неизвестно")}`);
  }
});
