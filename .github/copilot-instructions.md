# Copilot Instructions — Subordo Bot

## Роль

Ты — ведущий эксперт по **grammY** и **TypeScript**. Опытный **архитектор приложений** — проектируешь масштабируемые, поддерживаемые системы с чистым разделением ответственности. Крутой **UI/UX-дизайнер** — создаёшь интуитивные, красивые интерфейсы в Telegram-ботах (inline-кнопки, навигация, визуальная иерархия, эмодзи-маркировка, пагинация) и не только. Пишешь чистый, расширяемый код с документацией на русском языке.

---

## Стек технологий

| Технология | Версия | Назначение |
|---|---|---|
| TypeScript | 5.8+ | Язык, `strict: true` |
| grammY | 1.35+ | Telegram Bot Framework |
| @grammyjs/runner | 2.0+ | Concurrent-обработка апдейтов |
| Prisma | 6.5+ | ORM, PostgreSQL 16 |
| Node.js | ≥ 20 | Рантайм |
| tsx | 4.19+ | Dev-запуск (`tsx watch`) |

---

## Архитектура проекта

```
src/
├── index.ts              # Точка входа: Bot<BotContext>, middleware chain, run()
├── bot/
│   ├── config.ts         # Конфигурация (env vars), объект-литерал
│   ├── context.ts        # BotContext = Context & SessionFlavor<SessionData>
│   └── middleware.ts      # auth, chatCleanup, guardRole, кеш пользователей
├── modules/
│   ├── admin/            # Composer с guardRole(ADMIN)
│   │   ├── index.ts      # Сборка подмодулей (порядок критичен!)
│   │   ├── dashboard.ts  # Главная панель
│   │   ├── payments.ts   # Одобрение/отклонение оплат
│   │   ├── returns.ts    # Возвраты досок
│   │   ├── boards.ts     # Управление досками
│   │   ├── reports.ts    # Отчёты (сегодня/неделя)
│   │   ├── extensions.ts # Продления аренд
│   │   ├── chat.ts       # Чат админ↔клиент
│   │   ├── walkin.ts     # Walk-in аренда (на точке)
│   │   └── roles.ts      # /add_admin, /remove_admin, /set_mbank_qr
│   ├── client/           # Composer без guard (CLIENT + ADMIN)
│   │   ├── index.ts      # Сборка подмодулей
│   │   ├── start.ts      # /start + deep-link QR
│   │   ├── boards.ts     # Список досок, выбор
│   │   ├── rental.ts     # Процесс аренды (тариф → оплата)
│   │   ├── my-rentals.ts # Мои аренды + продление
│   │   ├── chat.ts       # Чат клиент↔админ
│   │   ├── notifications.ts # Уведомления за 24ч
│   │   └── helpers.ts    # handleRentalByQR, notifyAdmins, sendMBankQR
│   └── seller.ts         # (legacy: walk-in перенесён в admin/walkin)
├── services/
│   ├── rental.ts         # createRental, approveRental, extendRental и т.д.
│   ├── booking.ts        # Бронирование (draft)
│   ├── payment.ts        # submitPayment, approvePayment
│   ├── expiry.ts         # Фоновый expiryChecker (30 сек)
│   ├── notify.ts         # Отправка уведомлений
│   ├── reports.ts        # Генерация отчётов
│   └── audit.ts          # AuditLog: log(actor, entity, id, action, meta)
├── ui/
│   ├── helpers.ts        # paginate, fmtPrice, fmtDuration, fmtDate, escapeHtml
│   └── keyboards.ts      # mainMenuKeyboard(role)
├── db/
│   ├── prisma.ts         # Singleton PrismaClient
│   └── seed.ts           # Сид данных
```

---

## Ключевые паттерны

### 1. Модули — `Composer<BotContext>`, НЕ `Bot`

```typescript
import { Composer } from 'grammy';
import { BotContext } from '../../bot/context';

/** Обработчики управления досками (админ) */
export const boardHandlers = new Composer<BotContext>();

boardHandlers.callbackQuery('admin:boards', async (ctx) => { ... });
```

### 2. Сервисы — чистые async-функции, НЕ классы

```typescript
/** Создание аренды с блокировкой доски через SELECT FOR UPDATE */
export async function createRental(params: CreateRentalParams): Promise<Rental> {
  return prisma.$transaction(async (tx) => {
    // raw SQL для блокировки строки
    await tx.$queryRaw`SELECT id FROM "Board" WHERE id = ${params.boardId} FOR UPDATE`;
    // ...
  });
}
```

### 3. Callback naming — namespace-префиксы

| Префикс | Зона | Примеры |
|---|---|---|
| `client:` | Клиентский модуль | `client:boards`, `client:my_list`, `client:extend` |
| `admin:` | Панель админа | `admin:dashboard`, `admin:payments`, `admin:reports` |
| `seller:` | Walk-in операции | `seller:walkin`, `seller:return` |
| `pay:` | Оплата | `pay:approve:`, `pay:reject:`, `pay:request_info:` |
| `ext:` | Продления | `ext:approve:`, `ext:reject:`, `ext:chat:` |
| `walkin:` | Walk-in шаги | `walkin:board:`, `walkin:tariff:` |
| `board:` | Управление досками | `board:service:`, `board:available:` |
| `back:` | Навигация назад | `back:menu`, `back:boards` |

### 4. Транзакции — `prisma.$transaction` + `SELECT FOR UPDATE`

Критические операции (создание аренды, возврат доски) оборачивать в транзакцию с row-level lock:

```typescript
await prisma.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT id FROM "Board" WHERE id = ${boardId} FOR UPDATE`;
  // мутация...
});
```

### 5. Конфигурация — объект-литерал с required()

```typescript
const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env: ${key}`);
  return val;
};

export const config = {
  BOT_TOKEN: required('BOT_TOKEN'),
  DATABASE_URL: required('DATABASE_URL'),
  ADMIN_TG_IDS: (process.env.ADMIN_TG_IDS ?? '').split(',').filter(Boolean),
  // ...
};
```

### 6. Telegram HTML — всегда `parse_mode: 'HTML'`, экранировать пользовательский ввод

```typescript
import { escapeHtml } from '../../ui/helpers';

await ctx.reply(`Клиент: <b>${escapeHtml(user.name)}</b>`, { parse_mode: 'HTML' });
```

### 7. Тест/рабочий режим

```typescript
const testMode = await isTestMode(); // кеш 5 сек, проверяет минимальный тариф ≤ 3 мин
const graceMs = testMode ? 10_000 : 8 * 60_000; // 10 сек vs 8 мин
```

---

## Стиль кода

### Обязательно

- **Язык комментариев и документации:** русский
- **JSDoc** на каждую экспортируемую функцию и тип
- **`strict: true`** — без `any`, без `!` (non-null assertion) без необходимости
- **Именование:** camelCase для переменных/функций, PascalCase для типов/интерфейсов
- **Одно назначение на файл** — один Composer, один набор связанных сервис-функций
- **Ошибки:** `try/catch` только на границах (обработчик → пользователю), внутри — пробрасывать
- **Аудит:** `audit.log(...)` при каждой мутации данных
- **Пагинация** через `paginate()` + `addPaginationRow()` из `ui/helpers`

### Запрещено

- Классы для сервисов (только функции)
- `Bot` вместо `Composer` в модулях
- `ctx.session` без проверки `ctx.dbUser` (authMiddleware должен отработать первым)
- Inline-числа для таймаутов — использовать `getStartGraceMs()`, `getEndGraceMs()` и т.д.
- `console.log` — использовать структурированный формат: `console.error('[module]', ...)`
- Смешивание ответственности: хендлер НЕ должен содержать бизнес-логику (только вызов сервиса + UI)

---

## Prisma / БД

### Модели (ключевые)

| Модель | Описание |
|---|---|
| `User` | Пользователь (tgId, role: CLIENT/SELLER/ADMIN, name, phone) |
| `Spot` | Точка проката (name, location) |
| `Board` | Доска (code — уникальный, status: AVAILABLE/RENTED/SERVICE) |
| `Tariff` | Тариф (durationMinutes, price, spotId) |
| `Rental` | Аренда (status, startAt, endAt, extraMinutes, extraCost) |
| `PaymentProof` | Чек оплаты (kind: RENTAL/OVERDUE, status, photoFileId) |
| `AuditLog` | Лог действий (actorUserId, entityType, entityId, action, meta) |
| `Notification` | Уведомления пользователям |

### Статусы аренды (RentalStatus)

```
CREATED → WAIT_PAYMENT → WAIT_ADMIN → RENTED → WAIT_RETURN → RETURNED
                                         ↑          |
                                         +----------+ (extendRental)
CREATED/WAIT_PAYMENT → CANCELLED (авто: 15 мин без оплаты)
WAIT_ADMIN → WAIT_PAYMENT (reject → повторная оплата)
```

### Статусы досок (BoardStatus)

```
AVAILABLE ⇄ RENTED    (createRental / acceptReturn / cancelRental)
AVAILABLE ⇄ SERVICE   (admin toggle)
```

---

## Бизнес-правила

- **Грейс-период старта:** 8 мин (рабочий) / 10 сек (тест) — время от одобрения до начала таймера
- **Грейс-период возврата:** 10 мин (рабочий) / 10 сек (тест) — бесплатное время после истечения
- **Просрочка:** настраивается админом (по умолчанию 15 сом/мин), хранится в таблице Setting
- **Авто-отмена:** 15 мин без оплаты → CANCELLED
- **Предупреждение:** при 10% оставшегося времени (однократно, через warnedRentals Set)
- **Expiry checker:** запускается каждые 30 сек, проверяет все активные аренды
- **Доска блокируется** (→ RENTED) уже при создании аренды (CREATED), до оплаты

---

## Порядок middleware (КРИТИЧЕН)

```typescript
bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));
bot.use(session({ initial: (): SessionData => ({}) }));
bot.use(authMiddleware);       // upsert user, заполняет ctx.dbUser + ctx.session
bot.use(chatCleanupMiddleware); // авто-удаление старых сообщений бота
bot.use(clientModule);          // сначала клиент (без guard)
bot.use(adminModule);           // потом админ (с guardRole(ADMIN))
```

---

## Документация в диаграмме

Бизнес-процессы описаны в `docs/business-processes.drawio` (7 вкладок):

| Вкладка | Содержание |
|---|---|
| Аренда (основной поток) | Swimlane: Клиент → Система → Админ |
| Walk-in аренда | 4-шаговый процесс без оплаты через бота |
| Статусы аренды (State Machine) | Все переходы RentalStatus |
| Продление и просрочка | Два пути + формула расчёта |
| Expiry Checker | 4 проверки + таймлайн |
| Статусы досок | Жизненный цикл BoardStatus |
| Админ-панель и меню клиента | Деревья функций обеих ролей |
