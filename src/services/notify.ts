import { Api, InlineKeyboard, InputFile } from "grammy";
import path from "path";
import fs from "fs";
import { prisma } from "../db/prisma";
import { fmtPrice } from "../ui/helpers";

const MBANK_QR_PATH = path.join(__dirname, "..", "..", "qr-bank", "IMG-20260406-WA0012.jpg");

/**
 * Отправить уведомление:
 * 1. Сохранить в БД (чтоб пользователь мог посмотреть в разделе «Уведомления»)
 * 2. Отправить сообщение в чат (остаётся пока пользователь сам не удалит)
 */
export async function notify(
  api: Api,
  tgId: bigint | number,
  text: string,
  opts?: { parseMode?: "HTML" }
) {
  const chatId = Number(tgId);

  // Сохраняем в БД
  try {
    const user = await prisma.user.findUnique({ where: { tgId: BigInt(chatId) } });
    if (user) {
      await prisma.notification.create({
        data: { userId: user.id, text: stripHtml(text) },
      });
    }
  } catch (e) {
    console.error('[notify] Ошибка сохранения уведомления:', e);
  }

  // Отправляем сообщение в чат
  try {
    await api.sendMessage(chatId, text, {
      parse_mode: opts?.parseMode ?? "HTML",
    });
  } catch (e) {
    console.error(`[notify] Failed to send to ${chatId}:`, e);
  }
}

/** Send MBank QR code to a specific chat */
export async function sendMBankQRToChat(
  api: Api,
  chatId: number | bigint,
  amount: number,
  rentalId?: number
) {
  const caption =
    `💳 <b>Оплата: ${fmtPrice(amount)}</b>\n\n` +
    `📱 Отсканируйте QR-код через <b>любой мобильный банкинг</b> (MBank, O!, Бакай и др.)\n` +
    `💵 Или оплатите <b>наличными</b> на точке проката.\n\n` +
    `После оплаты нажмите <b>«✅ Я оплатил»</b>.`;

  const kb = rentalId
    ? new InlineKeyboard()
      .text("✅ Я оплатил", `rent:paid:${rentalId}`)
      .row()
      .text("⬅️ Меню", "back:menu")
    : undefined;

  try {
    if (!fs.existsSync(MBANK_QR_PATH)) {
      await api.sendMessage(Number(chatId), caption, { parse_mode: "HTML", reply_markup: kb });
      return;
    }
    await api.sendPhoto(Number(chatId), new InputFile(MBANK_QR_PATH), {
      caption,
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } catch (e) {
    console.error("Failed to send MBank QR:", e);
  }
}

/** Strip HTML tags for DB storage */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/** Get notifications for user (last 24h) */
/** Получить уведомления пользователя за последние 24ч */
export async function getNotifications(userId: number) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return prisma.notification.findMany({
    where: { userId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

/** Clear old notifications (>24h) */
export async function clearOldNotifications() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await prisma.notification.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
}
