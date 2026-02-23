# eto-mcp

Remote MCP server на Node.js + TypeScript для поиска туров через Tourvisor.

## Стек

- fastify
- zod
- undici
- @modelcontextprotocol/sdk
- pino

## Возможности

- `GET /health` -> `{ "ok": true }`
- `POST /mcp` -> remote MCP endpoint
- Auth для `/mcp` по заголовку `X-API-Key`
- Rate limit: `30 req/min` на IP
- In-memory cache на `60s` (ключ: `JSON.stringify(input)`)

## MCP tool

Tool: `search_tours`

Входная схема (`zod`):

- `country_id: number` (обяз.)
- `departure_id: number` (обяз.)
- `date_from: string` (`YYYY-MM-DD`, обяз.)
- `date_to: string` (`YYYY-MM-DD`, обяз.)
- `nights_min: number` (обяз.)
- `nights_max: number` (обяз.)
- `adults: number` (обяз.)
- `children: number` (обяз., `0..4`)
- `budget_max: number` (опц., default `0`)
- `meal: number` (опц., default `0`)
- `rating: number` (опц., default `0`)

Выход:

```json
{
  "requestid": "string",
  "results": [],
  "meta": {
    "timed_out": false,
    "polls": 3,
    "ms": 4512
  }
}
```

## Переменные окружения

- `API_KEY` (обяз.)
- `PORT` (опц., по умолчанию `3000`)
- `HOST` (опц., по умолчанию `0.0.0.0`)
- `LOG_LEVEL` (опц., по умолчанию `info`)

Секреты в коде не хранятся.

## Mock-режим (без внешних API)

В mock каждый тур содержит `country_name`, `city_name`, `flag_emoji` и может содержать `image_url` из локальной статики (`/assets/hotels/...`), чтобы бот мог отправлять фото без внешних API.
Демо-направления (MVP) и `country_id`:

- `47` -> Turkey `🇹🇷`
- `54` -> Egypt `🇪🇬`
- `29` -> Thailand `🇹🇭`
- `63` -> UAE `🇦🇪`
- `90` -> Maldives `🇲🇻`
- `91` -> Seychelles `🇸🇨`

Положи изображения в `/Users/user/Documents/eto_mcp/public/assets/hotels/` по шаблону:

- `/assets/hotels/turkey/turkey_01.jpg` ... `turkey_04.jpg`
- `/assets/hotels/egypt/egypt_01.jpg` ... `egypt_04.jpg`
- `/assets/hotels/thailand/thailand_01.jpg` ... `thailand_04.jpg`
- `/assets/hotels/uae/uae_01.jpg` ... `uae_04.jpg`
- `/assets/hotels/maldives/maldives_01.jpg` ... `maldives_04.jpg`
- `/assets/hotels/seychelles/seychelles_01.jpg` ... `seychelles_04.jpg`

Запуск mock-провайдера:

```bash
API_KEY=devkey DATA_PROVIDER=mock npm run dev
```

Запуск автотестов:

```bash
bash scripts/test_requests.sh
```

## Telegram-ready output

`search_tours` возвращает в `content.text` уже готовый HTML-текст для Telegram.

Это можно отправлять напрямую в Telegraf с `parse_mode="HTML"`:

```ts
ctx.reply(text, { parse_mode: "HTML" });
```

## Telegram MVP bot (Telegraf)

Добавлен MVP-бот с лидогенерацией:

1. `/start` -> кнопка `🔎 Найти тур`
2. Выбор страны (Turkey/Egypt/Thailand/UAE/Maldives/Seychelles)
3. Быстрые фильтры: бюджет, качество (звезды), период, питание
4. Выдача 3–5 карточек туров (фото + HTML caption)
5. Под каждой карточкой только `💚 Хочу этот тур`
6. После выдачи отдельное сообщение с `🔁 Показать ещё`, `⚙️ Изменить фильтры`, `🔎 Новый поиск`
7. По нажатию `💚 Хочу этот тур` бот просит ввести телефон вручную (без `request_contact`), валидирует (MVP: только РФ `+7XXXXXXXXXX`; `8XXXXXXXXXX` и `7XXXXXXXXXX` нормализуются в `+7`) и сохраняет лид в `data/leads.jsonl`

Переменные окружения для бота:

- `TELEGRAM_BOT_TOKEN` (обязательно)
- `API_KEY` (для вызова локального `/mcp`, по умолчанию `devkey`)
- `MCP_BASE_URL` (по умолчанию `http://127.0.0.1:3000`)
- `PUBLIC_BASE_URL` (опционально, если нужен публичный базовый URL для картинок)

Запуск:

```bash
API_KEY=devkey DATA_PROVIDER=mock npm run dev
TELEGRAM_BOT_TOKEN=xxx API_KEY=devkey MCP_BASE_URL=http://127.0.0.1:3000 npm run bot
```

Просмотр последних лидов:

```bash
bash scripts/leads_tail.sh
```

Как протестировать сбор лида вручную:

1. Нажми `💚 Хочу этот тур`
2. Бот пришлёт recap и попросит ввести номер текстом (`+79991234567`)
3. Поддерживаются форматы `+7...`, `8...` (нормализуется в `+7...`), и международные `+31...`
4. Если номер невалиден, бот попросит повторить с примером
5. `Отмена` возвращает к кнопкам управления выдачей (`Показать ещё / Изменить фильтры / Новый поиск`)

## Локальный запуск

```bash
npm install
API_KEY=your-secret npm run dev
```

Проверка:

```bash
curl http://localhost:3000/health
```

## Сборка

```bash
npm run build
npm start
```

## Docker

Сборка образа:

```bash
docker build -t eto-mcp:latest .
```

Запуск контейнера:

```bash
docker run --rm -p 3000:3000 -e API_KEY=your-secret eto-mcp:latest
```

## Примечание по Tourvisor

Интеграция использует:

1. `createSearch(params)` -> `GET https://tourvisor.ru/xml/modsearch.php`
2. `fetchResult(requestid)` -> `GET https://search3.tourvisor.ru/modresult.php`
3. `pollResults(requestid)` -> polling каждые `1500ms` до `20s`
4. `normalize(raw)` -> `TourResult[]`

Поля ответа Tourvisor могут отличаться по средам/тарифам API, поэтому в `normalize` добавлены fallback-ключи и возврат `raw` в каждом результате.
