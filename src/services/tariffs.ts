/**
 * Сервис управления тарифами — CRUD для администратора.
 *
 * Бизнес-правила:
 *  - Тарифы привязаны к точке (Spot).
 *  - Удаление тарифа, на который уже ссылаются аренды, выполняется мягко
 *    (soft delete: `isActive = false`) — чтобы не потерять историю цен.
 *  - Физическое удаление возможно только для тарифов без связанных аренд.
 *  - При переключении ТЕСТ ↔ РАБОТА (dashboard.ts) тарифы перезаписываются —
 *    этот сервис не трогает этот механизм.
 */

import { AuditAction, Tariff } from "@prisma/client";
import { prisma } from "../db/prisma";
import * as audit from "./audit";
import { clearTestModeCache } from "./rental";

/** Параметры создания тарифа */
export interface CreateTariffInput {
  spotId: number;
  name: string;
  durationMinutes: number;
  price: number;
  sortOrder?: number;
}

/** Частичное обновление тарифа */
export interface UpdateTariffInput {
  name?: string;
  durationMinutes?: number;
  price?: number;
  sortOrder?: number;
  isActive?: boolean;
}

/** Валидация входных параметров тарифа (бросает ошибку с понятным сообщением) */
function validate(input: Partial<CreateTariffInput>): void {
  if (input.name !== undefined) {
    const n = input.name.trim();
    if (n.length === 0 || n.length > 50) {
      throw new Error("Название тарифа должно быть от 1 до 50 символов");
    }
  }
  if (input.durationMinutes !== undefined) {
    if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 24 * 60) {
      throw new Error("Длительность должна быть целым числом от 1 до 1440 минут");
    }
  }
  if (input.price !== undefined) {
    if (!Number.isInteger(input.price) || input.price < 0 || input.price > 1_000_000) {
      throw new Error("Цена должна быть целым числом от 0 до 1 000 000 сом");
    }
  }
}

/** Список тарифов точки (с опциональным фильтром по активности) */
export async function listTariffs(spotId: number, onlyActive = false): Promise<Tariff[]> {
  return prisma.tariff.findMany({
    where: { spotId, ...(onlyActive ? { isActive: true } : {}) },
    orderBy: [{ sortOrder: "asc" }, { durationMinutes: "asc" }],
  });
}

/** Создать новый тариф */
export async function createTariff(input: CreateTariffInput, actorUserId: number): Promise<Tariff> {
  validate(input);
  const t = await prisma.tariff.create({
    data: {
      spotId: input.spotId,
      name: input.name.trim(),
      durationMinutes: input.durationMinutes,
      price: input.price,
      sortOrder: input.sortOrder ?? 0,
      isActive: true,
    },
  });
  clearTestModeCache();
  await audit.log(actorUserId, "Tariff", t.id, AuditAction.TARIFF_CREATED, {
    name: t.name,
    durationMinutes: t.durationMinutes,
    price: t.price,
  });
  return t;
}

/** Обновить существующий тариф */
export async function updateTariff(id: number, patch: UpdateTariffInput, actorUserId: number): Promise<Tariff> {
  validate(patch);
  const before = await prisma.tariff.findUniqueOrThrow({ where: { id } });
  const t = await prisma.tariff.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.durationMinutes !== undefined ? { durationMinutes: patch.durationMinutes } : {}),
      ...(patch.price !== undefined ? { price: patch.price } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
      ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
    },
  });
  clearTestModeCache();
  await audit.log(actorUserId, "Tariff", id, AuditAction.TARIFF_UPDATED, {
    before: { name: before.name, durationMinutes: before.durationMinutes, price: before.price, isActive: before.isActive },
    after: { name: t.name, durationMinutes: t.durationMinutes, price: t.price, isActive: t.isActive },
  });
  return t;
}

/**
 * Удалить тариф.
 * Если есть связанные аренды — делает soft delete (isActive=false).
 *
 * @returns `hard` — физическое удаление, `soft` — деактивация.
 */
export async function deleteTariff(id: number, actorUserId: number): Promise<"hard" | "soft"> {
  const relatedCount = await prisma.rental.count({ where: { tariffId: id } });
  if (relatedCount > 0) {
    await prisma.tariff.update({ where: { id }, data: { isActive: false } });
    clearTestModeCache();
    await audit.log(actorUserId, "Tariff", id, AuditAction.TARIFF_DELETED, { mode: "soft", relatedRentals: relatedCount });
    return "soft";
  }
  await prisma.tariff.delete({ where: { id } });
  clearTestModeCache();
  await audit.log(actorUserId, "Tariff", id, AuditAction.TARIFF_DELETED, { mode: "hard" });
  return "hard";
}
