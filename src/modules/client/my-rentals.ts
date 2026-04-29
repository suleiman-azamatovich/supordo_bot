/**
 * Мои аренды — список досок-кнопок, детальная карточка, продление.
 *
 * Обрабатывает:
 *  - client:my_list — кнопки «мои доски» (аналог списка досок)
 *  - client:my_detail — детальная карточка аренды
 *  - client:extend — выбор тарифа для продления
 *  - client:extend_confirm — отправка запроса на продление админу
 *
 * «Закрыть просрочку» убрана — просрочка решается продлением или возвратом на берегу.
 */

import { Composer, InlineKeyboard } from "grammy";
import { Role } from "@prisma/client";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import {
  fmtPrice, fmtDuration, fmtDate,
  paginate, addPaginationRow,
  rentalStatusIcon, rentalStatusLabel,
  progressBar,
} from "../../ui/helpers";
import * as rentalService from "../../services/rental";
import { applyDiscount } from "../../services/pricing";
import { sendMBankQR, notifyAdminsNewPayment } from "./helpers";

export const myRentalsHandlers = new Composer<BotContext>();

/** Иконка статуса аренды (локальный алиас) */
const rentalIcon = rentalStatusIcon;

/** Краткая подпись статуса (локальный алиас) */
const rentalLabel = rentalStatusLabel;

/** Список моих аренд — только активные, кнопки-доски */
myRentalsHandlers.callbackQuery(/^client:my_list(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => { });
  const page = parseInt(ctx.match?.[2] ?? "1");
  const userId = ctx.dbUser!.id;

  const rentals = await prisma.rental.findMany({
    where: {
      userId,
      status: { in: ["CREATED", "WAIT_PAYMENT", "WAIT_ADMIN", "RENTED", "WAIT_RETURN"] },
    },
    include: { board: true, tariff: true },
    orderBy: { createdAt: "desc" },
  });

  const paged = paginate(rentals, page, 6);

  let text = `📋 <b>Мои аренды</b> (${rentals.length})\n`;
  if (rentals.length === 0) {
    text += "\n<i>У вас пока нет активных аренд.</i>";
  }

  const kb = new InlineKeyboard();

  // Параллельно считаем просрочки для всех WAIT_RETURN, чтобы не блокировать цикл
  const overdueMap = new Map<number, number>();
  const waitReturns = paged.items.filter((r) => r.status === "WAIT_RETURN");
  if (waitReturns.length > 0) {
    const results = await Promise.all(
      waitReturns.map(async (r) => [r.id, await rentalService.getOverdueMinutes(r)] as const),
    );
    for (const [id, mins] of results) overdueMap.set(id, mins);
  }

  for (const r of paged.items) {
    const icon = rentalIcon(r.status);
    const label = rentalLabel(r.status);

    let extra = "";
    if (r.startAt && r.tariff && r.status === "RENTED") {
      const totalMin = r.tariff.durationMinutes + (r.extraMinutes ?? 0);
      const expiresAt = new Date(r.startAt.getTime() + totalMin * 60_000);
      const remainMs = expiresAt.getTime() - Date.now();
      if (remainMs > 0) {
        const mins = Math.ceil(remainMs / 60_000);
        extra = ` +${fmtDuration(mins)}`;
      }
    }
    if (r.status === "WAIT_RETURN") {
      const overdue = overdueMap.get(r.id) ?? 0;
      if (overdue > 0) {
        extra = ` −${fmtDuration(overdue)}`;
      }
    }

    kb.text(`${icon} ${r.board.code} — ${label}${extra}`, `client:my_detail:${r.id}`).row();
  }

  addPaginationRow(kb, paged.page, paged.totalPages, "client:my_list:");

  if (rentals.length === 0) {
    kb.row().text("🏄 Арендовать доску", "client:boards");
  }
  kb.row().text("🔄 Обновить", `client:my_list:${paged.page}`).text("⬅️ Меню", "back:menu");
  kb.row().text("🧹 Убрать лишнее", "clear:chat");

  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch (e: any) {
    if (!e.description?.includes("message is not modified")) throw e;
  }
});

/** История операций — платежи клиента (PaymentProof) */
myRentalsHandlers.callbackQuery(/^client:my_history(:(\d+))?$/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => { });
  const page = parseInt(ctx.match?.[2] ?? "1");
  const userId = ctx.dbUser!.id;

  const total = await prisma.paymentProof.count({ where: { userId } });
  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // desc-порядок для пагинации (первая страница = новейшие)
  const payments = await prisma.paymentProof.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  // Загружаем связанные аренды для отображения доски
  const refIds = [...new Set(payments.map(p => p.refId))];
  const rentals = refIds.length > 0
    ? await prisma.rental.findMany({
      where: { id: { in: refIds } },
      include: { board: true, tariff: true },
    })
    : [];
  const rentalMap = new Map(rentals.map(r => [r.id, r]));

  // Внутри страницы — новые внизу
  const items = [...payments].reverse();

  let text = `📜 <b>История операций</b> (${total})\n`;
  if (items.length === 0) {
    text += "\nПока нет операций.";
  } else {
    text += "\n";
    for (const p of items) {
      const rental = rentalMap.get(p.refId);
      const boardCode = rental?.board?.code ?? "—";
      const kindLabel = p.kind === "OVERDUE" ? "просрочка"
        : p.kind === "EXTENSION" ? "продление"
          : "аренда";
      const tariffInfo = rental?.tariff
        ? `${fmtDuration(rental.tariff.durationMinutes)}`
        : "";
      const date = fmtDate(p.createdAt);

      let statusIcon: string, statusLabel: string;
      if (p.status === "APPROVED") {
        statusIcon = "✅";
        statusLabel = "подтверждена";
      } else if (p.status === "REJECTED") {
        if (!p.reviewedBy) {
          statusIcon = "🚫";
          statusLabel = "отклонена автоматически";
        } else {
          statusIcon = "❌";
          statusLabel = "отклонена";
        }
      } else {
        statusIcon = "🔄";
        statusLabel = "на проверке";
      }

      text += `${statusIcon} ${statusLabel}\n`;
      text += `💰 <b>${fmtPrice(p.amount)}</b> — ${kindLabel}\n`;
      text += `🏄 ${boardCode}`;
      if (tariffInfo) text += ` · ⏱ ${tariffInfo}`;
      text += ` · #${p.refId}\n`;
      text += `📅 ${date}\n\n`;
    }
  }

  const kb = new InlineKeyboard();
  addPaginationRow(kb, page, totalPages, "client:my_history:");
  kb.row().text("🔄 Обновить", `client:my_history:${page}`).text("⬅️ Меню", "back:menu");
  kb.row().text("🧹 Убрать лишнее", "clear:chat");

  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch (e: any) {
    if (!e.description?.includes("message is not modified")) throw e;
  }
});

/** Детальная карточка одной аренды */
myRentalsHandlers.callbackQuery(/^client:my_detail:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
    include: { board: true, tariff: true, spot: true },
  });

  if (rental.userId !== ctx.dbUser!.id) {
    return ctx.editMessageText("⛔ Это не ваша аренда.");
  }

  // Загружаем все оплаты по этой аренде
  const payments = await prisma.paymentProof.findMany({
    where: { refId: rentalId },
    orderBy: { createdAt: "asc" },
  });

  const icon = rentalIcon(rental.status);
  const label = rentalLabel(rental.status);
  const listPrice = rental.tariffPriceKgs ?? rental.tariff?.price ?? 0;
  const originalPrice = rental.tariffOriginalPriceKgs; // null если акции не было
  const tariffPrice = rental.basePriceKgs ?? listPrice;
  const discountPct = rental.discountPercent ?? 0;
  const tariffDuration = rental.tariff?.durationMinutes ?? 0;

  let text = `${icon} <b>${rental.board.code}</b> — ${label}\n`;
  text += `#${rental.id}\n\n`;

  // Раздел: тариф
  text += `📋 <b>Тариф</b>\n`;
  // Акция (если была): показываем зачёркнутый прайс → акционная цена
  if (originalPrice && originalPrice > listPrice) {
    text += `   🎁 <i>Акция:</i> <s>${fmtPrice(originalPrice)}</s> → <b>${fmtPrice(listPrice)}</b>\n`;
  }
  if (listPrice > tariffPrice) {
    text += `   <s>${fmtPrice(listPrice)}</s> → <b>${fmtPrice(tariffPrice)}</b>  ·  ⏱ ${fmtDuration(tariffDuration)}\n`;
    const savedKgs = listPrice - tariffPrice;
    const pctLabel = discountPct > 0 ? ` −${discountPct}%` : "";
    text += `   🎁 Скидка:${pctLabel} <b>−${fmtPrice(savedKgs)}</b>\n`;
  } else {
    text += `   💰 ${fmtPrice(tariffPrice)}  ·  ⏱ ${fmtDuration(tariffDuration)}\n`;
  }
  if (rental.spot) {
    text += `   📍 ${rental.spot.name}\n`;
  }

  // Продления
  if (rental.extraMinutes) {
    text += `   ➕ Продлено: +${fmtDuration(rental.extraMinutes)}`;
    if (rental.extraCost) {
      text += ` (${fmtPrice(rental.extraCost)})`;
    }
    text += `\n`;
  }
  text += `\n`;

  // Раздел: время
  text += `⏱ <b>Время</b>\n`;
  if (rental.startAt) {
    text += `   📅 Начало: ${fmtDate(rental.startAt)}\n`;
  }

  if (rental.startAt && rental.tariff) {
    const totalMin = tariffDuration + (rental.extraMinutes ?? 0);
    const expiresAt = new Date(rental.startAt.getTime() + totalMin * 60_000);

    if (["RENTED"].includes(rental.status)) {
      const remainMs = expiresAt.getTime() - Date.now();
      if (remainMs > 0) {
        const mins = Math.floor(remainMs / 60_000);
        const secs = Math.floor((remainMs % 60_000) / 1_000);
        const elapsedMs = Date.now() - rental.startAt.getTime();
        const totalMs = totalMin * 60_000;
        const ratio = totalMs > 0 ? elapsedMs / totalMs : 0;
        text += `   ${progressBar(ratio)}  <b>${Math.round(ratio * 100)}%</b>\n`;
        text += `   ⏳ Осталось: <b>${mins} мин ${secs} сек</b>\n`;
        text += `   🏁 Истекает: ${fmtDate(expiresAt)}\n`;
      } else {
        text += `   ⏰ Время истекло\n`;
      }
    } else if (!["CREATED", "WAIT_PAYMENT", "WAIT_ADMIN"].includes(rental.status)) {
      text += `   🏁 Истекало: ${fmtDate(expiresAt)}\n`;
    }
  }

  if (rental.endAt && ["RETURNED", "CANCELLED"].includes(rental.status)) {
    text += `   🔚 Возврат: ${fmtDate(rental.endAt)}\n`;
  }
  text += `\n`;

  // Просрочка
  if (rental.status === "WAIT_RETURN") {
    const overdue = await rentalService.getOverdueMinutes(rental);
    if (overdue > 0) {
      const overdueRate = await rentalService.getOverdueRate();
      const cost = overdue * overdueRate;
      text += `⚠️ <b>Просрочка</b>\n`;
      text += `   ⏰ ${fmtDuration(overdue)} — <b>${fmtPrice(cost)}</b>\n`;
      text += `   📊 Тариф: ${overdueRate} сом/мин\n\n`;
      text += `💡 <i>Что можно сделать:</i>\n`;
      text += `   • <b>Продлить</b> — время просрочки вычтется из продления, оплата только за разницу\n`;
      text += `   • <b>Вернуть доску</b> — подойдите на берег, просрочка рассчитается при возврате\n\n`;
    } else {
      const graceMs = await rentalService.getEndGraceMs();
      const graceLabel = graceMs >= 60_000 ? `${Math.round(graceMs / 60_000)} мин` : `${Math.round(graceMs / 1_000)} сек`;
      text += `⏰ Время истекло — у вас ${graceLabel} на возврат без просрочки\n\n`;
    }
  }

  // Раздел: оплата
  text += `💳 <b>Оплата</b>\n`;

  // Базовая стоимость
  let totalPaid = 0;
  let totalPending = 0;

  for (const p of payments) {
    const kindLabel = p.kind === "OVERDUE" ? "просрочка" : "аренда";
    if (p.status === "APPROVED") {
      totalPaid += p.amount;
      text += `   ✅ ${fmtPrice(p.amount)} — ${kindLabel} (оплачено)\n`;
    } else if (p.status === "SUBMITTED") {
      totalPending += p.amount;
      text += `   🔄 ${fmtPrice(p.amount)} — ${kindLabel} (на проверке)\n`;
    } else if (p.status === "REJECTED") {
      text += `   ❌ ${fmtPrice(p.amount)} — ${kindLabel} (отклонено)\n`;
    }
  }

  if (payments.length === 0) {
    if (["CREATED", "WAIT_PAYMENT"].includes(rental.status)) {
      text += `   💤 Ожидает оплаты: <b>${fmtPrice(tariffPrice)}</b>\n`;
    } else {
      text += `   — нет данных об оплате\n`;
    }
  }

  // Итого к оплате (если есть просрочка)
  if (rental.status === "WAIT_RETURN") {
    const overdue = await rentalService.getOverdueMinutes(rental);
    if (overdue > 0) {
      const overdueRate = await rentalService.getOverdueRate();
      const overdueCost = overdue * overdueRate;
      const unpaidOverdue = overdueCost - payments
        .filter(p => p.kind === "OVERDUE" && p.status === "APPROVED")
        .reduce((sum, p) => sum + p.amount, 0);
      if (unpaidOverdue > 0) {
        text += `   ⚠️ К оплате за просрочку: <b>${fmtPrice(unpaidOverdue)}</b>\n`;
      }
    }
  }

  text += `\n`;

  if (rental.pendingExtraMinutes) {
    text += `\n⏳ <b>Запрос продления:</b> +${fmtDuration(rental.pendingExtraMinutes)} (ожидает подтверждения)\n`;
  }

  // Памятка для активной аренды
  if (rental.status === "RENTED") {
    text += `\n💡 <i>Вы можете продлить аренду, нажав кнопку ниже.</i>\n`;
  }

  // Кнопки действий
  const kb = new InlineKeyboard();

  // Продлить — для активных без pending запроса
  if (["RENTED", "WAIT_RETURN"].includes(rental.status) && !rental.pendingExtraMinutes) {
    kb.text("⏱ Продлить", `client:extend:${rental.id}`).row();
  }

  kb.text("⬅️ Мои аренды", "client:my_list").text("⬅️ Меню", "back:menu");

  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
});



/** Выбор тарифа для продления аренды */
myRentalsHandlers.callbackQuery(/^client:extend:(\d+)$/, async (ctx) => {
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
    where: { spotId: rental.spotId, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { durationMinutes: "asc" }],
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

/**
 * Подтверждение продления → отправка QR для оплаты.
 *
 * Записывает pendingExtraMinutes в аренду и отправляет QR-код MBank.
 * После оплаты клиент нажимает «Я оплатил» → создаётся PaymentProof(EXTENSION).
 */
myRentalsHandlers.callbackQuery(/^client:extend_confirm:(\d+):(\d+)$/, async (ctx) => {
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
    // Фиксируем сумму продления в момент запроса — изменение цены тарифа
    // после этого не повлияет на клиента (применяется снапшот в Rental.pendingExtraAmount).
    const discountPct = rental.discountPercent ?? 0;
    const finalExtPrice = applyDiscount(extensionTariff.price, discountPct);

    await rentalService.requestExtend(rentalId, minutes, ctx.dbUser!.id, finalExtPrice);

    const extDiscountLine =
      discountPct > 0
        ? `\n🎁 Скидка: <b>−${discountPct}%</b> (прайс ${fmtPrice(extensionTariff.price)})`
        : "";

    await ctx.editMessageText(
      `⏱ <b>Продление аренды</b>\n\n` +
      `🏄 Доска: <b>${rental.board.code}</b>\n` +
      `⏱ Продление: <b>+${fmtDuration(minutes)}</b>${extDiscountLine}\n` +
      `💰 К оплате: <b>${fmtPrice(finalExtPrice)}</b>\n\n` +
      `💳 Оплатите по QR-коду ниже через <b>мобильный банкинг</b> или 💵 <b>наличными</b> на точке.\n` +
      `После оплаты нажмите <b>«✅ Я оплатил»</b>.`,
      { parse_mode: "HTML" }
    );

    await sendMBankQR(ctx, finalExtPrice, rentalId, "extension");
  } catch (e: any) {
    await ctx.editMessageText(`⌛ ${e.message}`, {
      reply_markup: new InlineKeyboard().text("⬅️ Назад", "client:my_list"),
    });
  }
});

/**
 * Клиент нажал «Я оплатил» за продление.
 *
 * Создаёт PaymentProof(EXTENSION) и уведомляет админов/кассиров.
 */
myRentalsHandlers.callbackQuery(/^ext:paid:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rentalId = parseInt(ctx.match[1]);

  const rental = await prisma.rental.findUnique({
    where: { id: rentalId },
    include: { board: true, tariff: true },
  });

  if (!rental || rental.userId !== ctx.dbUser!.id) {
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    return ctx.reply("⚠️ Аренда не найдена.");
  }

  if (!rental.pendingExtraMinutes) {
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    return ctx.reply("⚠️ Нет активного запроса на продление.", {
      reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
    });
  }

  // Используем снапшот суммы, зафиксированный при запросе продления.
  // Это гарантирует, что изменение цены тарифа не повлияет на клиента.
  // Fallback для старых записей без снапшота — пересчёт по текущему тарифу.
  let finalExtPrice: number;
  if (rental.pendingExtraAmount != null) {
    finalExtPrice = rental.pendingExtraAmount;
  } else {
    const extensionTariff = await prisma.tariff.findFirst({
      where: { spotId: rental.spotId, durationMinutes: rental.pendingExtraMinutes, isActive: true },
    });
    if (!extensionTariff) {
      return ctx.reply("⚠️ Тариф не найден.", {
        reply_markup: new InlineKeyboard().text("⬅️ Меню", "back:menu"),
      });
    }
    finalExtPrice = applyDiscount(extensionTariff.price, rental.discountPercent ?? 0);
  }

  // Идемпотентность — не создаём дубль (только среди ещё не обработанных)
  const existing = await prisma.paymentProof.findFirst({
    where: {
      kind: "EXTENSION",
      refId: rentalId,
      status: "SUBMITTED",
    },
  });

  let proofId: number;
  if (existing) {
    proofId = existing.id;
  } else {
    const proof = await prisma.paymentProof.create({
      data: {
        kind: "EXTENSION",
        refId: rentalId,
        amount: finalExtPrice,
        userId: ctx.dbUser!.id,
      },
    });
    proofId = proof.id;
  }

  try { await ctx.deleteMessage(); } catch { /* ignore */ }

  await ctx.reply(
    `✅ <b>Оплата за продление отправлена на проверку</b>\n\n` +
    `🏄 Доска: <b>${rental.board.code}</b>\n` +
    `⏱ Продление: <b>+${fmtDuration(rental.pendingExtraMinutes)}</b>\n` +
    `💰 Сумма: <b>${fmtPrice(finalExtPrice)}</b>\n\n` +
    `Ожидайте подтверждения.`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("📋 Мои аренды", "client:my_list")
        .text("⬅️ Меню", "back:menu"),
    }
  );

  // Уведомление клиенту в колокольчик
  await prisma.notification.create({
    data: {
      userId: ctx.dbUser!.id,
      text: `💳 Оплата за продление #${proofId} отправлена на проверку — ${rental.board.code}`,
    },
  });

  await notifyAdminsNewPayment(ctx, proofId);
});
