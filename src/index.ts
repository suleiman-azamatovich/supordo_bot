import { Bot, session } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { BotContext, SessionData } from "./bot/context";
import { config } from "./bot/config";
import { authMiddleware, chatCleanupMiddleware } from "./bot/middleware";
import { clientModule } from "./modules/client";
import { sellerModule } from "./modules/seller";
import { adminModule } from "./modules/admin";
import { startExpiryChecker } from "./services/expiry";
import { prisma } from "./db/prisma";

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

  // Auto-cleanup old messages
  bot.use(chatCleanupMiddleware);

  // Error handler
  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  // Register modules
  bot.use(clientModule);
  bot.use(sellerModule);
  bot.use(adminModule);

  // Set bot commands
  await bot.api.setMyCommands([
    { command: "start", description: "Начать / Deep link" },
    { command: "menu", description: "Главное меню" },
  ]);

  console.log("🚀 Bot starting...");
  // Запуск автоматического завершения истёкших аренд
  startExpiryChecker(bot.api);

  // Run with concurrent update processing
  const runner = run(bot);
  console.log("✅ Bot started (runner mode)");

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received — shutting down...`);
    runner.isRunning() && runner.stop();
    await prisma.$disconnect();
    console.log("👋 Graceful shutdown complete.");
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
