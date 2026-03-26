import { RentalStatus, BoardStatus } from "@prisma/client";
import { prisma } from "../db/prisma";
import { Api } from "grammy";
import { notify } from "./notify";

// Множество ID аренд, для которых уже отправлено предупреждение «скоро конец»
const warnedRentals = new Set<number>();

/** Timeout for unpaid rentals (15 minutes) */
const UNPAID_TIMEOUT_MS = 15 * 60_000;

export function startExpiryChecker(api: Api) {
  const INTERVAL_MS = 10_000; // 10 секунд (чаще для отладки)

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
          const remainSec = Math.ceil(remainingMs / 1000);
          console.log(
            `[expiry] ⚠️ Аренда #${rental.id} (${rental.board.code}) — осталось ${remainSec}с`
          );

          try {
            await notify(
              api,
              chatId,
              `⚠️ Время аренды доски ${rental.board.code} почти истекло!\n` +
              `Осталось менее ${remainSec} сек. Пожалуйста, возвращайтесь к берегу.`
            );
          } catch (e) {
            console.error(`[expiry] Ошибка уведомления клиента ${chatId}:`, e);
          }

          // Уведомить продавцов
          await notifySellers(
            api,
            rental.spotId,
            `⚠️ Доска ${rental.board.code} — время почти истекло (${remainSec}с)\n` +
            `Клиент: ${rental.clientName ?? "Telegram-клиент"}`
          );
        }

        // --- Время вышло — ожидаем возврат доски ---
        if (now >= expiresAt) {
          await prisma.rental.update({
            where: { id: rental.id },
            data: { status: RentalStatus.WAIT_RETURN },
          });

          // Доска остаётся RENTED пока продавец не подтвердит возврат

          warnedRentals.delete(rental.id);

          console.log(
            `[expiry] ⏰ Аренда #${rental.id} (${rental.board.code}) → WAIT_RETURN`
          );

          try {
            await notify(
              api,
              chatId,
              `⏰ Время аренды доски ${rental.board.code} истекло!\n` +
              `Пожалуйста, верните доску на пляж. Спасибо! 🏄`
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
            `Подтвердите возврат доски в разделе «Возвраты».`
          );
        }
      }
    } catch (err) {
      console.error("[expiry] Ошибка:", err);
    }
  }

  tick();
  setInterval(tick, INTERVAL_MS);
  console.log("⏰ Expiry checker started (every 10s)");
}

async function notifySellers(api: Api, spotId: number, text: string) {
  try {
    const sellers = await prisma.user.findMany({
      where: { role: { in: ["SELLER", "ADMIN"] }, spotId },
    });
    for (const seller of sellers) {
      await notify(api, seller.tgId, text);
    }
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
