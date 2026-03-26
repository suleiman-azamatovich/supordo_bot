import { PaymentProofStatus, PaymentProofKind } from "@prisma/client";
import { prisma } from "../db/prisma";
import * as audit from "./audit";
import * as rentalService from "./rental";
import * as bookingService from "./booking";

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

export async function approvePayment(proofId: number, adminUserId: number) {
  const proof = await prisma.paymentProof.update({
    where: { id: proofId },
    data: { status: PaymentProofStatus.APPROVED, reviewedBy: adminUserId },
  });

  await audit.log(adminUserId, "PaymentProof", proofId, "APPROVED");

  if (proof.kind === PaymentProofKind.RENTAL) {
    await rentalService.approveRental(proof.refId, adminUserId);
  } else if (proof.kind === PaymentProofKind.BOOKING) {
    await bookingService.approveBooking(proof.refId, adminUserId);
  }
  // OVERDUE: just mark as approved, rental already RETURNED

  return proof;
}

export async function rejectPayment(proofId: number, adminUserId: number) {
  const proof = await prisma.paymentProof.update({
    where: { id: proofId },
    data: { status: PaymentProofStatus.REJECTED, reviewedBy: adminUserId },
  });

  await audit.log(adminUserId, "PaymentProof", proofId, "REJECTED");

  // Move booking/rental back to WAIT_PAYMENT so the client can retry
  if (proof.kind === PaymentProofKind.RENTAL) {
    await prisma.rental.update({
      where: { id: proof.refId },
      data: { status: "WAIT_PAYMENT" },
    });
  } else if (proof.kind === PaymentProofKind.BOOKING) {
    await prisma.booking.update({
      where: { id: proof.refId },
      data: { status: "WAIT_PAYMENT" },
    });
  }
  // OVERDUE: rejecting = waiving the charge, no status changes

  return proof;
}
