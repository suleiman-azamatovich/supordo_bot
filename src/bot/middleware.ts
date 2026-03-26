import { Role } from "@prisma/client";
import { prisma } from "../db/prisma";
import { BotContext } from "./context";
import { NextFunction } from "grammy";

/**
 * Auth middleware: upsert user in DB, populate ctx.dbUser and session.
 */
export async function authMiddleware(ctx: BotContext, next: NextFunction) {
  if (!ctx.from) return;

  const tgId = BigInt(ctx.from.id);
  const name =
    [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") ||
    ctx.from.username ||
    "User";

  let user = await prisma.user.upsert({
    where: { tgId },
    update: {},
    create: { tgId, name, role: Role.CLIENT },
  });

  ctx.dbUser = {
    id: user.id,
    tgId: user.tgId,
    role: user.role,
    name: user.name,
    phone: user.phone,
    spotId: user.spotId,
  };

  ctx.session.userId = user.id;
  ctx.session.role = user.role;
  ctx.session.spotId = user.spotId ?? undefined;

  await next();
}

/**
 * Chat cleanup middleware — deletes old bot messages to keep chat clean.
 * On new message: deletes all tracked bot messages + user's message.
 * On callback: deletes extra messages, keeps the source (it gets edited).
 * Wraps ctx.reply/replyWithPhoto/replyWithDocument to auto-track IDs.
 */
export async function chatCleanupMiddleware(ctx: BotContext, next: NextFunction) {
  const chatId = ctx.chat?.id;
  if (!chatId) return next();

  if (ctx.message) {
    // New message from user — clear everything
    const ids = ctx.session.lastBotMsgIds ?? [];
    for (const id of ids) {
      try { await ctx.api.deleteMessage(chatId, id); } catch { }
    }
    ctx.session.lastBotMsgIds = [];
    // Delete user's message
    try { await ctx.api.deleteMessage(chatId, ctx.message.message_id); } catch { }
  } else if (ctx.callbackQuery?.message) {
    // Callback — keep the source message, delete extras
    const sourceId = ctx.callbackQuery.message.message_id;
    const ids = (ctx.session.lastBotMsgIds ?? []).filter((id) => id !== sourceId);
    for (const id of ids) {
      try { await ctx.api.deleteMessage(chatId, id); } catch { }
    }
    ctx.session.lastBotMsgIds = [sourceId];
  }

  // Wrap reply methods to auto-track sent message IDs
  const origReply = ctx.reply.bind(ctx);
  ctx.reply = (async (text: string, other?: any, signal?: any) => {
    const msg = await origReply(text, other, signal);
    (ctx.session.lastBotMsgIds ??= []).push(msg.message_id);
    return msg;
  }) as any;

  const origPhoto = ctx.replyWithPhoto.bind(ctx);
  ctx.replyWithPhoto = (async (photo: any, other?: any, signal?: any) => {
    const msg = await origPhoto(photo, other, signal);
    (ctx.session.lastBotMsgIds ??= []).push(msg.message_id);
    return msg;
  }) as any;

  const origDoc = ctx.replyWithDocument.bind(ctx);
  ctx.replyWithDocument = (async (doc: any, other?: any, signal?: any) => {
    const msg = await origDoc(doc, other, signal);
    (ctx.session.lastBotMsgIds ??= []).push(msg.message_id);
    return msg;
  }) as any;

  await next();
}

/**
 * Guard factory — restricts handler to specified roles.
 */
export function guardRole(...roles: Role[]) {
  return async (ctx: BotContext, next: NextFunction) => {
    if (!ctx.dbUser || !roles.includes(ctx.dbUser.role)) {
      await ctx.reply("⛔ У вас нет доступа к этой функции.");
      return;
    }
    await next();
  };
}
