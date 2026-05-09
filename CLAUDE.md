# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Dev with hot-reload (tsx watch)
npm run build        # Compile TS → JS (dist/)
npm start            # Run compiled bot

npm run db:generate  # Prisma generate (after schema changes)
npm run db:migrate   # Apply migrations (dev)
npm run db:seed      # Seed test data (spots, boards, tariffs)
npm run db:studio    # Prisma Studio web UI

npm run lint         # ESLint src/
npm run lint:fix     # ESLint with autofix
```

**Setup:**
```bash
docker compose up -d                    # Start PostgreSQL
npm install
npx prisma migrate dev --name init
npm run db:seed
npm run dev
```

Required `.env`: `BOT_TOKEN`, `DATABASE_URL`, `ADMIN_TG_ID`. See `.env.example`.

## Architecture

Telegram SUP-board rental bot. Currency: KGS (сом). Timezone: Asia/Bishkek.

```
src/
├── index.ts              # Entry: middleware chain + run()
├── bot/
│   ├── config.ts         # Env vars via required()
│   ├── context.ts        # BotContext, SessionData, InputMode types
│   └── middleware.ts     # authMiddleware, chatCleanup, guardRole, rateLimit
├── modules/
│   ├── client/           # boards, rental, my-rentals, notifications, chat, start, helpers
│   ├── admin/            # boards, tariffs, payments, returns, extensions, walkin, reports, roles, dashboard, chat
│   ├── cashier/          # Composer — guardRole(CASHIER, ADMIN); единый интерфейс кассы
│   └── shared/
│       └── payment-actions.ts  # Общие ADMIN+CASHIER хэндлеры одобрения/отклонения чеков
├── services/
│   ├── rental.ts         # createRental, approveRental, extendRental, acceptReturn…
│   ├── payment.ts        # PaymentProof: одобрение/отклонение (RENTAL и OVERDUE)
│   ├── pricing.ts        # applyDiscount, tariffEffectivePrice, fmtDiscount, normalizePercent
│   ├── discounts.ts      # Персональные скидки клиента (User.discountPercent)
│   ├── tariffs.ts        # CRUD тарифов (soft delete при наличии аренд)
│   ├── settings.ts       # getOverdueRate / setOverdueRate (Setting table, cached)
│   ├── expiry.ts         # Background checker every 30s (advisory lock)
│   ├── notify.ts         # Telegram notifications + cleanup устаревших
│   ├── reports.ts        # Revenue reports + CSV
│   └── audit.ts          # audit.log(actor, entity, id, action, meta)
├── ui/
│   ├── helpers.ts        # paginate, fmtPrice, fmtDuration, fmtDate, escapeHtml
│   └── keyboards.ts      # mainMenuKeyboard(role)
└── db/
    ├── prisma.ts          # Singleton PrismaClient
    └── seed.ts
```

## Critical: Middleware Order

```typescript
sequentialize(chatId)  →  session  →  authMiddleware  →  rateLimitMiddleware
  →  chatCleanupMiddleware  →  bot.catch(...)  →  clientModule
  →  paymentActionsGuarded (ADMIN|CASHIER)  →  cashierModule  →  adminModule
```

`authMiddleware` must run before any module — it populates `ctx.dbUser` and `ctx.session`. Never use `ctx.session` without `ctx.dbUser` being set first.

`bot.catch` глушит ожидаемые ошибки Telegram API: `query is too old`, `message is not modified`, `message to edit not found` — не логируем как error.

**Background tasks** (стартуют в `main()`, останавливаются по SIGINT/SIGTERM):
- `startExpiryChecker(bot.api)` — авто-завершение истёкших аренд (30s tick).
- `startNotificationsCleanup()` — чистка устаревших уведомлений (1×/час).
- `startMiddlewareMaintenance()` — чистка in-memory кешей middleware (rate-limit, etc).

Runner запускается с `silent: true` (глушим ECONNRESET stack-trace) и авто-перезапускается при крахе через `watchRunner()`.

## Key Patterns

**Modules are `Composer<BotContext>`, never `Bot`:**
```typescript
export const myHandlers = new Composer<BotContext>();
myHandlers.callbackQuery('admin:boards', async (ctx) => { ... });
```

**Services are plain async functions, never classes.** Put business logic in services, keep handlers thin (call service + render UI only).

**Callback query naming convention:**
| Prefix | Zone |
|---|---|
| `client:` | Client module |
| `admin:` | Admin module |
| `seller:` / `walkin:` | Walk-in ops |
| `pay:` | Payment approval |
| `ext:` | Extension approval |
| `board:` | Board management |
| `back:` | Navigation |

**Transactions with row-level lock for critical mutations:**
```typescript
await prisma.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT id FROM "Board" WHERE id = ${boardId} FOR UPDATE`;
  // mutations...
});
```
Always use this pattern for `createRental`, `acceptReturn`, `cancelRental`.

**Always `parse_mode: 'HTML'`; escape user input:**
```typescript
await ctx.reply(`Клиент: <b>${escapeHtml(user.name)}</b>`, { parse_mode: 'HTML' });
```

**Test mode** is detected by checking if the minimum tariff duration ≤ 3 minutes (`isTestMode()`, cached 5s). Grace periods: 8 min (prod) / 10 sec (test).

**`InputMode` discriminated union** in session controls how `message:text` handlers behave — check `ctx.session.inputMode` instead of ad-hoc boolean flags.

## Business Rules

- **Board locked** (→ `RENTED`) at rental `CREATED`, before payment is confirmed.
- **Auto-cancel:** 15 min without payment → `CANCELLED`.
- **Expiry checker** runs every 30s with a PostgreSQL advisory lock (ID `100500`) so only one bot instance runs it.
- **Warning:** sent once at ≤10% time remaining (tracked via `warnedRentals` Set in-memory).
- **Overdue rate:** stored in `Setting` table (`overdue_rate_per_min`, default 15 сом/мин), in-memory cached, cleared on write.
- **Pricing:** `tariffEffectivePrice()` applies promo if `promoPrice < price`; `applyDiscount()` applies client's personal discount. Discount percent is snapshotted at rental creation.
- **Grace periods:** `getStartGraceMs()` and `getEndGraceMs()` — never use inline numeric literals for timeouts.

### RentalStatus flow
```
CREATED → WAIT_PAYMENT → WAIT_ADMIN → RENTED → WAIT_RETURN → RETURNED
CREATED/WAIT_PAYMENT → CANCELLED
WAIT_ADMIN → WAIT_PAYMENT (on rejection)
RENTED ←→ WAIT_RETURN (extendRental resets back to RENTED)
```

## Code Style

- **Language:** comments and JSDoc in Russian.
- **No classes** for services — only exported async functions.
- **No `any`**, no `!` (non-null assertion) without clear necessity (`strict: true`).
- **Errors:** `try/catch` only at module handler boundaries (user-facing); throw internally.
- **Audit every mutation:** call `audit.log(...)` for all data-changing operations.
- **Pagination:** use `paginate()` + `addPaginationRow()` from `ui/helpers`.
- **Logging:** `console.error('[module] message', ...)` — never bare `console.log`.
