# Инструкция по запуску SUBordo Bot

Пошаговое руководство по настройке и запуску Telegram-бота для аренды SUP-бордов.

---

## Содержание

1. [Требования](#1-требования)
2. [Клонирование проекта](#2-клонирование-проекта)
3. [Установка зависимостей](#3-установка-зависимостей)
4. [Настройка переменных окружения](#4-настройка-переменных-окружения)
5. [Запуск PostgreSQL через Docker](#5-запуск-postgresql-через-docker)
6. [Применение миграций и генерация Prisma-клиента](#6-применение-миграций-и-генерация-prisma-клиента)
7. [Заполнение базы тестовыми данными (seed)](#7-заполнение-базы-тестовыми-данными-seed)
8. [Запуск бота](#8-запуск-бота)
9. [Проверка работоспособности](#9-проверка-работоспособности)
10. [Полезные команды](#10-полезные-команды)
11. [Генерация QR-кодов](#11-генерация-qr-кодов)
12. [Остановка и перезапуск](#12-остановка-и-перезапуск)
13. [Решение типичных проблем](#13-решение-типичных-проблем)

---

## 1. Требования

Перед началом убедитесь, что установлены:

| Компонент | Минимальная версия | Как проверить | Где скачать |
|---|---|---|---|
| **Node.js** | 20.0.0 | `node -v` | [nodejs.org](https://nodejs.org/) |
| **npm** | 9+ (идёт с Node.js) | `npm -v` | — |
| **Docker Desktop** | любая актуальная | `docker --version` | [docker.com](https://www.docker.com/products/docker-desktop/) |
| **Git** | любая | `git --version` | [git-scm.com](https://git-scm.com/) |

> **Windows:** убедитесь, что Docker Desktop запущен (иконка в трее).

---

## 2. Клонирование проекта

```bash
git clone <URL_РЕПОЗИТОРИЯ>
cd subordo_bot
```

---

## 3. Установка зависимостей

```bash
npm install
```

Это установит все пакеты из `package.json`, включая:
- **grammy** — Telegram Bot Framework
- **@grammyjs/runner** — concurrent-обработка апдейтов
- **@prisma/client** — ORM для PostgreSQL
- **dotenv** — загрузка `.env` переменных
- **tsx** — запуск TypeScript без компиляции (dev-режим)

---

## 4. Настройка переменных окружения

Скопируйте пример и откройте файл для редактирования:

```bash
cp .env.example .env
```

Заполните `.env`:

```env
# === ОБЯЗАТЕЛЬНЫЕ ===

# Токен бота — получить у @BotFather в Telegram
BOT_TOKEN=123456789:ABCDefGHIjklMNOpqrsTUVwxyz

# Строка подключения к PostgreSQL
# Порт 5433 — как настроен в docker-compose.yml
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/subordo_bot

# Telegram ID администратора (или несколько через запятую)
# Узнать свой ID: написать боту @userinfobot в Telegram
ADMIN_TG_IDS=123456789

# === ОПЦИОНАЛЬНЫЕ ===

# Уровень логирования (info / debug / error)
LOG_LEVEL=info

# Таймзона (по умолчанию Asia/Bishkek)
TIMEZONE=Asia/Bishkek

# File ID QR-кода MBank для оплаты (устанавливается через /set_mbank_qr)
MBANK_QR_FILE_ID=
```

### Как получить `BOT_TOKEN`

1. Откройте Telegram, найдите бота **@BotFather**
2. Отправьте `/newbot`
3. Укажите имя бота (например, `SUBordo Rental Bot`)
4. Укажите username (например, `subordo_rental_bot`)
5. Скопируйте токен из ответа

### Как узнать свой Telegram ID

1. Откройте Telegram, найдите бота **@userinfobot**
2. Отправьте ему любое сообщение
3. Он ответит вашим числовым ID — вставьте его в `ADMIN_TG_IDS`

### Несколько админов

Перечислите ID через запятую без пробелов:

```env
ADMIN_TG_IDS=123456789,987654321
```

> **Важно:** порт в `DATABASE_URL` должен быть **5433** (внешний порт из `docker-compose.yml`), а не стандартный 5432.

---

## 5. Запуск PostgreSQL через Docker

```bash
docker compose up -d
```

Эта команда:
- Скачает образ `postgres:16-alpine` (только при первом запуске)
- Создаст контейнер `subordo_db`
- Запустит PostgreSQL на порту **5433** (внутри контейнера — 5432)
- Создаст базу данных `subordo_bot`

Проверьте, что контейнер запущен:

```bash
docker ps
```

Должен быть виден контейнер `subordo_db` со статусом `Up`:

```
CONTAINER ID   IMAGE                PORTS                    STATUS
abc123def456   postgres:16-alpine   0.0.0.0:5433->5432/tcp   Up 2 seconds
```

---

## 6. Применение миграций и генерация Prisma-клиента

```bash
npm run db:migrate
```

Эта команда:
- Сгенерирует Prisma-клиент (`@prisma/client`)
- Применит все миграции из `prisma/migrations/` к базе данных
- Создаст таблицы: `User`, `Spot`, `Board`, `Tariff`, `Rental`, `PaymentProof`, `AuditLog`, `Notification` и другие

Если Prisma спросит имя для миграции — просто нажмите Enter.

Успешный вывод выглядит примерно так:

```
Loaded Prisma config from prisma.config.ts.
Prisma schema loaded from prisma\schema.prisma
Datasource "db": PostgreSQL database "subordo_bot", schema "public" at "localhost:5433"

Already in sync, no migration needed.
```

---

## 7. Заполнение базы тестовыми данными (seed)

```bash
npm run db:seed
```

Seed-скрипт создаст:

| Что | Детали |
|---|---|
| **Точку проката** | «Ала-Арчинское водохранилище» |
| **Админа** | Пользователь с вашим `ADMIN_TG_IDS`, роль `ADMIN` |
| **10 досок** | `SUP-01` … `SUP-10`, статус `AVAILABLE` |
| **3 тарифа** | 1 час — 600 сом, 1.5 часа — 900 сом, 2 часа — 1200 сом |

Вывод:

```
Spot: Ала-Арчинское водохранилище
Admin user created/updated: id=1, tgId=123456789
Boards created: 10
Tariffs created: 3

Seed completed!
Deep link examples (QR codes):
  SUP-01 -> t.me/<BOT_USERNAME>?start=board_SUP-01
  SUP-02 -> t.me/<BOT_USERNAME>?start=board_SUP-02
  ...
```

---

## 8. Запуск бота

### Dev-режим (с автоперезагрузкой при изменении кода)

```bash
npm run dev
```

Использует `tsx watch` — при сохранении любого `.ts` файла бот перезапустится автоматически.

### Production-режим

```bash
npm run build   # компиляция TypeScript → JavaScript в папку dist/
npm start       # запуск скомпилированного кода
```

### Успешный запуск

В консоли появится:

```
✅ Bot @subordo_rental_bot started (runner mode)
```

---

## 9. Проверка работоспособности

1. Откройте Telegram
2. Найдите вашего бота по username
3. Отправьте `/start`
4. Должно появиться приветствие с inline-кнопками главного меню

**Для админа** — меню будет содержать:
- 📋 Панель управления
- 💳 Ожидающие оплаты
- 🏄 Доски
- 📊 Отчёты
- и другие пункты

**Для клиента** (любой другой пользователь):
- 🏄 Доступные доски
- 📋 Мои аренды
- 💬 Чат с поддержкой

---

## 10. Полезные команды

### npm-скрипты

| Команда | Описание |
|---|---|
| `npm run dev` | Запуск с hot-reload (`tsx watch`) |
| `npm run build` | Компиляция TS → JS в `dist/` |
| `npm start` | Запуск скомпилированного бота |
| `npm run db:generate` | Перегенерация Prisma-клиента |
| `npm run db:migrate` | Применить миграции (dev) |
| `npm run db:push` | Применить схему без миграции |
| `npm run db:seed` | Заполнить базу тестовыми данными |
| `npm run db:studio` | Открыть Prisma Studio (веб-UI для БД) |

### Prisma Studio

```bash
npm run db:studio
```

Откроется веб-интерфейс на `http://localhost:5555` для просмотра и редактирования данных в базе.

### Команды бота (в Telegram)

| Команда | Роль | Описание |
|---|---|---|
| `/start` | все | Приветствие + главное меню |
| `/start board_<CODE>` | все | Начать аренду доски по QR deep link |
| `/menu` | все | Открыть главное меню |
| `/add_admin <TG_ID>` | ADMIN | Назначить администратора |
| `/remove_admin <TG_ID>` | ADMIN | Снять роль администратора |
| `/set_mbank_qr` | ADMIN | Установить QR-код MBank (ответом на фото) |

---

## 11. Генерация QR-кодов

Для генерации QR-кодов для досок:

```bash
npx tsx scripts/generate-qr.ts
```

QR-коды будут сохранены в папку `qr-codes/`. Каждый QR содержит deep link:

```
https://t.me/<BOT_USERNAME>?start=board_<BOARD_CODE>
```

---

## 12. Остановка и перезапуск

### Остановить бота

Нажмите `Ctrl + C` в терминале, где запущен бот.

### Остановить PostgreSQL

```bash
docker compose down
```

> Данные сохранятся в Docker volume `pgdata`. При следующем `docker compose up -d` база будет на месте.

### Полная очистка (удаление данных)

```bash
docker compose down -v
```

> **Внимание:** флаг `-v` удалит volume с данными PostgreSQL. Все данные будут потеряны.

### Перезапуск всего

```bash
docker compose up -d        # БД
npm run dev                  # Бот
```

---

## 13. Решение типичных проблем

### ❌ `Missing required env variable: BOT_TOKEN`

Файл `.env` не найден или `BOT_TOKEN` не заполнен. Проверьте:
- Файл `.env` находится в корне проекта (`subordo_bot/.env`)
- Переменная `BOT_TOKEN` заполнена корректным токеном

### ❌ `P1001: Can't reach database server`

PostgreSQL не запущен. Решение:

```bash
docker compose up -d
docker ps  # проверить статус контейнера
```

### ❌ `P1002: The database server was reached but timed out`

PostgreSQL запущен, но занят или не успел стартовать. Решение:
1. Подождите 5–10 секунд после `docker compose up -d`
2. Проверьте, нет ли зависших подключений: `docker compose restart`
3. Повторите команду

### ❌ Порт 5433 занят

Другой процесс занимает порт. Варианты:
- Остановите конфликтующий процесс
- Измените порт в `docker-compose.yml` (строка `"5433:5432"`) и обновите `DATABASE_URL` в `.env`

### ❌ `409: Conflict: terminated by other getUpdates request`

Другой экземпляр бота уже запущен с тем же токеном. Остановите все другие экземпляры.

### ❌ `tsx: command not found`

`tsx` не установлен. Решение:

```bash
npm install
```

### ❌ Бот не отвечает в Telegram

1. Проверьте, что в консоли нет ошибок
2. Убедитесь, что бот запущен (`✅ Bot @... started`)
3. Проверьте, что токен актуален (не отозван через @BotFather)
4. Попробуйте `/start` — иногда Telegram кеширует состояние

---

## Краткий чеклист для быстрого старта

```bash
# 1. Установить зависимости
npm install

# 2. Скопировать и заполнить .env
cp .env.example .env
# → вписать BOT_TOKEN, DATABASE_URL (порт 5433!), ADMIN_TG_IDS

# 3. Поднять БД
docker compose up -d

# 4. Применить миграции
npm run db:migrate

# 5. Заполнить тестовые данные
npm run db:seed

# 6. Запустить бота
npm run dev
```

Готово! Бот должен ответить на `/start` в Telegram 🏄
