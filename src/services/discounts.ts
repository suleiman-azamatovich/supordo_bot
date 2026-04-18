/**
 * Сервис управления персональными скидками клиентов.
 *
 * Скидка задаётся в процентах (0..100) и хранится в `User.discountPercent`.
 * При создании новой аренды процент копируется в `Rental.discountPercent`
 * (snapshot), чтобы последующее изменение скидки клиента не затронуло
 * уже созданные аренды.
 *
 * Правила:
 *  - 0% = нет скидки (снимает пометку).
 *  - Скидку может устанавливать только администратор.
 *  - Все изменения логируются в AuditLog (action=DISCOUNT_SET).
 */

import { AuditAction, User } from "@prisma/client";
import { prisma } from "../db/prisma";
import * as audit from "./audit";
import { normalizePercent } from "./pricing";

/**
 * Установить скидку клиенту.
 *
 * @param targetUserId — id клиента (из БД, не tgId)
 * @param percent — процент скидки (0..100); 0 = снять скидку
 * @param note — опциональный комментарий (причина)
 * @param actorUserId — id администратора, выполняющего действие
 */
export async function setUserDiscount(
  targetUserId: number,
  percent: number,
  note: string | null,
  actorUserId: number,
): Promise<User> {
  const normalized = normalizePercent(percent);
  const before = await prisma.user.findUniqueOrThrow({ where: { id: targetUserId } });

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: {
      discountPercent: normalized,
      // При сбросе скидки обнуляем и комментарий
      discountNote: normalized === 0 ? null : (note?.trim() || before.discountNote),
    },
  });

  await audit.log(actorUserId, "User", targetUserId, AuditAction.DISCOUNT_SET, {
    before: { percent: before.discountPercent, note: before.discountNote },
    after: { percent: updated.discountPercent, note: updated.discountNote },
  });

  return updated;
}

/**
 * Поиск клиентов по имени/телефону/tgId — для выбора в UI.
 * Возвращает не более `limit` записей.
 */
export async function searchClients(query: string, limit = 10): Promise<User[]> {
  const q = query.trim();
  if (q.length === 0) return [];

  // Если чисто цифровой ввод — ищем по tgId или phone
  const isNumeric = /^\d+$/.test(q);
  const where: any = isNumeric
    ? {
      OR: [
        { tgId: BigInt(q) },
        { phone: { contains: q } },
      ],
    }
    : {
      name: { contains: q, mode: "insensitive" },
    };

  return prisma.user.findMany({
    where: { ...where, role: "CLIENT" },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/**
 * Список клиентов с активной скидкой (для админ-обзора).
 */
export async function listDiscountedClients(): Promise<User[]> {
  return prisma.user.findMany({
    where: { discountPercent: { gt: 0 }, role: "CLIENT" },
    orderBy: [{ discountPercent: "desc" }, { name: "asc" }],
  });
}

/**
 * Последние клиенты (по createdAt) — для быстрого выбора в UI без поиска.
 */
export async function recentClients(limit = 10): Promise<User[]> {
  return prisma.user.findMany({
    where: { role: "CLIENT" },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
