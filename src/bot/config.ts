/**
 * Конфигурация приложения из переменных окружения.
 *
 * Обязательные: BOT_TOKEN, DATABASE_URL.
 * Опциональные: ADMIN_TG_IDS, CASHIER_TG_IDS, MBANK_QR_FILE_ID, LOG_LEVEL, TIMEZONE.
 *
 * @module
 */
import "dotenv/config";

/** Получить обязательную переменную окружения или выбросить ошибку */
function required(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required env variable: ${key}`);
  }
  return val;
}

export const config = {
  BOT_TOKEN: required("BOT_TOKEN"),
  DATABASE_URL: required("DATABASE_URL"),
  /** Comma-separated list of admin Telegram IDs. Falls back to single ADMIN_TG_ID for compatibility. */
  ADMIN_TG_IDS: (process.env.ADMIN_TG_IDS ?? process.env.ADMIN_TG_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => {
      if (!/^\d+$/.test(s)) {
        console.error(`[config] Некорректный ADMIN_TG_ID: "${s}" — ожидается числовой Telegram ID`);
        return false;
      }
      return true;
    }),
  /** Comma-separated list of cashier Telegram IDs (optional). */
  CASHIER_TG_IDS: (process.env.CASHIER_TG_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => {
      if (!/^\d+$/.test(s)) {
        console.error(`[config] Некорректный CASHIER_TG_ID: "${s}" — ожидается числовой Telegram ID`);
        return false;
      }
      return true;
    }),
  MBANK_QR_FILE_ID: process.env.MBANK_QR_FILE_ID ?? "",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  TIMEZONE: process.env.TIMEZONE ?? "Asia/Bishkek",
};
