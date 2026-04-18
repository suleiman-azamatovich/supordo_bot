import { Role } from "@prisma/client";
import { prisma } from "../db/prisma";
import { BotContext } from "./context";
import { NextFunction } from "grammy";
import { config } from "./config";

/** Параметры rate limiter */
const RATE_LIMIT_WINDOW_MS = 1_000; // 1 секунда
const RATE_LIMIT_MAX = 3; // макс. 3 действия за окно
const RATE_LIMIT_MAX_ENTRIES = 10_000; // защита от неограниченного роста
const rateLimitMap = new Map<number, { count: number; resetAt: number }>();

/**
 * Периодическая очистка rateLimitMap — удаляет протухшие записи.
 * Без этого Map растёт на +1 запись за каждого уникального пользователя навсегда → утечка памяти.
 */
function cleanupRateLimitMap() {
  const now = Date.now();
  for (const [userId, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(userId);
  }
  // Страховка: если Map внезапно раздулся (например, массовый спам),
  // сбрасываем полностью, чтобы не дать расти бесконечно.
  if (rateLimitMap.size > RATE_LIMIT_MAX_ENTRIES) {
    rateLimitMap.clear();
  }
}

/**
 * Rate limiting middleware — ограничивает спам callback-кнопок.
 *
 * Позволяет не более RATE_LIMIT_MAX действий за RATE_LIMIT_WINDOW_MS.
 * Применяется к callback_query для защиты от спама.
 */
export async function rateLimitMiddleware(ctx: BotContext, next: NextFunction) {
  if (!ctx.callbackQuery || !ctx.from) return next();

  const userId = ctx.from.id;
  const now = Date.now();
  let entry = rateLimitMap.get(userId);

  if (!entry || now >= entry.resetAt) {
    entry = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitMap.set(userId, entry);
    return next();
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    await ctx.answerCallbackQuery({ text: "⏳ Слишком быстро. Подождите секунду.", show_alert: false });
    return;
  }

  return next();
}

/** In-memory user cache: tgId → user data. Avoids DB hit on every update. */
const userCache = new Map<bigint, {
  id: number; tgId: bigint; role: Role; name: string;
  phone: string | null; spotId: number | null; discountPercent: number; ts: number;
}>();
const CACHE_TTL_MS = 5 * 60_000; // 5 min
const USER_CACHE_MAX_ENTRIES = 5_000;

/**
 * Периодическая очистка userCache — удаляет протухшие записи
 * и ограничивает размер кеша, чтобы предотвратить утечку памяти.
 */
function cleanupUserCache() {
  const now = Date.now();
  for (const [tgId, entry] of userCache) {
    if (now - entry.ts > CACHE_TTL_MS) userCache.delete(tgId);
  }
  if (userCache.size > USER_CACHE_MAX_ENTRIES) {
    // Срезаем самые старые записи (FIFO-ish)
    const excess = userCache.size - USER_CACHE_MAX_ENTRIES;
    let removed = 0;
    for (const tgId of userCache.keys()) {
      if (removed >= excess) break;
      userCache.delete(tgId);
      removed++;
    }
  }
}

/**
 * Запустить периодическую очистку in-memory кешей middleware.
 * Вызывается один раз при старте бота из `index.ts`.
 * @returns Функция остановки (clearInterval).
 */
export function startMiddlewareMaintenance(): () => void {
  const CLEANUP_INTERVAL_MS = 5 * 60_000; // 5 мин
  const intervalId = setInterval(() => {
    try {
      cleanupRateLimitMap();
      cleanupUserCache();
    } catch (e) {
      console.error("[middleware] Ошибка очистки кешей:", e);
    }
  }, CLEANUP_INTERVAL_MS);
  // `unref` — не держать event loop, чтобы не блокировать graceful shutdown
  intervalId.unref?.();
  return () => clearInterval(intervalId);
}

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

    // Авто-повышение до CASHIER если tgId указан в CASHIER_TG_IDS
    if (user.role === Role.CLIENT && config.CASHIER_TG_IDS.includes(tgId.toString())) {
      await prisma.user.update({ where: { tgId }, data: { role: Role.CASHIER } });
      user.role = Role.CASHIER;
    }

    cached = {
      id: user.id, tgId: user.tgId, role: user.role,
      name: user.name, phone: user.phone, spotId: user.spotId,
      discountPercent: user.discountPercent ?? 0,
      ts: now,
    };
    userCache.set(tgId, cached);
  }

  ctx.dbUser = {
    id: cached.id, tgId: cached.tgId, role: cached.role,
    name: cached.name, phone: cached.phone, spotId: cached.spotId,
    discountPercent: cached.discountPercent,
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

  // Auto-clear chat mode when navigating away from chat-related actions
  if (ctx.callbackQuery?.data) {
    const chatActions = ['client:chat_admin:', 'client:chat_ext:', 'client:end_chat',
      'admin:chat_client:', 'admin:end_chat', 'ext:chat:'];
    const isChatAction = chatActions.some((a) => ctx.callbackQuery!.data!.startsWith(a));
    if (!isChatAction) {
      // Clear admin chat state
      ctx.session.adminChat = undefined;
      ctx.session.clientChat = undefined;
    }
  }

  if (ctx.message) {
    // New message from user — clear everything (fire-and-forget)
    const ids = ctx.session.lastBotMsgIds ?? [];
    if (ids.length > 0) {
      void Promise.all(ids.map((id) => ctx.api.deleteMessage(chatId, id).catch(() => { })));
    }
    ctx.session.lastBotMsgIds = [];
    // Delete user's message (fire-and-forget)
    ctx.api.deleteMessage(chatId, ctx.message.message_id).catch(() => { });
  } else if (ctx.callbackQuery?.message) {
    // Callback — keep the source message, delete extras (fire-and-forget)
    const sourceId = ctx.callbackQuery.message.message_id;
    const ids = (ctx.session.lastBotMsgIds ?? []).filter((id) => id !== sourceId);
    if (ids.length > 0) {
      void Promise.all(ids.map((id) => ctx.api.deleteMessage(chatId, id).catch(() => { })));
    }
    ctx.session.lastBotMsgIds = [sourceId];
  }

  // Wrap reply methods to auto-track sent message IDs
  const MAX_TRACKED_MSGS = 50; // защита от неограниченного роста сессии
  const trackMsgId = (id: number) => {
    const arr = (ctx.session.lastBotMsgIds ??= []);
    arr.push(id);
    if (arr.length > MAX_TRACKED_MSGS) {
      arr.splice(0, arr.length - MAX_TRACKED_MSGS);
    }
  };

  const origReply = ctx.reply.bind(ctx);
  ctx.reply = (async (text: string, other?: any, signal?: any) => {
    const msg = await origReply(text, other, signal);
    trackMsgId(msg.message_id);
    return msg;
  }) as any;

  const origPhoto = ctx.replyWithPhoto.bind(ctx);
  ctx.replyWithPhoto = (async (photo: any, other?: any, signal?: any) => {
    const msg = await origPhoto(photo, other, signal);
    trackMsgId(msg.message_id);
    return msg;
  }) as any;

  const origDoc = ctx.replyWithDocument.bind(ctx);
  ctx.replyWithDocument = (async (doc: any, other?: any, signal?: any) => {
    const msg = await origDoc(doc, other, signal);
    trackMsgId(msg.message_id);
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
