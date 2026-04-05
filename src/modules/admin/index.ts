/**
 * Админский модуль — точка сборки.
 *
 * Объединяет все административные подмодули в один Composer.
 * Защищён guardRole(Role.ADMIN) — все хендлеры внутри доступны только админам.
 *
 * Подмодули:
 *  - dashboard — панель управления, уведомления, переключение тест/работа
 *  - payments — одобрение/отклонение оплат
 *  - returns — возвраты и принятие досок (включая бывший seller.ts)
 *  - boards — управление досками (блок/разблок, детали)
 *  - reports — отчёты (сегодня, неделя, тарифы, история)
 *  - extensions — продления аренды и закрытие просрочки
 *  - chat — переписка админ ↔ клиент
 *  - walkin — выдача доски клиенту на месте (walk-in)
 *  - roles — управление ролями (/add_admin, /remove_admin, MBank QR)
 *
 * Порядок регистрации важен для message:text / message:photo хендлеров:
 *  1. Сначала callback-хендлеры (dashboard, payments, returns, boards, reports, extensions)
 *  2. Затем chat.ts (текстовый хендлер для пересылки, вызывает next() если не в чате)
 *  3. Затем walkin.ts (текстовый хендлер для имени клиента, вызывает next())
 *  4. Последним roles.ts (фото-хендлер для MBank QR + команды)
 */

import { Composer } from "grammy";
import { BotContext } from "../../bot/context";
import { guardRole } from "../../bot/middleware";
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

export const adminModule = new Composer<BotContext>();

// Все хендлеры внутри требуют роль ADMIN
adminModule.use(guardRole(Role.ADMIN));

// Callback-хендлеры (порядок не критичен — каждый слушает свой паттерн)
adminModule.use(dashboardHandlers);
adminModule.use(paymentsHandlers);
adminModule.use(returnsHandlers);
adminModule.use(boardsHandlers);
adminModule.use(reportsHandlers);
adminModule.use(extensionsHandlers);

// Хендлеры сообщений (порядок КРИТИЧЕН — chat → walkin → roles)
adminModule.use(chatHandlers);       // message:text: пересылка в чате, иначе next()
adminModule.use(walkinHandlers);     // message:text: имя клиента для walk-in, иначе next()
adminModule.use(rolesHandlers);      // message:photo: MBank QR, иначе next() + команды
