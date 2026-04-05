/**
 * Клиентский модуль — точка сборки.
 *
 * Объединяет все клиентские подмодули в один Composer:
 *  - start — навигация, /start, /menu, очистка чата
 *  - boards — просмотр досок
 *  - rental — поток аренды (выбор тарифа → оплата)
 *  - my-rentals — список аренд, продление, просрочка
 *  - chat — переписка с админом
 *  - notifications — уведомления и помощь
 *
 * Порядок регистрации важен:
 *  - callback-хендлеры идут первыми (start, boards, rental, my-rentals)
 *  - обработчики сообщений (photo, text) идут последними,
 *    потому что они перехватывают все входящие сообщения
 *
 * Клиентский модуль не имеет guard по роли — он обслуживает
 * ВСЕХ пользователей (CLIENT и ADMIN пользуются общим меню).
 */

import { Composer } from "grammy";
import { BotContext } from "../../bot/context";
import { startHandlers } from "./start";
import { boardsHandlers } from "./boards";
import { rentalHandlers } from "./rental";
import { myRentalsHandlers } from "./my-rentals";
import { chatHandlers } from "./chat";
import { notificationsHandlers } from "./notifications";

export const clientModule = new Composer<BotContext>();

clientModule.use(startHandlers);
clientModule.use(boardsHandlers);
clientModule.use(rentalHandlers);      // включает message:photo
clientModule.use(myRentalsHandlers);
clientModule.use(chatHandlers);        // включает message:text
clientModule.use(notificationsHandlers); // включает noop
