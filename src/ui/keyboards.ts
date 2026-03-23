import { InlineKeyboard } from "grammy";
import { Role } from "@prisma/client";

export function mainMenuKeyboard(role: Role): InlineKeyboard {
  const kb = new InlineKeyboard();

  if (role === Role.CLIENT) {
    kb.text("🏄 Доски", "client:boards").row();
    kb.text("📋 Мои аренды", "client:my_list").text("🔔 Уведомления", "client:notifications").row();
    kb.text("❓ Помощь", "client:help").row();
  }

  if (role === Role.SELLER) {
    kb.text("➕ Оформить аренду", "seller:walkin").row();

    kb.text("🏄 В аренде", "seller:rented").row();
    kb.text("🔄 Возвраты", "seller:returns").row();
    kb.text("📊 История за день", "seller:today").row();
  }

  if (role === Role.ADMIN) {
    kb.text("🔔 Уведомления", "admin:notifications").text("🏄 Доски", "admin:boards").row();
    kb.text("📊 Панель управления", "admin:dashboard").row();
    kb.text("➕ Выдать доску клиенту", "seller:walkin").row();
    kb.text("📊 Отчёты", "admin:reports").row();
  }

  return kb;
}
