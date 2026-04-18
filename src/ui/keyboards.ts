import { InlineKeyboard } from "grammy";
import { Role } from "@prisma/client";

/**
 * Главное меню бота.
 *
 * Кнопки зависят от роли пользователя:
 * - CLIENT: доски, мои аренды, уведомления, помощь
 * - ADMIN: уведомления, доски, проверка оплат, история транзакций, отчёты, переключение режима
 * - CASHIER: проверка оплат, уведомления
 *
 */
export function mainMenuKeyboard(role: Role): InlineKeyboard {
  const kb = new InlineKeyboard();

  if (role === Role.CLIENT) {
    kb.text("🏄 Арендовать доску", "client:boards").row();
    kb.text("📋 Мои аренды", "client:my_list").text("📜 История операций", "client:my_history").row();
    kb.text("🔔 Уведомления", "client:notifications").text("❓ Помощь", "client:help").row();
  }

  if (role === Role.CASHIER) {
    kb.text("✅ Проверка оплат", "cashier:payments").row();
    kb.text("🔔 Уведомления", "cashier:notifications").row();
  }

  if (role === Role.ADMIN) {
    kb.text("🔔 Уведомления", "admin:notifications").text("🏄 Доски", "admin:boards").row();
    kb.text("✅ Проверка оплат", "admin:cashbox").row();
    kb.text("📜 История транзакций", "admin:transactions").row();
    kb.text("📊 Отчёты", "admin:reports").row();
    kb.text("💰 Тарифы", "admin:tariffs").row();
    kb.text("⚙️ Режим", "admin:mode").row();
  }

  kb.text("🧹 Убрать лишнее", "clear:chat").row();

  return kb;
}
