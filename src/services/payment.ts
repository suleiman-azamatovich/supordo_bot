/**
 * Сервис оплаты — обработка чеков оплаты (PaymentProof).
 *
 * Поддерживает два типа: RENTAL (оплата аренды) и OVERDUE (оплата просрочки).
 * При одобрении автоматически вызывает соответствующую операцию аренды.
 *
 * @module
 */
import { PaymentProofStatus, PaymentProofKind, AuditAction, RentalStatus, BoardStatus } from "@prisma/client";
import { prisma } from "../db/prisma";
import * as audit from "./audit";
import * as rentalService from "./rental";

/** Формирует понятное описание, почему оплата уже не может быть обработана */
async function describeAlreadyProcessed(proof: { status: PaymentProofStatus; reviewedBy: number | null; refId: number; kind: PaymentProofKind }): Promise<string> {
  if (proof.status === PaymentProofStatus.APPROVED) {
    return "Эта оплата уже подтверждена";
  }
  // REJECTED без reviewedBy — авто-отклонение при отмене аренды
  if (proof.status === PaymentProofStatus.REJECTED && !proof.reviewedBy) {
    const rental = await prisma.rental.findUnique({ where: { id: proof.refId } });
    if (rental?.status === RentalStatus.CANCELLED) {
      return "Аренда была автоматически отменена (клиент не оплатил вовремя) — оплата отклонена автоматически";
    }
    return "Эта оплата была автоматически отклонена";
  }
  return "Эта оплата уже обработана";
}

/**
 * Получить список необработанных чеков оплаты (статус SUBMITTED).
 * @param page - Номер страницы (1-based)
 * @param pageSize - Количество элементов на странице
 */
export async function getPendingPayments(page: number, pageSize: number) {
  const total = await prisma.paymentProof.count({
    where: { status: PaymentProofStatus.SUBMITTED },
  });
  const items = await prisma.paymentProof.findMany({
    where: { status: PaymentProofStatus.SUBMITTED },
    orderBy: { createdAt: "asc" },
    skip: (page - 1) * pageSize,
    take: pageSize,
    include: { user: true },
  });
  return { items, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

/**
 * Одобрить чек оплаты.
 *
 * Для RENTAL-чеков вызывает `approveRental()` (аренда → RENTED).
 * Для OVERDUE-чеков вызывает `closeOverdue()` (закрытие просрочки).
 *
 * @throws Если чек уже обработан
 */
export async function approvePayment(proofId: number, adminUserId: number) {
  const existing = await prisma.paymentProof.findUniqueOrThrow({ where: { id: proofId } });
  if (existing.status !== PaymentProofStatus.SUBMITTED) {
    throw new Error(await describeAlreadyProcessed(existing));
  }

  const proof = await prisma.paymentProof.update({
    where: { id: proofId },
    data: { status: PaymentProofStatus.APPROVED, reviewedBy: adminUserId, reviewedAt: new Date() },
  });

  await audit.log(adminUserId, "PaymentProof", proofId, AuditAction.PAYMENT_APPROVED, {
    amount: proof.amount,
    kind: proof.kind,
    rentalId: proof.refId,
  });

  if (proof.kind === PaymentProofKind.RENTAL) {
    await rentalService.approveRental(proof.refId, adminUserId);
  } else if (proof.kind === PaymentProofKind.OVERDUE) {
    const rental = await prisma.rental.findUnique({
      where: { id: proof.refId },
      include: { board: true },
    });
    if (rental) {
      if (rental.status === "WAIT_RETURN") {
        // Аренда ещё активна — закрываем просрочку
        await rentalService.closeOverdue(proof.refId, adminUserId);
      }
      // Освобождаем доску (если аренда завершена и просрочка оплачена)
      if (rental.board.status !== BoardStatus.AVAILABLE) {
        await prisma.board.update({
          where: { id: rental.boardId },
          data: { status: BoardStatus.AVAILABLE },
        });
      }
    }
  }
  // EXTENSION: extendRental вызывается в обработчике pay:approve (нужны данные для уведомления)

  return proof;
}

/**
 * Отклонить чек оплаты.
 *
 * Для RENTAL-чеков: отменяет аренду и освобождает доску.
 * Для OVERDUE-чеков: отказ = списание долга (без изменения статуса).
 *
 * @throws Если чек уже обработан
 */
export async function rejectPayment(proofId: number, adminUserId: number, reason?: string) {
  const existing = await prisma.paymentProof.findUniqueOrThrow({ where: { id: proofId } });
  if (existing.status !== PaymentProofStatus.SUBMITTED) {
    throw new Error(await describeAlreadyProcessed(existing));
  }

  const proof = await prisma.paymentProof.update({
    where: { id: proofId },
    data: {
      status: PaymentProofStatus.REJECTED,
      reviewedBy: adminUserId,
      reviewedAt: new Date(),
      ...(reason ? { text: reason } : {}),
    },
  });

  await audit.log(adminUserId, "PaymentProof", proofId, AuditAction.PAYMENT_REJECTED, {
    amount: proof.amount,
    kind: proof.kind,
    rentalId: proof.refId,
    ...(reason ? { reason } : {}),
  });

  if (proof.kind === PaymentProofKind.RENTAL) {
    // Отменяем аренду и освобождаем доску
    await rentalService.cancelRental(proof.refId, adminUserId);
  } else if (proof.kind === PaymentProofKind.EXTENSION) {
    // Сбрасываем запрос на продление
    await rentalService.rejectExtend(proof.refId, adminUserId);
  } else if (proof.kind === PaymentProofKind.OVERDUE) {
    // Отклонение = списание долга → освобождаем доску
    const rental = await prisma.rental.findUnique({
      where: { id: proof.refId },
      include: { board: true },
    });
    if (rental && rental.board.status !== BoardStatus.AVAILABLE) {
      await prisma.board.update({
        where: { id: rental.boardId },
        data: { status: BoardStatus.AVAILABLE },
      });
    }
  }

  return proof;
}
