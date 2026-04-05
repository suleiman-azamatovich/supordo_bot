/**
 * Сервис аудита — логирование всех мутаций данных.
 *
 * Каждое изменение в Rental, PaymentProof, Board, User должно
 * сопровождаться вызовом `audit.log()`.
 *
 * @module
 */
import { prisma } from "../db/prisma";

/**
 * Записать событие в журнал аудита.
 *
 * @param actorUserId - ID пользователя, выполнившего действие
 * @param entityType - Тип сущности (напр.: 'Rental', 'PaymentProof', 'Board')
 * @param entityId - ID сущности
 * @param action - Действие (напр.: 'CREATED', 'APPROVED', 'CANCELLED')
 * @param meta - Дополнительные данные (сохраняются как JSON)
 */
export async function log(
  actorUserId: number,
  entityType: string,
  entityId: number,
  action: string,
  meta?: Record<string, unknown>
) {
  await prisma.auditLog.create({
    data: {
      actorUserId,
      entityType,
      entityId,
      action,
      metaJson: meta ? (meta as any) : undefined,
    },
  });
}
