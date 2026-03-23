import { Bot, session } from "grammy";
import { conversations } from "@grammyjs/conversations";
import { BotContext, SessionData } from "./bot/context";
import { config } from "./bot/config";
import { authMiddleware, chatCleanupMiddleware } from "./bot/middleware";
import { clientModule } from "./modules/client";
import { sellerModule } from "./modules/seller";
import { adminModule } from "./modules/admin";
import { startExpiryChecker } from "./services/expiry";

async function main() {
  const bot = new Bot<BotContext>(config.BOT_TOKEN);

  // Session
  bot.use(
    session({
      initial: (): SessionData => ({}),
    })
  );

  // Conversations plugin
  bot.use(conversations());

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

  await bot.start({
    onStart: (info) => console.log(`✅ Bot @${info.username} started`),
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
