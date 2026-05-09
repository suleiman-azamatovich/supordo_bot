/**
 * Админский модуль — точка сборки.
 *
 * Внутри две группы сабмодулей с разными правами:
 *
 *  • staffComposer (ADMIN + CASHIER) — операционные функции:
 *      boards, walkin, returns, extensions, chat, roles
 *      (roles содержит admin-only команды, но они проверяют роль внутри;
 *      composer допускается до message:photo для MBank QR).
 *
 *  • adminOnlyComposer (ADMIN) — стратегические функции:
 *      dashboard, payments (старый список), reports, tariffs.
 *      Здесь висит мягкий guardCallbackRole — он блокирует только
 *      callback-кнопки чужой роли, но пропускает message:* через next().
 *
 * Порядок message:text/photo:
 *   chat (staff) → walkin (staff) → roles (staff, photo).
 * Каждый message-хендлер вызывает next(), если состояние не его.
 */

import { Composer } from "grammy";
import { BotContext } from "../../bot/context";
import { guardRole, guardCallbackRole } from "../../bot/middleware";
import { Role } from "@prisma/client";
import { dashboardHandlers } from "./dashboard";
import { paymentsHandlers } from "./payments";
import { returnsHandlers } from "./returns";
import { boardsHandlers } from "./boards";
import { reportsHandlers } from "./reports";
import { extensionsHandlers } from "./extensions";
import { chatHandlers } from "./chat";
import { walkinHandlers } from "./walkin";
import { rolesHandlers } from "./roles";
import { tariffsHandlers } from "./tariffs";

export const adminModule = new Composer<BotContext>();

/* ────────────────── Staff (ADMIN + CASHIER) ────────────────── */
const staffComposer = new Composer<BotContext>();
staffComposer.use(guardRole(Role.ADMIN, Role.CASHIER));

// Callback-хендлеры
staffComposer.use(boardsHandlers);
staffComposer.use(returnsHandlers);
staffComposer.use(extensionsHandlers);

// Message-хендлеры (порядок: chat → walkin → roles)
staffComposer.use(chatHandlers);     // message:text: пересылка в чате, иначе next()
staffComposer.use(walkinHandlers);   // callbacks + message:text для имени клиента
staffComposer.use(rolesHandlers);    // команды (внутри проверяют ADMIN) + message:photo (MBank QR)

adminModule.use(staffComposer);

/* ───────────────────── Admin-only ──────────────────────────── */
const adminOnlyComposer = new Composer<BotContext>();
// Мягкий guard: блокирует только admin-only callbacks от не-админов
adminOnlyComposer.use(guardCallbackRole(Role.ADMIN));

adminOnlyComposer.use(dashboardHandlers);
adminOnlyComposer.use(paymentsHandlers);
adminOnlyComposer.use(reportsHandlers);
adminOnlyComposer.use(tariffsHandlers);

adminModule.use(adminOnlyComposer);
