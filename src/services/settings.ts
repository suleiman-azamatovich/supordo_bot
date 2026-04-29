/**
 * Глобальные настройки бота — хранятся в таблице Setting (key-value).
 *
 * Значения кешируются в памяти для быстрого доступа.
 * Запись в БД сбрасывает кеш мгновенно.
 */

import { prisma } from "../db/prisma";

// ── Overdue rate ──────────────────────────────────────────────

const OVERDUE_RATE_KEY = "overdue_rate_per_min";
const DEFAULT_OVERDUE_RATE = 15;

let cachedOverdueRate: number | null = null;

/** Получить текущую ставку просрочки (сом/мин). Кешируется в памяти. */
export async function getOverdueRate(): Promise<number> {
  if (cachedOverdueRate !== null) return cachedOverdueRate;
  const setting = await prisma.setting.findUnique({ where: { key: OVERDUE_RATE_KEY } });
  cachedOverdueRate = setting ? parseInt(setting.value, 10) : DEFAULT_OVERDUE_RATE;
  return cachedOverdueRate;
}

/** Установить ставку просрочки (сом/мин). Сохраняет в БД и обновляет кеш. */
export async function setOverdueRate(value: number): Promise<void> {
  const clamped = Math.max(1, Math.min(1000, Math.round(value)));
  await prisma.setting.upsert({
    where: { key: OVERDUE_RATE_KEY },
    update: { value: String(clamped) },
    create: { key: OVERDUE_RATE_KEY, value: String(clamped) },
  });
  cachedOverdueRate = clamped;
}
