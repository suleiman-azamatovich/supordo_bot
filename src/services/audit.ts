import { prisma } from "../db/prisma";

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
