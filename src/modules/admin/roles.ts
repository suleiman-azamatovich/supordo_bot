/**
 * Управление ролями и настройками (администратор).
 *
 * Обрабатывает:
 *  - /add_admin <TG_ID> [SPOT_ID] — назначение пользователя админом
 *  - /remove_admin <TG_ID> — снятие роли админа
 *  - /set_mbank_qr — установка QR-кода MBank (фото)
 *  - message:photo — получение фото QR-кода MBank
 *
 * Команды доступны только пользователям с ролью ADMIN.
 * Изменения ролей логируются в аудит.
 */

import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "../../bot/context";
import { prisma } from "../../db/prisma";
import { invalidateUserCache } from "../../bot/middleware";
import * as audit from "../../services/audit";
import { Role, AuditAction } from "@prisma/client";
import { config } from "../../bot/config";

export const rolesHandlers = new Composer<BotContext>();

/**
 * /add_admin <TG_ID> [SPOT_ID] — назначает пользователя администратором.
 *
 * Если пользователь не существует в БД, создаёт его.
 * При указании SPOT_ID привязывает к конкретной точке.
 */
rolesHandlers.command("add_admin", async (ctx) => {
  if (ctx.dbUser?.role !== Role.ADMIN) {
    return ctx.reply("⛔ Только для админа.");
  }

  const args = (ctx.match as string)?.split(" ").filter(Boolean);
  if (!args || args.length < 1) {
    return ctx.reply(
      "Использование: /add_admin <TG_ID> [SPOT_ID]\n\nПример: /add_admin 123456789 1"
    );
  }

  const tgId = BigInt(args[0]);
  const spotId = args[1] ? parseInt(args[1]) : ctx.dbUser.spotId;

  if (spotId) {
    const spot = await prisma.spot.findUnique({ where: { id: spotId } });
    if (!spot) {
      return ctx.reply(`❌ Точка #${spotId} не найдена.`);
    }
  }

  const user = await prisma.user.upsert({
    where: { tgId },
    update: { role: Role.ADMIN, spotId },
    create: { tgId, name: `Admin ${tgId}`, role: Role.ADMIN, spotId },
  });

  await audit.log(ctx.dbUser.id, "User", user.id, AuditAction.ROLE_CHANGED, { tgId: tgId.toString(), action: "promote" });
  invalidateUserCache(tgId);
  await ctx.reply(`✅ Пользователь tg:${user.tgId} назначен администратором.`);
});

/**
 * /remove_admin <TG_ID> — снимает роль администратора.
 *
 * Нельзя снять себя. Пользователь переводится в роль CLIENT.
 */
rolesHandlers.command("remove_admin", async (ctx) => {
  if (ctx.dbUser?.role !== Role.ADMIN) {
    return ctx.reply("⛔ Только для админа.");
  }

  const tgIdStr = (ctx.match as string)?.trim();
  if (!tgIdStr) {
    return ctx.reply("Использование: /remove_admin <TG_ID>");
  }

  const tgId = BigInt(tgIdStr);

  if (tgId === ctx.dbUser.tgId) {
    return ctx.reply("❌ Нельзя снять себя с роли администратора.");
  }

  const user = await prisma.user.findUnique({ where: { tgId } });
  if (!user || user.role !== Role.ADMIN) {
    return ctx.reply("❌ Администратор не найден.");
  }

  await prisma.user.update({
    where: { tgId },
    data: { role: Role.CLIENT },
  });
  invalidateUserCache(tgId);

  await audit.log(ctx.dbUser.id, "User", user.id, AuditAction.ROLE_CHANGED, { tgId: tgId.toString(), action: "demote" });
  await ctx.reply(`✅ Пользователь tg:${tgId} снят с роли администратора.`);
});

/**
 * /set_mbank_qr — запускает ожидание фото QR-кода MBank.
 *
 * После получения фото сохраняет file_id и выводит его
 * для добавления в .env (чтобы не потерять при перезапуске).
 */
rolesHandlers.command("set_mbank_qr", async (ctx) => {
  if (ctx.dbUser?.role !== Role.ADMIN) {
    return ctx.reply("⛔ Только для админа.");
  }

  ctx.session.waitingMBankQR = true;
  await ctx.reply(
    "📷 Отправьте фото QR-кода MBank для оплаты.\n" +
    "Это изображение будет показываться клиентам при аренде и бронировании."
  );
});

/**
 * /add_cashier <TG_ID> [SPOT_ID] — назначает пользователя кассиром.
 *
 * Если пользователь не существует в БД, создаёт его.
 * При указании SPOT_ID привязывает к конкретной точке.
 */
rolesHandlers.command("add_cashier", async (ctx) => {
  if (ctx.dbUser?.role !== Role.ADMIN) {
    return ctx.reply("⛔ Только для админа.");
  }

  const args = (ctx.match as string)?.split(" ").filter(Boolean);
  if (!args || args.length < 1) {
    return ctx.reply(
      "Использование: /add_cashier <TG_ID> [SPOT_ID]\n\nПример: /add_cashier 123456789 1"
    );
  }

  const tgId = BigInt(args[0]);
  const spotId = args[1] ? parseInt(args[1]) : ctx.dbUser.spotId;

  if (spotId) {
    const spot = await prisma.spot.findUnique({ where: { id: spotId } });
    if (!spot) {
      return ctx.reply(`❌ Точка #${spotId} не найдена.`);
    }
  }

  const user = await prisma.user.upsert({
    where: { tgId },
    update: { role: Role.CASHIER, spotId },
    create: { tgId, name: `Cashier ${tgId}`, role: Role.CASHIER, spotId },
  });

  await audit.log(ctx.dbUser.id, "User", user.id, AuditAction.ROLE_CHANGED, { tgId: tgId.toString(), action: "promote_cashier" });
  invalidateUserCache(tgId);
  await ctx.reply(`✅ Пользователь tg:${user.tgId} назначен кассиром.`);
});

/**
 * /remove_cashier <TG_ID> — снимает роль кассира.
 *
 * Пользователь переводится в роль CLIENT.
 */
rolesHandlers.command("remove_cashier", async (ctx) => {
  if (ctx.dbUser?.role !== Role.ADMIN) {
    return ctx.reply("⛔ Только для админа.");
  }

  const tgIdStr = (ctx.match as string)?.trim();
  if (!tgIdStr) {
    return ctx.reply("Использование: /remove_cashier <TG_ID>");
  }

  const tgId = BigInt(tgIdStr);

  const user = await prisma.user.findUnique({ where: { tgId } });
  if (!user || user.role !== Role.CASHIER) {
    return ctx.reply("❌ Кассир не найден.");
  }

  await prisma.user.update({
    where: { tgId },
    data: { role: Role.CLIENT },
  });
  invalidateUserCache(tgId);

  await audit.log(ctx.dbUser.id, "User", user.id, AuditAction.ROLE_CHANGED, { tgId: tgId.toString(), action: "demote_cashier" });
  await ctx.reply(`✅ Пользователь tg:${tgId} снят с роли кассира.`);
});

/** Получение фото QR-кода MBank */
rolesHandlers.on("message:photo", async (ctx, next) => {
  if (!ctx.session.waitingMBankQR) return next();

  ctx.session.waitingMBankQR = false;
  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  config.MBANK_QR_FILE_ID = fileId;

  await ctx.reply(
    `✅ QR-код MBank сохранён!\n\n` +
    `<code>MBANK_QR_FILE_ID=${fileId}</code>\n\n` +
    `⚠️ Чтобы QR не сбросился при перезапуске бота, добавьте эту строку в файл <code>.env</code>`,
    { parse_mode: "HTML" }
  );
});
