/**
 * Фоновый чекер истечения аренд.
 *
 * Запускается каждые 30 секунд и выполняет 4 проверки:
 * 1. Отмена неоплаченных аренд (CREATED/WAIT_PAYMENT старше таймаута)
 * 2. Предупреждение при ≤ 10% оставшегося времени (однократно)
 * 3. Уведомление об истечении времени + начало грейс-периода
 * 4. Перевод в WAIT_RETURN после грейса (начисление просрочки)
 *
 * Архитектура: вся работа с БД идёт внутри одной короткой транзакции
 * (advisory-xact lock + фактические апдейты). Telegram-уведомления
 * собираются в очередь и отправляются параллельно ПОСЛЕ коммита,
 * чтобы не держать соединение БД во время медленных сетевых вызовов.
 *
 * @module
 */
import { RentalStatus, BoardStatus, Role, PaymentProofKind, PaymentProofStatus, Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { Api } from "grammy";
import { getEndGraceMs, getUnpaidTimeoutMs } from "./rental";
import { getOverdueRate } from "./settings";
import { escapeHtml } from "../ui/helpers";

/**
 * Advisory lock ID для expiry checker.
 * Гарантирует что только один инстанс бота выполняет tick() одновременно.
 */
const EXPIRY_LOCK_ID = 100500;

// Множество ID аренд, для которых уже отправлено предупреждение «скоро конец»
const warnedRentals = new Set<number>();
// Множество ID аренд, для которых уже отправлено уведомление «время истекло»
const expiredNotifiedRentals = new Set<number>();

/**
 * Очередь Telegram-сообщений, собираемая внутри транзакции
 * и отправляемая после её коммита (чтобы не держать соединение БД).
 */
type ClientNotif = { userId: number; tgId: bigint; text: string };
type SellerNotif = { spotId: number; text: string };

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

/** Удалить HTML-теги перед сохранением текста уведомления в БД */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "");
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
  let running = false; // защита от перекрытия tick при долгой обработке

  async function tick() {
    if (running) {
      // Предыдущий tick ещё не завершился — пропускаем,
      // чтобы не копить параллельные тяжёлые операции.
      return;
    }
    running = true;

    const clientNotifs: ClientNotif[] = [];
    const sellerNotifs: SellerNotif[] = [];

    try {
      const acquired = await prisma.$transaction(async (tx) => {
        // Транзакционный advisory lock авто-освобождается на коммите.
        const [lockResult] = await tx.$queryRawUnsafe<{ acquired: boolean }[]>(
          `SELECT pg_try_advisory_xact_lock($1) AS acquired`, EXPIRY_LOCK_ID
        );
        if (!lockResult?.acquired) {
          return false; // другой инстанс уже выполняет tick
        }

        const now = new Date();
        const END_GRACE_MS = getEndGraceMs();
        const UNPAID_TIMEOUT_MS = getUnpaidTimeoutMs();
        const graceLabel = END_GRACE_MS === 0
          ? "без грейса"
          : END_GRACE_MS >= 60_000
            ? `${Math.round(END_GRACE_MS / 60_000)} мин`
            : `${Math.round(END_GRACE_MS / 1_000)} сек`;

        await processStaleRentals(tx, now, UNPAID_TIMEOUT_MS, clientNotifs);
        await processStaleExtensions(tx, now, UNPAID_TIMEOUT_MS, clientNotifs);

        const activeRentals = await tx.rental.findMany({
          where: {
            status: RentalStatus.RENTED,
            startAt: { not: null },
            tariffId: { not: null },
          },
          include: {
            tariff: true,
            board: true,
            user: true,
          },
        });

        const [totalBoards, freeBoards, rentedBoards, serviceBoards, waitPayment, waitAdmin, waitReturn] = await Promise.all([
          tx.board.count(),
          tx.board.count({ where: { status: BoardStatus.AVAILABLE } }),
          tx.board.count({ where: { status: BoardStatus.RENTED } }),
          tx.board.count({ where: { status: BoardStatus.SERVICE } }),
          tx.rental.count({
            where: { status: { in: [RentalStatus.CREATED, RentalStatus.WAIT_PAYMENT] } },
          }),
          tx.rental.count({ where: { status: RentalStatus.WAIT_ADMIN } }),
          tx.rental.count({ where: { status: RentalStatus.WAIT_RETURN } }),
        ]);
        const ts = now.toLocaleTimeString("ru-RU", { hour12: false });
        console.log(
          `[${ts}] аренды: активных ${activeRentals.length}, ждут возврата ${waitReturn} | ` +
          `доски: ${rentedBoards}/${totalBoards} занято (свободно ${freeBoards}, сервис ${serviceBoards}) | ` +
          `ожидают: оплату ${waitPayment}, подтверждение ${waitAdmin}`
        );

        // --- Prune in-memory Set'ов от мёртвых ID ---
        const activeIds = new Set(activeRentals.map((r) => r.id));
        for (const id of warnedRentals) {
          if (!activeIds.has(id)) warnedRentals.delete(id);
        }
        for (const id of expiredNotifiedRentals) {
          if (!activeIds.has(id)) expiredNotifiedRentals.delete(id);
        }

        const overdueRate = await getOverdueRate();

        for (const rental of activeRentals) {
          if (!rental.startAt || !rental.tariff) continue;

          const totalMinutes = rental.tariff.durationMinutes + (rental.extraMinutes ?? 0);
          const durationMs = totalMinutes * 60_000;
          const expiresAt = new Date(rental.startAt.getTime() + durationMs);
          const remainingMs = expiresAt.getTime() - now.getTime();
          const isWalkin = !!rental.sellerUserId;

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

            if (!isWalkin) {
              clientNotifs.push({
                userId: rental.user.id,
                tgId: rental.user.tgId,
                text:
                  `⚠️ Время аренды доски ${rental.board.code} почти истекло!\n` +
                  `Осталось менее ${remainMin} мин. Пожалуйста, возвращайтесь к берегу.`,
              });
            }

            sellerNotifs.push({
              spotId: rental.spotId,
              text:
                `⚠️ Доска ${rental.board.code} — время почти истекло (${remainMin} мин)\n` +
                `Клиент: ${escapeHtml(rental.clientName ?? "Telegram-клиент")}`,
            });
          }

          // --- Время вышло — уведомляем, но даём грейс ---
          if (now >= expiresAt && !expiredNotifiedRentals.has(rental.id)) {
            expiredNotifiedRentals.add(rental.id);
            warnedRentals.delete(rental.id);

            console.log(
              `[expiry] ⏰ Аренда #${rental.id} (${rental.board.code}) — время истекло, грейс ${graceLabel}`
            );

            if (!isWalkin) {
              clientNotifs.push({
                userId: rental.user.id,
                tgId: rental.user.tgId,
                text:
                  `⏰ Время аренды доски ${rental.board.code} истекло!\n` +
                  `У вас есть ещё <b>${graceLabel}</b>, чтобы вернуть доску без штрафа. После этого начнётся просрочка (${overdueRate} сом/мин). 🏄`,
              });
            }

            sellerNotifs.push({
              spotId: rental.spotId,
              text:
                `⏰ Время аренды #${rental.id} истекло!\n` +
                `Доска: ${rental.board.code}\n` +
                `Клиент: ${escapeHtml(rental.clientName ?? "Telegram-клиент")}\n` +
                `Бесплатное время на возврат: ${graceLabel}`,
            });
          }

          // --- Грейс истёк — переводим в WAIT_RETURN ---
          const graceEnd = new Date(expiresAt.getTime() + END_GRACE_MS);
          if (now >= graceEnd) {
            await tx.rental.update({
              where: { id: rental.id },
              data: { status: RentalStatus.WAIT_RETURN },
            });

            expiredNotifiedRentals.delete(rental.id);

            console.log(
              `[expiry] ⚠️ Аренда #${rental.id} (${rental.board.code}) → WAIT_RETURN (просрочка ${overdueRate} сом/мин)`
            );

            if (!isWalkin) {
              clientNotifs.push({
                userId: rental.user.id,
                tgId: rental.user.tgId,
                text:
                  `⚠️ Бесплатное время на возврат истекло! Начисляется просрочка: <b>${overdueRate} сом/мин</b>.\n` +
                  `Верните доску ${rental.board.code} как можно скорее!`,
              });
            }

            sellerNotifs.push({
              spotId: rental.spotId,
              text:
                `⚠️ Просрочка по аренде #${rental.id}!\n` +
                `Доска: ${rental.board.code}\n` +
                `Клиент: ${escapeHtml(rental.clientName ?? "Telegram-клиент")}\n` +
                `Начисляется ${overdueRate} сом/мин. Подтвердите возврат в разделе «Возвраты».`,
            });
          }
        }

        return true;
      }, { timeout: 10_000 });

      if (!acquired) return;

      // Telegram-вызовы и bulk-вставка Notification ВНЕ транзакции
      if (clientNotifs.length > 0 || sellerNotifs.length > 0) {
        await dispatchNotifications(api, clientNotifs, sellerNotifs);
      }
    } catch (err) {
      console.error("[expiry] Ошибка:", err);
    } finally {
      running = false;
    }
  }

  void tick();
  const intervalId = setInterval(() => void tick(), INTERVAL_MS);
  intervalId.unref?.();
  console.log("⏰ Expiry checker started (every 30s)");

  return () => clearInterval(intervalId);
}

/**
 * Разослать собранные уведомления параллельно.
 * Не держит транзакцию БД, безопасно для медленных Telegram-вызовов.
 */
async function dispatchNotifications(
  api: Api,
  clientNotifs: ClientNotif[],
  sellerNotifs: SellerNotif[],
) {
  // 1. Резолвим продавцов одной выборкой по всем уникальным spotId
  const uniqueSpotIds = [...new Set(sellerNotifs.map((n) => n.spotId))];
  const sellersBySpot = new Map<number, { id: number; tgId: bigint }[]>();
  if (uniqueSpotIds.length > 0) {
    const sellers = await prisma.user.findMany({
      where: { role: { in: [Role.ADMIN, Role.CASHIER] }, spotId: { in: uniqueSpotIds } },
      select: { id: true, tgId: true, spotId: true },
    });
    for (const s of sellers) {
      if (s.spotId == null) continue;
      const arr = sellersBySpot.get(s.spotId) ?? [];
      arr.push({ id: s.id, tgId: s.tgId });
      sellersBySpot.set(s.spotId, arr);
    }
  }

  // 2. Bulk-вставка строк Notification (одной командой createMany)
  const notifRows: { userId: number; text: string }[] = [];
  for (const n of clientNotifs) {
    notifRows.push({ userId: n.userId, text: stripHtml(n.text) });
  }
  for (const n of sellerNotifs) {
    const sellers = sellersBySpot.get(n.spotId) ?? [];
    const stripped = stripHtml(n.text);
    for (const s of sellers) {
      notifRows.push({ userId: s.id, text: stripped });
    }
  }
  if (notifRows.length > 0) {
    try {
      await prisma.notification.createMany({ data: notifRows });
    } catch (e) {
      console.error("[expiry] Ошибка bulk-вставки уведомлений:", e);
    }
  }

  // 3. Параллельная отправка Telegram-сообщений
  const jobs: Promise<unknown>[] = [];
  for (const n of clientNotifs) {
    jobs.push(
      api.sendMessage(Number(n.tgId), n.text, { parse_mode: "HTML" })
        .catch((e) => console.error(`[expiry] sendMessage(${n.tgId}):`, e?.description ?? e?.message ?? e))
    );
  }
  for (const n of sellerNotifs) {
    const sellers = sellersBySpot.get(n.spotId) ?? [];
    for (const s of sellers) {
      jobs.push(
        api.sendMessage(Number(s.tgId), n.text, { parse_mode: "HTML" })
          .catch((e) => console.error(`[expiry] sendMessage seller(${s.tgId}):`, e?.description ?? e?.message ?? e))
      );
    }
  }
  await Promise.allSettled(jobs);
}

/** Cancel rentals stuck in CREATED/WAIT_PAYMENT for longer than timeout */
async function processStaleRentals(
  tx: Prisma.TransactionClient,
  now: Date,
  UNPAID_TIMEOUT_MS: number,
  clientNotifs: ClientNotif[],
) {
  const cutoff = new Date(now.getTime() - UNPAID_TIMEOUT_MS);

  const staleRentals = await tx.rental.findMany({
    where: {
      status: { in: [RentalStatus.CREATED, RentalStatus.WAIT_PAYMENT] },
      createdAt: { lt: cutoff },
    },
    include: { board: true, user: true },
  });

  if (staleRentals.length === 0) return;

  const ids = staleRentals.map((r) => r.id);
  const boardIds = staleRentals.map((r) => r.boardId);

  await tx.rental.updateMany({
    where: { id: { in: ids } },
    data: { status: RentalStatus.CANCELLED, endAt: now },
  });
  await tx.board.updateMany({
    where: { id: { in: boardIds } },
    data: { status: BoardStatus.AVAILABLE },
  });
  await tx.paymentProof.updateMany({
    where: {
      refId: { in: ids },
      kind: { in: [PaymentProofKind.RENTAL, PaymentProofKind.EXTENSION] },
      status: PaymentProofStatus.SUBMITTED,
    },
    data: { status: PaymentProofStatus.REJECTED },
  });

  const minutes = UNPAID_TIMEOUT_MS / 60_000;
  for (const rental of staleRentals) {
    console.log(`[expiry] ⏰ Аренда #${rental.id} (${rental.board.code}) отменена — не оплачена за ${minutes} мин`);
    clientNotifs.push({
      userId: rental.user.id,
      tgId: rental.user.tgId,
      text: `❌ Аренда доски <b>${rental.board.code}</b> автоматически отменена — не была оплачена в течение ${minutes} минут.`,
    });
  }
}

/** Авто-отклонение неоплаченных продлений (EXTENSION) по таймауту */
async function processStaleExtensions(
  tx: Prisma.TransactionClient,
  now: Date,
  UNPAID_TIMEOUT_MS: number,
  clientNotifs: ClientNotif[],
) {
  const cutoff = new Date(now.getTime() - UNPAID_TIMEOUT_MS);

  const staleProofs = await tx.paymentProof.findMany({
    where: {
      kind: PaymentProofKind.EXTENSION,
      status: PaymentProofStatus.SUBMITTED,
      createdAt: { lt: cutoff },
    },
    include: { user: true },
  });

  if (staleProofs.length === 0) return;

  const proofIds = staleProofs.map((p) => p.id);
  const rentalIds = [...new Set(staleProofs.map((p) => p.refId))];

  await tx.paymentProof.updateMany({
    where: { id: { in: proofIds } },
    data: { status: PaymentProofStatus.REJECTED },
  });
  await tx.rental.updateMany({
    where: { id: { in: rentalIds } },
    data: { pendingExtraMinutes: null, pendingExtraAmount: null },
  });

  const minutes = UNPAID_TIMEOUT_MS / 60_000;
  for (const proof of staleProofs) {
    console.log(`[expiry] ⏰ Оплата продления #${proof.id} (аренда #${proof.refId}) отклонена — не подтверждена за ${minutes} мин`);
    clientNotifs.push({
      userId: proof.user.id,
      tgId: proof.user.tgId,
      text: `❌ Запрос на продление аренды #${proof.refId} автоматически отклонён — оплата не подтверждена в течение ${minutes} минут.`,
    });
  }
}
