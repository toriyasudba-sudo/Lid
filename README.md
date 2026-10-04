# TORIYA NOVA — LID / Mini App

Чистая версия проекта. Старые `wrangler.jsonc`, старые index-файлы и старый `app.js` сюда намеренно НЕ входят.

## Структура

- `public/index.html` — текущий интерфейс Mini App
- `public/app.js` — вся логика экранов, Business Scan, Telegram API и консультации
- `worker.js` — Cloudflare Worker + D1 + проверка подписки + API
- `wrangler.lid.jsonc` — единственная конфигурация деплоя
- `0001_initial.sql` — схема D1
- `package.json`

Видео не включены. Положи в `public/` существующие файлы:
- `01_START_TORIYA.mp4`
- `02_OBJECTION_SELF_BUILD.mp4` (в этой версии экран возражения не используется, но файл можно оставить)
- `03_FINAL_TORIYA.mp4`

## Деплой

В Cloudflare Workers Build command используй ровно:

`npx wrangler deploy --config wrangler.lid.jsonc`

Не используй `wrangler.jsonc` — его в этом проекте нет специально.

## Cloudflare

Worker: `lid`

D1: `toriya-nova-mini-app`

D1 ID: `403bec72-57da-4777-9070-135b51767b33`

Нужен secret:

`BOT_TOKEN`

Токен в репозиторий не класть.

## Telegram

Mini App URL:

`https://lid.toriya-sudba.workers.dev/v2/`

Канал:

`@tori_ya_nova`

Консультация:

`https://t.me/toriya_nova`

## Важно

`/`, `/index.html`, `/v2` и `/v2/` Worker принудительно отдают текущий `public/index.html` с no-cache заголовками.

API принимает Telegram `initData` и из заголовка, и из JSON body — это сделано специально, чтобы авторизация не зависела от одного способа передачи.
