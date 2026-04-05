/**
 * Singleton-экземпляр PrismaClient.
 *
 * Использовать через импорт: `import { prisma } from '../db/prisma'`
 */
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
