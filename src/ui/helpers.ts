import { InlineKeyboard } from "grammy";
import { config } from "../bot/config";

export const PAGE_SIZE = 5;

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  totalPages: number;
  total: number;
}

export function paginate<T>(all: T[], page: number, pageSize: number = PAGE_SIZE): PaginatedResult<T> {
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * pageSize;
  return {
    items: all.slice(start, start + pageSize),
    page: safePage,
    totalPages,
    total,
  };
}

/**
 * Add pagination row to an existing keyboard.
 * callbackPrefix must end with `:` — page number is appended.
 */
export function addPaginationRow(
  kb: InlineKeyboard,
  page: number,
  totalPages: number,
  callbackPrefix: string
): InlineKeyboard {
  if (totalPages <= 1) return kb;

  const row: Parameters<InlineKeyboard["text"]>[] = [];
  if (page > 1) {
    row.push([`⬅️`, `${callbackPrefix}${page - 1}`]);
  }
  row.push([`${page}/${totalPages}`, `noop`]);
  if (page < totalPages) {
    row.push([`➡️`, `${callbackPrefix}${page + 1}`]);
  }

  kb.row();
  for (const [text, data] of row) {
    kb.text(text, data);
  }
  return kb;
}

/** Format price in KGS (сом) */
export function fmtPrice(amount: number): string {
  return `${amount} сом`;
}

/** Escape HTML special characters to prevent injection in Telegram HTML messages */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Truncate message to stay within Telegram's 4096 character limit */
export function truncateMessage(text: string, limit = 4000): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n\n… <i>сообщение обрезано</i>";
}

/** Format duration */
export function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} мин`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h} ч ${m} мин` : `${h} ч`;
}

/** Format date (Bishkek timezone) */
export function fmtDate(d: Date): string {
  return d.toLocaleString("ru-RU", {
    timeZone: config.TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

