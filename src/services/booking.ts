import {
  BookingStatus,
  BoardStatus,
  PaymentProofKind,
  PaymentProofStatus,
} from "@prisma/client";
import { prisma } from "../db/prisma";
import * as audit from "./audit";

export async function createBooking(params: {
  userId: number;
  spotId: number;
  boardId: number;
  tariffId: number;
  startAt: Date;
}) {
  const tariff = await prisma.tariff.findUniqueOrThrow({
    where: { id: params.tariffId },
  });

  const board = await prisma.board.findUniqueOrThrow({
    where: { id: params.boardId },
  });

  if (board.status !== BoardStatus.AVAILABLE) {
    throw new Error("Доска недоступна для бронирования");
  }

  const endAt = new Date(
    params.startAt.getTime() + tariff.durationMinutes * 60_000
  );

  const booking = await prisma.booking.create({
    data: {
      userId: params.userId,
      spotId: params.spotId,
      boardId: params.boardId,
      tariffId: params.tariffId,
      startAt: params.startAt,
      endAt,
      status: BookingStatus.WAIT_ADMIN,
    },
  });

  // Mark board as BOOKED
  await prisma.board.update({
    where: { id: params.boardId },
    data: { status: BoardStatus.BOOKED },
  });

  await audit.log(params.userId, "Booking", booking.id, "CREATED", {
    tariffId: tariff.id,
    price: tariff.price,
    boardId: params.boardId,
  });

  return { booking, tariff };
}

export async function submitBookingPayment(params: {
  bookingId: number;
  userId: number;
  amount: number;
  fileId?: string;
  text?: string;
}) {
  const existing = await prisma.paymentProof.findFirst({
    where: {
      kind: PaymentProofKind.BOOKING,
      refId: params.bookingId,
      status: { in: [PaymentProofStatus.SUBMITTED, PaymentProofStatus.APPROVED] },
    },
  });
  if (existing) return { proof: existing, duplicate: true };

  const proof = await prisma.paymentProof.create({
    data: {
      kind: PaymentProofKind.BOOKING,
      refId: params.bookingId,
      amount: params.amount,
      fileId: params.fileId,
      text: params.text,
      userId: params.userId,
    },
  });

  await prisma.booking.update({
    where: { id: params.bookingId },
    data: { status: BookingStatus.WAIT_ADMIN },
  });

  await audit.log(params.userId, "PaymentProof", proof.id, "SUBMITTED", {
    bookingId: params.bookingId,
    amount: params.amount,
  });

  return { proof, duplicate: false };
}

export async function approveBooking(bookingId: number, adminUserId: number) {
  const booking = await prisma.booking.update({
    where: { id: bookingId },
    data: { status: BookingStatus.CONFIRMED },
  });
  await audit.log(adminUserId, "Booking", bookingId, "CONFIRMED");
  return booking;
}

export async function cancelBooking(bookingId: number, userId: number) {
  const booking = await prisma.booking.update({
    where: { id: bookingId },
    data: { status: BookingStatus.CANCELLED },
  });

  // Release board back to AVAILABLE
  if (booking.boardId) {
    await prisma.board.update({
      where: { id: booking.boardId },
      data: { status: BoardStatus.AVAILABLE },
    });
  }

  await audit.log(userId, "Booking", bookingId, "CANCELLED");
  return booking;
}
