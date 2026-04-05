/**
 * Фоновый чекер истечения аренд.
 *
 * Запускается каждые 30 секунд и выполняет 4 проверки:
 * 1. Отмена неоплаченных аренд (CREATED/WAIT_PAYMENT старше таймаута)
 * 2. Предупреждение при ≤ 10% оставшегося времени (однократно)
 * 3. Уведомление об истечении времени + начало грейс-периода
 * 4. Перевод в WAIT_RETURN после грейса (начисление просрочки)
 *
 * @module
 */
import { RentalStatus, BoardStatus, Role } from "@prisma/client";
import { prisma } from "../db/prisma";
import { Api } from "grammy";
import { notify, clearOldNotifications } from "./notify";
import { OVERDUE_RATE_PER_MIN, getEndGraceMs, getUnpaidTimeoutMs } from "./rental";
import { escapeHtml } from "../ui/helpers";

// Множество ID аренд, для которых уже отправлено предупреждение «скоро конец»
const warnedRentals = new Set<number>();
// Множество ID аренд, для которых уже отправлено уведомление «время истекло»
const expiredNotifiedRentals = new Set<number>();

/**
 * Сбросить трекинг уведомлений для аренды.
 *
 * Вызывается при продлении с чистым временем — чтобы expiry checker
 * заново рассчитал предупреждения по новому сроку.
 */
export function resetExpiryTracking(rentalId: number) {
  warnedRentals.delete(rentalId);
  expiredNotifiedRentals.delete(rentalId);
}

/**
 * Запустить фоновый чекер истечения аренд.
 *
 * Выполняет первый tick() сразу, затем повторяет каждые 30 секунд.
 * Вызывать один раз при старте бота.
 *
 * @param api - Экземпляр Telegram API для отправки уведомлений
 */
export function startExpiryChecker(api: Api) {
  const INTERVAL_MS = 30_000; // 30 секунд

  async function tick() {
    try {
      const now = new Date();
      const END_GRACE_MS = await getEndGraceMs();
      const UNPAID_TIMEOUT_MS = await getUnpaidTimeoutMs();
      const graceLabel = END_GRACE_MS >= 60_000
        ? `${Math.round(END_GRACE_MS / 60_000)} мин`
        : `${Math.round(END_GRACE_MS / 1_000)} сек`;

      // --- Cancel unpaid rentals that have been stuck for too long ---
      await cancelStaleRentals(api, now, UNPAID_TIMEOUT_MS);

      // --- Auto-reject stale extension payments ---
      await rejectStaleExtensions(api, now, UNPAID_TIMEOUT_MS);

      const activeRentals = await prisma.rental.findMany({
        where: {
          status: {
            in: [
              RentalStatus.RENTED,
            ],
          },
          startAt: { not: null },
          tariffId: { not: null },
        },
        include: {
          tariff: true,
          board: true,
          user: true,
        },
      });

      if (activeRentals.length > 0) {
        console.log(`[expiry] Активных аренд: ${activeRentals.length}`);
      }

      for (const rental of activeRentals) {
        if (!rental.startAt || !rental.tariff) continue;

        const totalMinutes = rental.tariff.durationMinutes + (rental.extraMinutes ?? 0);
        const durationMs = totalMinutes * 60_000;
        const expiresAt = new Date(rental.startAt.getTime() + durationMs);
        const remainingMs = expiresAt.getTime() - now.getTime();
        const chatId = Number(rental.user.tgId);

        // --- Предупреждение: осталось ≤ 10% времени ---
        const warningThreshold = durationMs * 0.1;
        if (
          remainingMs > 0 &&
          remainingMs <= warningThreshold &&
          !warnedRentals.has(rental.id)
        ) {
          warnedRentals.add(rental.id);
          const remainMin = Math.ceil(remainingMs / 60_000);
          console.log(
            `[expiry] ⚠️ Аренда #${rental.id} (${rental.board.code}) — осталось ${remainMin} мин`
          );

          try {
            await notify(
              api,
              chatId,
              `⚠️ Время аренды доски ${rental.board.code} почти истекло!\n` +
              `Осталось менее ${remainMin} мин. Пожалуйста, возвращайтесь к берегу.`
            );
          } catch (e) {
            console.error(`[expiry] Ошибка уведомления клиента ${chatId}:`, e);
          }

          // Уведомить продавцов
          await notifySellers(
            api,
            rental.spotId,
            `⚠️ Доска ${rental.board.code} — время почти истекло (${remainMin} мин)\n` +
            `Клиент: ${escapeHtml(rental.clientName ?? "Telegram-клиент")}`
          );
        }

        // --- Время вышло — уведомляем, но даём 10мин грейс ---
        if (now >= expiresAt && !expiredNotifiedRentals.has(rental.id)) {
          expiredNotifiedRentals.add(rental.id);
          warnedRentals.delete(rental.id);

          console.log(
            `[expiry] ⏰ Аренда #${rental.id} (${rental.board.code}) — время истекло, грейс ${graceLabel}`
          );

          try {
            await notify(
              api,
              chatId,
              `⏰ Время аренды доски ${rental.board.code} истекло!\n` +
              `У вас есть ещё <b>${graceLabel}</b>, чтобы вернуть доску без штрафа. После этого начнётся просрочка (${OVERDUE_RATE_PER_MIN} сом/мин). 🏄`
            );
          } catch (e) {
            console.error(`[expiry] Ошибка уведомления клиента ${chatId}:`, e);
          }

          await notifySellers(
            api,
            rental.spotId,
            `⏰ Время аренды #${rental.id} истекло!\n` +
            `Доска: ${rental.board.code}\n` +
            `Клиент: ${escapeHtml(rental.clientName ?? "Telegram-клиент")}\n` +
            `Бесплатное время на возврат: ${graceLabel}`
          );
        }

        // --- Грейс истёк — переводим в WAIT_RETURN ---
        const graceEnd = new Date(expiresAt.getTime() + END_GRACE_MS);
        if (now >= graceEnd) {
          await prisma.rental.update({
            where: { id: rental.id },
            data: { status: RentalStatus.WAIT_RETURN },
          });

          expiredNotifiedRentals.delete(rental.id);

          console.log(
            `[expiry] ⚠️ Аренда #${rental.id} (${rental.board.code}) → WAIT_RETURN (просрочка ${OVERDUE_RATE_PER_MIN} сом/мин)`
          );

          try {
            await notify(
              api,
              chatId,
              `⚠️ Бесплатное время на возврат истекло! Начисляется просрочка: <b>${OVERDUE_RATE_PER_MIN} сом/мин</b>.\n` +
              `Верните доску ${rental.board.code} как можно скорее!`
            );
          } catch (e) {
            console.error(`[expiry] Ошибка уведомления клиента ${chatId}:`, e);
          }

          await notifySellers(
            api,
            rental.spotId,
            `⚠️ Просрочка по аренде #${rental.id}!\n` +
            `Доска: ${rental.board.code}\n` +
            `Клиент: ${escapeHtml(rental.clientName ?? "Telegram-клиент")}\n` +
            `Начисляется ${OVERDUE_RATE_PER_MIN} сом/мин. Подтвердите возврат в разделе «Возвраты».`
          );
        }
      }
      // Clean up old notifications periodically
      await clearOldNotifications();
    } catch (err) {
      console.error("[expiry] Ошибка:", err);
    }
  }

  tick();
  setInterval(tick, INTERVAL_MS);
  console.log("⏰ Expiry checker started (every 30s)");
}

/**
 * Уведомить всех админов точки проката.
 * @param spotId - ID точки (Spot)
 */
async function notifySellers(api: Api, spotId: number, text: string) {
  try {
    const sellers = await prisma.user.findMany({
      where: { role: Role.ADMIN, spotId },
    });
    await Promise.all(sellers.map((s) => notify(api, s.tgId, text).catch((e) => console.error('[expiry] Ошибка уведомления продавца:', e))));
  } catch (e) {
    console.error("[expiry] Ошибка уведомления продавцов:", e);
  }
}

/** Cancel rentals stuck in CREATED/WAIT_PAYMENT for longer than timeout */
async function cancelStaleRentals(api: Api, now: Date, UNPAID_TIMEOUT_MS: number) {
  const cutoff = new Date(now.getTime() - UNPAID_TIMEOUT_MS);

  const staleRentals = await prisma.rental.findMany({
    where: {
      status: { in: [RentalStatus.CREATED, RentalStatus.WAIT_PAYMENT, RentalStatus.WAIT_ADMIN] },
      createdAt: { lt: cutoff },
    },
    include: { board: true, user: true },
  });

  for (const rental of staleRentals) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.rental.update({
          where: { id: rental.id },
          data: { status: RentalStatus.CANCELLED, endAt: now },
        });
        await tx.board.update({
          where: { id: rental.boardId },
          data: { status: BoardStatus.AVAILABLE },
        });
        // Отклоняем незакрытые чеки оплаты (аренда + продление)
        await tx.paymentProof.updateMany({
          where: {
            refId: rental.id,
            kind: { in: ["RENTAL", "EXTENSION"] },
            status: "SUBMITTED",
          },
          data: { status: "REJECTED" },
        });
      });

      console.log(`[expiry] ⏰ Аренда #${rental.id} (${rental.board.code}) отменена — не оплачена за ${UNPAID_TIMEOUT_MS / 60_000} мин`);

      try {
        await notify(
          api,
          Number(rental.user.tgId),
          `❌ Аренда доски <b>${rental.board.code}</b> автоматически отменена — не была оплачена в течение ${UNPAID_TIMEOUT_MS / 60_000} минут.`
        );
      } catch { }
    } catch (e) {
      console.error(`[expiry] Ошибка отмены stale аренды #${rental.id}:`, e);
    }
  }
}

/** Авто-отклонение неоплаченных продлений (EXTENSION) по таймауту */
async function rejectStaleExtensions(api: Api, now: Date, UNPAID_TIMEOUT_MS: number) {
  const cutoff = new Date(now.getTime() - UNPAID_TIMEOUT_MS);

  const staleProofs = await prisma.paymentProof.findMany({
    where: {
      kind: "EXTENSION",
      status: "SUBMITTED",
      createdAt: { lt: cutoff },
    },
    include: { user: true },
  });

  for (const proof of staleProofs) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.paymentProof.update({
          where: { id: proof.id },
          data: { status: "REJECTED" },
        });
        await tx.rental.update({
          where: { id: proof.refId },
          data: { pendingExtraMinutes: null },
        });
      });

      console.log(`[expiry] ⏰ Оплата продления #${proof.id} (аренда #${proof.refId}) отклонена — не подтверждена за ${UNPAID_TIMEOUT_MS / 60_000} мин`);

      try {
        await notify(
          api,
          Number(proof.user.tgId),
          `❌ Запрос на продление аренды #${proof.refId} автоматически отклонён — оплата не подтверждена в течение ${UNPAID_TIMEOUT_MS / 60_000} минут.`
        );
      } catch { }
    } catch (e) {
      console.error(`[expiry] Ошибка отклонения stale продления #${proof.id}:`, e);
    }
  }
}
