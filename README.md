# TORIYA NOVA — Mini App (new standalone project)

Это **новый самостоятельный проект**. Он не зависит от `TORIYA-NOVA-BUSINESS-LAB` и не использует его Worker, базу или конфигурацию.

## Что внутри

- `public/index.html` — Mini App с текущей игровой логикой TORIYA NOVA.
- `public/app.js` — аналитика событий и Telegram WebApp integration.
- `public/01_START_TORIYA.mp4` — стартовое видео.
- `public/02_OBJECTION_SELF_BUILD.mp4` — видео про возражение.
- `public/03_FINAL_TORIYA.mp4` — финальное видео.
- `worker.js` — новый Cloudflare Worker.
- `migrations/0001_initial.sql` — новая D1-схема.
- `wrangler.jsonc` — конфигурация Worker + D1 + Cron.

## События

`START`, `SCREEN_VIEW`, `CLICK`, `VIDEO_PLAY`, `RESULT_SHOWN`, `LIVE_USER_VIEWED`, `ANALYTICS_VIEWED`, `RETURN_LOGIC_VIEWED`, `OBJECTION_VIEWED`, `ARCHITECTURE_VIEWED`, `GIFT_OPENED`, `FINAL_VIEWED`, `CTA_15000_CLICK`, `CTA_30000_CLICK`.

## Что понадобится один раз при публикации

1. Создать новый Cloudflare D1 database с именем `toriya-nova-mini-app`.
2. Вставить его `database_id` в `wrangler.jsonc`.
3. Создать Worker secret `BOT_TOKEN`.
4. Задать `OWNER_CHAT_ID` и после первого deploy заменить `MINI_APP_URL` на URL Worker.
5. Применить миграцию `migrations/0001_initial.sql`.
6. Запустить deploy.

## Важно

`BOT_TOKEN` **не хранится в файлах** и не должен попадать в чат, GitHub или frontend.

Напоминания работают через Cron Trigger Worker. Пользователь должен открыть Mini App из Telegram, а Mini App запрашивает у Telegram разрешение на отправку сообщений боту, когда это доступно.

## API

- `GET /health`
- `POST /api/event`
- `GET /api/stats` — требует заголовок `x-admin-key` или query `?key=`.
