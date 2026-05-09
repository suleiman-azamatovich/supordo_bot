import { InlineKeyboard } from "grammy";
import { Role } from "@prisma/client";

/**
 * Главное меню бота.
 *
 * Кнопки зависят от роли пользователя:
 * - CLIENT: доски, мои аренды, история, уведомления, помощь
 * - CASHIER: уведомления, доски, касса, walk-in, история оплат
 * - ADMIN: уведомления, доски, касса, история транзакций, отчёты, тарифы
 *
 * Кассир имеет доступ к операционным функциям (выдача/приём досок, оплаты,
 * walk-in, продления) — но не к стратегическим (отчёты, тарифы, роли).
 */
export function mainMenuKeyboard(role: Role): InlineKeyboard {
  const kb = new InlineKeyboard();

  if (role === Role.CLIENT) {
    kb.text("🏄 Арендовать доску", "client:boards").row();
    kb.text("📋 Мои аренды", "client:my_list").text("📜 История операций", "client:my_history").row();
    kb.text("🔔 Уведомления", "client:notifications").text("❓ Помощь", "client:help").row();
  }

  if (role === Role.CASHIER) {
    kb.text("🔔 Уведомления", "cashier:notifications").text("🏄 Доски", "admin:boards").row();
    kb.text("💳 Касса", "cashier:payments").row();
    kb.text("➕ Выдать доску (walk-in)", "seller:walkin").row();
    kb.text("🕒 История оплат", "cashier:history").row();
  }

  if (role === Role.ADMIN) {
    kb.text("🔔 Уведомления", "admin:notifications").text("🏄 Доски", "admin:boards").row();
    kb.text("💳 Касса", "admin:cashbox").row();
    kb.text("➕ Выдать доску (walk-in)", "seller:walkin").row();
    kb.text("🕒 История транзакций", "admin:transactions").row();
    kb.text("📊 Отчёты", "admin:reports").text("🏷️ Тарифы", "admin:tariffs").row();
  }

  kb.text("🧹 Убрать лишнее", "clear:chat").row();

  return kb;
}
