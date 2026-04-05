/**
 * Сервис оплаты — обработка чеков оплаты (PaymentProof).
 *
 * Поддерживает два типа: RENTAL (оплата аренды) и OVERDUE (оплата просрочки).
 * При одобрении автоматически вызывает соответствующую операцию аренды.
 *
 * @module
 */
import { PaymentProofStatus, PaymentProofKind } from "@prisma/client";
import { prisma } from "../db/prisma";
import * as audit from "./audit";
import * as rentalService from "./rental";

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
    throw new Error("Эта оплата уже обработана");
  }

  const proof = await prisma.paymentProof.update({
    where: { id: proofId },
    data: { status: PaymentProofStatus.APPROVED, reviewedBy: adminUserId },
  });

  await audit.log(adminUserId, "PaymentProof", proofId, "APPROVED");

  if (proof.kind === PaymentProofKind.RENTAL) {
    await rentalService.approveRental(proof.refId, adminUserId);
  } else if (proof.kind === PaymentProofKind.OVERDUE) {
    // If rental is still active (WAIT_RETURN), close the overdue
    const rental = await prisma.rental.findUnique({ where: { id: proof.refId } });
    if (rental && rental.status === "WAIT_RETURN") {
      await rentalService.closeOverdue(proof.refId, adminUserId);
    }
  }

  return proof;
}

/**
 * Отклонить чек оплаты.
 *
 * Для RENTAL-чеков: возвращает аренду в WAIT_PAYMENT для повторной оплаты.
 * Для OVERDUE-чеков: отказ = списание долга (без изменения статуса).
 *
 * @throws Если чек уже обработан
 */
export async function rejectPayment(proofId: number, adminUserId: number) {
  const existing = await prisma.paymentProof.findUniqueOrThrow({ where: { id: proofId } });
  if (existing.status !== PaymentProofStatus.SUBMITTED) {
    throw new Error("Эта оплата уже обработана");
  }

  const proof = await prisma.paymentProof.update({
    where: { id: proofId },
    data: { status: PaymentProofStatus.REJECTED, reviewedBy: adminUserId },
  });

  await audit.log(adminUserId, "PaymentProof", proofId, "REJECTED");

  if (proof.kind === PaymentProofKind.RENTAL) {
    await prisma.rental.update({
      where: { id: proof.refId },
      data: { status: "WAIT_PAYMENT" },
    });
  }
  // OVERDUE: rejecting = waiving the charge, no status changes

  return proof;
}
