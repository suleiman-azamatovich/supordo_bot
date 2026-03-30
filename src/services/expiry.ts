import { RentalStatus, BoardStatus } from "@prisma/client";
import { prisma } from "../db/prisma";
import { Api } from "grammy";
import { notify } from "./notify";
import { END_GRACE_MINUTES, OVERDUE_RATE_PER_MIN } from "./rental";

// Множество ID аренд, для которых уже отправлено предупреждение «скоро конец»
const warnedRentals = new Set<number>();
// Множество ID аренд, для которых уже отправлено уведомление «время истекло»
const expiredNotifiedRentals = new Set<number>();

/** Timeout for unpaid rentals (15 minutes) */
const UNPAID_TIMEOUT_MS = 15 * 60_000;

export function startExpiryChecker(api: Api) {
  const INTERVAL_MS = 30_000; // 30 секунд

  async function tick() {
    try {
      const now = new Date();

      // --- Cancel unpaid rentals that have been stuck for too long ---
      await cancelStaleRentals(api, now);

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
            `Клиент: ${rental.clientName ?? "Telegram-клиент"}`
          );
        }

        // --- Время вышло — уведомляем, но даём 10мин грейс ---
        if (now >= expiresAt && !expiredNotifiedRentals.has(rental.id)) {
          expiredNotifiedRentals.add(rental.id);
          warnedRentals.delete(rental.id);

          console.log(
            `[expiry] ⏰ Аренда #${rental.id} (${rental.board.code}) — время истекло, грейс ${END_GRACE_MINUTES} мин`
          );

          try {
            await notify(
              api,
              chatId,
              `⏰ Время аренды доски ${rental.board.code} истекло!\n` +
              `У вас есть ${END_GRACE_MINUTES} минут чтобы вернуть доску. После этого начнётся просрочка (${OVERDUE_RATE_PER_MIN} сом/мин). 🏄`
            );
          } catch (e) {
            console.error(`[expiry] Ошибка уведомления клиента ${chatId}:`, e);
          }

          await notifySellers(
            api,
            rental.spotId,
            `⏰ Время аренды #${rental.id} истекло!\n` +
            `Доска: ${rental.board.code}\n` +
            `Клиент: ${rental.clientName ?? "Telegram-клиент"}\n` +
            `Грейс: ${END_GRACE_MINUTES} мин до начала просрочки.`
          );
        }

        // --- Грейс истёк — переводим в WAIT_RETURN ---
        const graceEnd = new Date(expiresAt.getTime() + END_GRACE_MINUTES * 60_000);
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
              `⚠️ Грейс-период истёк! Начисляется просрочка: <b>${OVERDUE_RATE_PER_MIN} сом/мин</b>.\n` +
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
            `Клиент: ${rental.clientName ?? "Telegram-клиент"}\n` +
            `Начисляется ${OVERDUE_RATE_PER_MIN} сом/мин. Подтвердите возврат в разделе «Возвраты».`
          );
        }
      }
    } catch (err) {
      console.error("[expiry] Ошибка:", err);
    }
  }

  tick();
  setInterval(tick, INTERVAL_MS);
  console.log("⏰ Expiry checker started (every 30s)");
}

async function notifySellers(api: Api, spotId: number, text: string) {
  try {
    const sellers = await prisma.user.findMany({
      where: { role: { in: ["SELLER", "ADMIN"] }, spotId },
    });
    await Promise.all(sellers.map((s) => notify(api, s.tgId, text).catch(() => { })));
  } catch (e) {
    console.error("[expiry] Ошибка уведомления продавцов:", e);
  }
}

/** Cancel rentals stuck in CREATED/WAIT_PAYMENT for longer than UNPAID_TIMEOUT_MS */
async function cancelStaleRentals(api: Api, now: Date) {
  const cutoff = new Date(now.getTime() - UNPAID_TIMEOUT_MS);

  const staleRentals = await prisma.rental.findMany({
    where: {
      status: { in: [RentalStatus.CREATED, RentalStatus.WAIT_PAYMENT] },
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
