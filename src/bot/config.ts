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
  ADMIN_TG_ID: required("ADMIN_TG_ID"),
  MBANK_QR_FILE_ID: process.env.MBANK_QR_FILE_ID ?? "",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
};
