/**
 * Генерация QR-кодов для всех досок.
 * Запуск: npx tsx scripts/generate-qr.ts
 *
 * Результат: папка qr-codes/ с файлами SUP-01.png … SUP-20.png
 * Каждый QR ведёт на deep link: https://t.me/subordo_bot?start=board_SUP-XX
 */

import "dotenv/config";
import QRCode from "qrcode";
import { mkdirSync, existsSync } from "fs";
import path from "path";

const BOT_USERNAME = "subordo_bot";
const BOARD_COUNT = 20;
const OUT_DIR = path.resolve(__dirname, "..", "qr-codes");

async function main() {
  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }

  for (let i = 1; i <= BOARD_COUNT; i++) {
    const code = `SUP-${String(i).padStart(2, "0")}`;
    const deepLink = `https://t.me/${BOT_USERNAME}?start=board_${code}`;
    const filePath = path.join(OUT_DIR, `${code}.png`);

    await QRCode.toFile(filePath, deepLink, {
      width: 512,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });

    console.log(`✅ ${code} -> ${filePath}`);
  }

  console.log(`\nГотово! ${BOARD_COUNT} QR-кодов в папке: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
