# SUBordo Bot 🏄

Telegram-бот для аренды SUP-бордов с ролями CLIENT / SELLER / ADMIN.
Стек: **Node.js 20+, TypeScript, grammY, Prisma, PostgreSQL (Docker)**.
Валюта: **KGS (сом)**, таймзона: **Asia/Bishkek**.

---

## Возможности

| Роль | Функции |
|------|---------|
| **CLIENT** | Аренда по QR deep link, бронирование заранее, отправка фото чека, просмотр истории |
| **SELLER** | Список заявок к выдаче, выдача доски, приём возврата, история за день |
| **ADMIN** | Подтверждение/отклонение оплат, отчёты (выручка/статусы/точки/CSV), управление точками/досками/тарифами/продавцами |

---

## Быстрый старт (3 команды)

### Требования

- **Node.js 20+** — [скачать](https://nodejs.org/)
- **Docker Desktop** — [скачать](https://www.docker.com/products/docker-desktop/)

### 1. Настройте `.env`

Скопируйте `.env.example` → `.env` и заполните:

```env
BOT_TOKEN=123456:ABC-DEF...       # Токен бота из @BotFather
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/subordo_bot
ADMIN_TG_ID=123456789             # Ваш Telegram ID (будет ADMIN)
```

> Узнать свой Telegram ID: напишите боту **@userinfobot** в Telegram.

### 2. Запустите всё одной серией команд

```bash
# 1) Поднять PostgreSQL в Docker
docker compose up -d

# 2) Установить зависимости
npm install

# 3) Применить миграции + создать клиент + заполнить тестовые данные
npx prisma migrate dev --name init
npm run db:seed

# 4) Запустить бота
npm run dev
```

Готово! Бот пишет в консоль `✅ Bot @... started`.

### Остановка

```bash
# Остановить бота: Ctrl+C
# Остановить PostgreSQL:
docker compose down
# (данные сохранятся в docker volume)
```

### Seed создаёт

- ADMIN-пользователя (`ADMIN_TG_ID`)
- 2 точки: «Чолпон-Ата» и «Иссык-Куль»
- 5 досок (3 + 2) с уникальными кодами
- 6 тарифов в **сомах** (300–1100 сом)

---

## Команды бота

| Команда | Описание |
|---------|----------|
| `/start` | Приветствие + главное меню |
| `/start board_<CODE>` | Начать аренду доски по QR-коду |
| `/menu` | Открыть главное меню (по роли) |
| `/add_seller <TG_ID> <SPOT_ID>` | (ADMIN) Назначить продавца на точку |
| `/remove_seller <TG_ID>` | (ADMIN) Снять роль продавца |

---

## QR / Deep Link

QR-код на доске содержит ссылку вида:

```
https://t.me/<BOT_USERNAME>?start=board_<BOARD_CODE>
```

### Примеры (для тестовых данных):

| Доска | Deep Link |
|-------|-----------|
| SUP Touring 12' | `t.me/<BOT>?start=board_C1-01` |
| SUP Allround 10'6 | `t.me/<BOT>?start=board_C1-02` |
| SUP Race 14' | `t.me/<BOT>?start=board_C1-03` |
| SUP Yoga 10' | `t.me/<BOT>?start=board_P1-01` |
| SUP Family 11' | `t.me/<BOT>?start=board_P1-02` |

При переходе по ссылке бот:
1. Показывает информацию о доске и точке
2. Предлагает выбрать тариф
3. Показывает инструкцию по оплате и сумму
4. Принимает нажатие «Я оплатил» и фото чека
5. Отправляет заявку админу на подтверждение

---

## Управление продавцами

### Добавить продавца
```
/add_seller 987654321 1
```
— пользователь с TG ID `987654321` становится SELLER на точке #1.

Если пользователь ещё не писал боту, будет создан с ролью SELLER. Когда он напишет `/start`, увидит меню продавца.

### Снять продавца
```
/remove_seller 987654321
```
— пользователь возвращается в роль CLIENT, отвязывается от точки.

---

## Статусы

### Booking (бронирование)
```
DRAFT → WAIT_PAYMENT → WAIT_ADMIN → CONFIRMED
                    ↘ CANCELLED
                                    ↘ EXPIRED
```

### Rental (аренда на месте)
```
CREATED → WAIT_PAYMENT → WAIT_ADMIN → READY_TO_HAND → RENTED → RETURNED
                       ↘ CANCELLED
```

### PaymentProof
```
SUBMITTED → APPROVED
          ↘ REJECTED (клиент может повторить)
```

---

## Подтверждение оплаты

1. Клиент нажимает «Я оплатил» (опц. прикладывает фото чека).
2. Создаётся `PaymentProof` со статусом `SUBMITTED`.
3. Все ADMIN получают уведомление с кнопками:
   - ✅ **Approve** — оплата подтверждена
   - ❌ **Reject** — оплата отклонена
   - 💬 **Запросить инфо** — попросить клиента дослать данные
4. При **Approve**:
   - Rental → `READY_TO_HAND`, уведомление SELLER и CLIENT
   - Booking → `CONFIRMED`, уведомление CLIENT
5. При **Reject**:
   - Заявка → `WAIT_PAYMENT` (клиент может повторить)

---

## Отчёты (ADMIN)

Доступны через меню «📊 Отчёты»:

- **Выручка по дням** (7 / 30 дней) — текстовый список дат и сумм
- **По статусам** — количество аренд и бронирований по каждому статусу
- **По точкам** (7 / 30 дней) — выручка в разрезе точек
- **CSV экспорт** (7 / 30 дней) — отправляется как документ

---

## Структура проекта

```
src/
├── index.ts              # Точка входа, запуск бота
├── bot/
│   ├── config.ts         # Конфигурация из env
│   ├── context.ts        # Тип контекста бота
│   └── middleware.ts      # Auth + role guard
├── db/
│   ├── prisma.ts         # Экземпляр PrismaClient
│   └── seed.ts           # Сид-скрипт
├── modules/
│   ├── client.ts         # Команды и callback'и клиента
│   ├── seller.ts         # Дашборд продавца
│   └── admin.ts          # Дашборд админа
├── services/
│   ├── audit.ts          # AuditLog
│   ├── rental.ts         # Логика аренды
│   ├── booking.ts        # Логика бронирования
│   ├── payment.ts        # Логика оплат
│   └── reports.ts        # Отчёты и CSV
└── ui/
    ├── helpers.ts        # Пагинация, форматирование
    └── keyboards.ts      # Inline-клавиатуры по ролям
prisma/
└── schema.prisma         # Схема БД
```

---

## Скрипты npm

| Скрипт | Описание |
|--------|----------|
| `npm run dev` | Запуск с hot-reload (tsx watch) |
| `npm run build` | Компиляция TS → JS |
| `npm start` | Запуск скомпилированного бота |
| `npm run db:generate` | Prisma generate |
| `npm run db:migrate` | Prisma migrate dev |
| `npm run db:seed` | Заполнение тестовых данных |
| `npm run db:studio` | Prisma Studio (веб-UI для БД) |

---

## Сущности БД

- **User** — пользователь (CLIENT/SELLER/ADMIN), привязка к точке
- **Spot** — точка проката
- **Board** — SUP-доска (код для QR, статус AVAILABLE/RENTED/SERVICE)
- **Tariff** — тариф (длительность + цена) привязан к точке
- **Booking** — бронирование заранее
- **Rental** — аренда на месте (по QR)
- **PaymentProof** — подтверждение оплаты (file_id чека)
- **AuditLog** — лог всех важных действий

---

## Лицензия

MIT
