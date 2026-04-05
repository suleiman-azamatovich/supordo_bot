import { Api, InputFile } from "grammy";
import path from "path";
import fs from "fs";
import { prisma } from "../db/prisma";
import { fmtPrice } from "../ui/helpers";

const MBANK_QR_PATH = path.join(__dirname, "..", "..", "qr-bank", "mbank_qr.jpeg");

const AUTO_DELETE_MS = 60_000; // удалять сообщение из чата через 60 сек

/**
 * Отправить уведомление:
 * 1. Сохранить в БД (чтоб пользователь мог посмотреть потом)
 * 2. Отправить сообщение в чат
 * 3. Удалить через 60 сек чтоб не захламлять
 */
export async function notify(
  api: Api,
  tgId: bigint | number,
  text: string,
  opts?: { parseMode?: "HTML"; deleteAfterMs?: number }
) {
  const chatId = Number(tgId);
  const deleteMs = opts?.deleteAfterMs ?? AUTO_DELETE_MS;

  // Save to DB (fire-and-forget, don't block send)
  prisma.user.findUnique({ where: { tgId: BigInt(chatId) } }).then((user) => {
    if (user) {
      prisma.notification.create({
        data: { userId: user.id, text: stripHtml(text) },
      }).catch((e) => console.error('[notify] Ошибка сохранения уведомления:', e));
    }
  }).catch((e) => console.error('[notify] Ошибка поиска пользователя:', e));

  // Send message
  try {
    const msg = await api.sendMessage(chatId, text, {
      parse_mode: opts?.parseMode ?? "HTML",
    });

    // Auto-delete from chat
    if (deleteMs > 0) {
      setTimeout(async () => {
        try {
          await api.deleteMessage(chatId, msg.message_id);
        } catch { /* already deleted or can't delete */ }
      }, deleteMs);
    }
  } catch (e) {
    console.error(`[notify] Failed to send to ${chatId}:`, e);
  }
}

/** Send MBank QR code to a specific chat */
export async function sendMBankQRToChat(
  api: Api,
  chatId: number | bigint,
  amount: number
) {
  const caption =
    `💳 <b>Оплата через MBank</b>\n\n` +
    `Отсканируйте QR-код в приложении MBank и переведите <b>${fmtPrice(amount)}</b>.\n` +
    `После перевода администратор подтвердит оплату.`;
  try {
    if (!fs.existsSync(MBANK_QR_PATH)) {
      await api.sendMessage(Number(chatId), caption, { parse_mode: "HTML" });
      return;
    }
    await api.sendPhoto(Number(chatId), new InputFile(MBANK_QR_PATH), {
      caption,
      parse_mode: "HTML",
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
export async function getNotifications(userId: number) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return prisma.notification.findMany({
    where: { userId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}

/** Clear old notifications (>24h) */
export async function clearOldNotifications() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await prisma.notification.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
}
