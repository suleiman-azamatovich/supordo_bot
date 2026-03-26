/**
 * Генерация QR-кодов для всех досок.
 * Запуск: npx tsx scripts/generate-qr.ts
 *
 * Результат: папка qr-codes/ с файлами SUP-01.png … SUP-20.png
 * Каждый QR ведёт на deep link: https://t.me/<bot_username>?start=board_SUP-XX
 * Username бота определяется автоматически через BOT_TOKEN.
 */

import "dotenv/config";
import QRCode from "qrcode";
import { mkdirSync, existsSync } from "fs";
import path from "path";

const BOARD_COUNT = 20;
const OUT_DIR = path.resolve(__dirname, "..", "qr-codes");

async function getBotUsername(): Promise<string> {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN не задан в .env");

  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const data = await res.json() as { ok: boolean; result?: { username?: string } };
  if (!data.ok || !data.result?.username) {
    throw new Error("Не удалось получить username бота. Проверьте BOT_TOKEN.");
  }
  return data.result.username;
}

async function main() {
  const botUsername = await getBotUsername();
  console.log(`🤖 Бот: @${botUsername}\n`);

  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }

  for (let i = 1; i <= BOARD_COUNT; i++) {
    const code = `SUP-${String(i).padStart(2, "0")}`;
    const deepLink = `https://t.me/${botUsername}?start=board_${code}`;
    const filePath = path.join(OUT_DIR, `${code}.png`);

    await QRCode.toFile(filePath, deepLink, {
      width: 512,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });

    console.log(`✅ ${code} -> ${deepLink}`);
  }

  console.log(`\nГотово! ${BOARD_COUNT} QR-кодов в папке: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
