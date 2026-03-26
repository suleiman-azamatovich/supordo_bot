import "dotenv/config";

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
    .filter(Boolean),
  MBANK_QR_FILE_ID: process.env.MBANK_QR_FILE_ID ?? "",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
};
