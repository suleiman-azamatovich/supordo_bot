/**
 * Точка входа Subordo Bot.
 *
 * Собирает middleware-цепочку, регистрирует модули
 * и запускает бот через @grammyjs/runner в concurrent-режиме.
 *
 * Порядок middleware:
 * sequentialize → session → authMiddleware → chatCleanup → clientModule → adminModule
 *
 * @module
 */
import { Bot, session, Composer } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { BotContext, SessionData } from "./bot/context";
import { config } from "./bot/config";
import { authMiddleware, chatCleanupMiddleware, guardRole, rateLimitMiddleware, startMiddlewareMaintenance } from "./bot/middleware";
import { clientModule } from "./modules/client/index";
import { adminModule } from "./modules/admin/index";
import { cashierModule } from "./modules/cashier/index";
import { paymentActionsHandlers } from "./modules/shared/payment-actions";
import { startExpiryChecker } from "./services/expiry";
import { startNotificationsCleanup } from "./services/notify";
import { prisma } from "./db/prisma";
import { Role } from "@prisma/client";

async function main() {
  const bot = new Bot<BotContext>(config.BOT_TOKEN);

  // Sequentialize per chat to keep session consistency
  bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));

  // Session
  bot.use(
    session({
      initial: (): SessionData => ({}),
    })
  );

  // Auth — populate dbUser on every update
  bot.use(authMiddleware);

  // Rate limiting for callback queries
  bot.use(rateLimitMiddleware);

  // Auto-cleanup old messages
  bot.use(chatCleanupMiddleware);

  // Error handler
  bot.catch((err) => {
    const desc = (err.error as { description?: string })?.description ?? "";
    if (typeof desc === "string") {
      // Просроченные callback-запросы (нажатые пока бот был выключен)
      if (desc.includes("query is too old")) return;
      // Повторное editMessageText с тем же содержимым (двойной клик, refresh без изменений)
      if (desc.includes("message is not modified")) return;
      // Сообщение удалено пользователем до edit
      if (desc.includes("message to edit not found")) return;
    }
    console.error("Bot error:", err);
  });

  // Register modules
  bot.use(clientModule);

  // Общие обработчики оплаты (доступны ADMIN и CASHIER)
  const paymentActionsGuarded = new Composer<BotContext>();
  paymentActionsGuarded.use(guardRole(Role.ADMIN, Role.CASHIER));
  paymentActionsGuarded.use(paymentActionsHandlers);
  bot.use(paymentActionsGuarded);

  bot.use(cashierModule);
  bot.use(adminModule);

  // Set bot commands
  await bot.api.setMyCommands([
    { command: "start", description: "Начать / Deep link" },
    { command: "menu", description: "Главное меню" },
  ]);

  console.log("🚀 Bot starting...");

  // Запуск автоматического завершения истёкших аренд
  const stopExpiryChecker = startExpiryChecker(bot.api);
  // Очистка устаревших уведомлений (раз в час, не в expiry tick)
  const stopNotificationsCleanup = startNotificationsCleanup();
  // Периодическая очистка in-memory кешей middleware (защита от утечек памяти)
  const stopMiddlewareMaintenance = startMiddlewareMaintenance();

  // Run with concurrent update processing.
  // silent: true — глушим многострочные стек-трейсы getUpdates (ECONNRESET и т.п.).
  // Runner всё равно сам ретраит. Liveness виден через [expiry] heartbeat.
  let runner = run(bot, { runner: { silent: true } });
  console.log("✅ Bot started (runner mode)");

  let shuttingDown = false;

  /** Авто-перезапуск runner при неожиданной остановке (сетевые сбои ECONNRESET и т.п.) */
  const watchRunner = () => {
    runner.task()?.then(() => {
      if (!shuttingDown) {
        console.error("[runner] Stopped unexpectedly, restarting in 5s...");
        setTimeout(() => { runner = run(bot); watchRunner(); }, 5000);
      }
    }).catch((err) => {
      if (!shuttingDown) {
        console.error("[runner] Crashed, restarting in 5s...", err);
        setTimeout(() => { runner = run(bot); watchRunner(); }, 5000);
      }
    });
  };
  watchRunner();

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — shutting down...`);
    try {
      if (runner.isRunning()) await runner.stop();
    } catch (e) {
      console.error("Runner stop error:", e);
    }
    stopExpiryChecker();
    stopNotificationsCleanup();
    stopMiddlewareMaintenance();
    try {
      await prisma.$disconnect();
    } catch (e) {
      console.error("Prisma disconnect error:", e);
    }
    console.log("👋 Graceful shutdown complete.");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Не допускаем молчаливых необработанных ошибок — логируем, чтобы не копить zombie-промисы
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
