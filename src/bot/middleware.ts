import { Role } from "@prisma/client";
import { prisma } from "../db/prisma";
import { BotContext } from "./context";
import { NextFunction } from "grammy";

/** In-memory user cache: tgId → user data. Avoids DB hit on every update. */
const userCache = new Map<bigint, {
  id: number; tgId: bigint; role: Role; name: string;
  phone: string | null; spotId: number | null; ts: number;
}>();
const CACHE_TTL_MS = 5 * 60_000; // 5 min

/**
 * Auth middleware: upsert user in DB, populate ctx.dbUser and session.
 * Uses in-memory cache to skip DB on repeated messages from same user.
 */
export async function authMiddleware(ctx: BotContext, next: NextFunction) {
  if (!ctx.from) return;

  const tgId = BigInt(ctx.from.id);
  const now = Date.now();
  let cached = userCache.get(tgId);

  if (!cached || now - cached.ts > CACHE_TTL_MS) {
    const name =
      [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") ||
      ctx.from.username ||
      "User";

    const user = cached
      ? await prisma.user.findUnique({ where: { tgId } })
      : await prisma.user.upsert({
        where: { tgId },
        update: {},
        create: { tgId, name, role: Role.CLIENT },
      });

    if (!user) return;

    cached = {
      id: user.id, tgId: user.tgId, role: user.role,
      name: user.name, phone: user.phone, spotId: user.spotId,
      ts: now,
    };
    userCache.set(tgId, cached);
  }

  ctx.dbUser = {
    id: cached.id, tgId: cached.tgId, role: cached.role,
    name: cached.name, phone: cached.phone, spotId: cached.spotId,
  };

  ctx.session.userId = cached.id;
  ctx.session.role = cached.role;
  ctx.session.spotId = cached.spotId ?? undefined;

  await next();
}

/** Invalidate cached user (call after role/spot changes). */
export function invalidateUserCache(tgId: bigint) {
  userCache.delete(tgId);
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
    // New message from user — clear everything (fire-and-forget)
    const ids = ctx.session.lastBotMsgIds ?? [];
    if (ids.length > 0) {
      Promise.all(ids.map((id) => ctx.api.deleteMessage(chatId, id).catch(() => { })));
    }
    ctx.session.lastBotMsgIds = [];
    // Delete user's message (fire-and-forget)
    ctx.api.deleteMessage(chatId, ctx.message.message_id).catch(() => { });
  } else if (ctx.callbackQuery?.message) {
    // Callback — keep the source message, delete extras (fire-and-forget)
    const sourceId = ctx.callbackQuery.message.message_id;
    const ids = (ctx.session.lastBotMsgIds ?? []).filter((id) => id !== sourceId);
    if (ids.length > 0) {
      Promise.all(ids.map((id) => ctx.api.deleteMessage(chatId, id).catch(() => { })));
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
