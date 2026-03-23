import {
  RentalStatus,
  BoardStatus,
  PaymentProofKind,
  PaymentProofStatus,
} from "@prisma/client";
import { prisma } from "../db/prisma";
import * as audit from "./audit";

export async function createRental(params: {
  userId: number;
  spotId: number;
  boardId: number;
  tariffId: number;
  sellerUserId?: number;
  clientName?: string;
}) {
  const tariff = await prisma.tariff.findUniqueOrThrow({
    where: { id: params.tariffId },
  });

  const board = await prisma.board.findUniqueOrThrow({
    where: { id: params.boardId },
  });

  if (board.status !== BoardStatus.AVAILABLE) {
    throw new Error("Доска недоступна для аренды");
  }

  const rental = await prisma.rental.create({
    data: {
      userId: params.userId,
      spotId: params.spotId,
      boardId: params.boardId,
      tariffId: params.tariffId,
      sellerUserId: params.sellerUserId,
      clientName: params.clientName,
      status: RentalStatus.CREATED,
    },
  });

  // Mark board as rented immediately
  await prisma.board.update({
    where: { id: params.boardId },
    data: { status: BoardStatus.RENTED },
  });

  await audit.log(params.userId, "Rental", rental.id, "CREATED", {
    tariffId: tariff.id,
    price: tariff.price,
    sellerUserId: params.sellerUserId,
    clientName: params.clientName,
  });

  return { rental, tariff };
}

/** Seller creates walk-in rental: board picked → tariff picked → client name → immediately RENTED */
export async function createWalkinRental(params: {
  sellerUserId: number;
  spotId: number;
  boardId: number;
  tariffId: number;
  clientName: string;
}) {
  const tariff = await prisma.tariff.findUniqueOrThrow({
    where: { id: params.tariffId },
  });

  const board = await prisma.board.findUniqueOrThrow({
    where: { id: params.boardId },
  });

  if (board.status !== BoardStatus.AVAILABLE) {
    throw new Error("Доска недоступна для аренды");
  }

  const now = new Date();
  const rental = await prisma.rental.create({
    data: {
      userId: params.sellerUserId,
      spotId: params.spotId,
      boardId: params.boardId,
      tariffId: params.tariffId,
      sellerUserId: params.sellerUserId,
      clientName: params.clientName,
      status: RentalStatus.RENTED,
      startAt: now,
    },
  });

  await prisma.board.update({
    where: { id: params.boardId },
    data: { status: BoardStatus.RENTED },
  });

  await audit.log(params.sellerUserId, "Rental", rental.id, "WALKIN_CREATED", {
    tariffId: tariff.id,
    price: tariff.price,
    clientName: params.clientName,
  });

  return { rental, tariff };
}

export async function moveToWaitPayment(rentalId: number, userId: number) {
  const rental = await prisma.rental.update({
    where: { id: rentalId },
    data: { status: RentalStatus.WAIT_PAYMENT },
  });
  await audit.log(userId, "Rental", rentalId, "WAIT_PAYMENT");
  return rental;
}

export async function submitPayment(params: {
  rentalId: number;
  userId: number;
  amount: number;
  fileId?: string;
  text?: string;
}) {
  // Idempotency: don't create duplicate SUBMITTED proofs
  const existing = await prisma.paymentProof.findFirst({
    where: {
      kind: PaymentProofKind.RENTAL,
      refId: params.rentalId,
      status: { in: [PaymentProofStatus.SUBMITTED, PaymentProofStatus.APPROVED] },
    },
  });
  if (existing) {
    return { proof: existing, duplicate: true };
  }

  const proof = await prisma.paymentProof.create({
    data: {
      kind: PaymentProofKind.RENTAL,
      refId: params.rentalId,
      amount: params.amount,
      fileId: params.fileId,
      text: params.text,
      userId: params.userId,
    },
  });

  await prisma.rental.update({
    where: { id: params.rentalId },
    data: { status: RentalStatus.WAIT_ADMIN },
  });

  await audit.log(params.userId, "PaymentProof", proof.id, "SUBMITTED", {
    rentalId: params.rentalId,
    amount: params.amount,
  });

  return { proof, duplicate: false };
}

export async function approveRental(rentalId: number, adminUserId: number) {
  const rental = await prisma.rental.update({
    where: { id: rentalId },
    data: { status: RentalStatus.RENTED, startAt: new Date() },
  });
  await prisma.board.update({
    where: { id: rental.boardId },
    data: { status: BoardStatus.RENTED },
  });
  await audit.log(adminUserId, "Rental", rentalId, "APPROVED_AND_RENTED");
  return rental;
}

export async function acceptReturn(rentalId: number, sellerUserId: number) {
  const rental = await prisma.rental.update({
    where: { id: rentalId },
    data: { status: RentalStatus.RETURNED, endAt: new Date() },
  });
  await prisma.board.update({
    where: { id: rental.boardId },
    data: { status: BoardStatus.AVAILABLE },
  });
  await audit.log(sellerUserId, "Rental", rentalId, "RETURNED");
  return rental;
}

export async function cancelRental(rentalId: number, userId: number) {
  const rental = await prisma.rental.findUniqueOrThrow({
    where: { id: rentalId },
  });
  const updated = await prisma.rental.update({
    where: { id: rentalId },
    data: { status: RentalStatus.CANCELLED, endAt: new Date() },
  });

  // Release board back to available
  await prisma.board.update({
    where: { id: updated.boardId },
    data: { status: BoardStatus.AVAILABLE },
  });

  await audit.log(userId, "Rental", rentalId, "CANCELLED");
  return updated;
}
