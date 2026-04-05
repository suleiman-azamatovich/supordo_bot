import { InlineKeyboard } from "grammy";
import { Role } from "@prisma/client";

/**
 * Главное меню бота.
 *
 * Кнопки зависят от роли пользователя:
 * - CLIENT: доски, мои аренды, уведомления, помощь
 * - ADMIN: уведомления, доски, панель управления, выдача доски, отчёты
 */
export function mainMenuKeyboard(role: Role): InlineKeyboard {
  const kb = new InlineKeyboard();

  if (role === Role.CLIENT) {
    kb.text("🏄 Доски", "client:boards").row();
    kb.text("📋 Мои аренды", "client:my_list").text("🔔 Уведомления", "client:notifications").row();
    kb.text("❓ Помощь", "client:help").row();
  }

  if (role === Role.ADMIN) {
    kb.text("🔔 Уведомления", "admin:notifications").text("🏄 Доски", "admin:boards").row();
    kb.text("📊 Панель управления", "admin:dashboard").row();
    kb.text("➕ Выдать доску клиенту", "seller:walkin").row();
    kb.text("📊 Отчёты", "admin:reports").row();
  }

  kb.text("🗑 Очистить чат", "clear:chat").row();

  return kb;
}
