# kova-streak API (Cloudflare Worker + KV)

Discord-авторизация, хранение отметок, ежедневный дайджест в канал.

## Что нужно завести руками

### 1. Discord-приложение

`https://discord.com/developers/applications` -> New Application.

- Вкладка **OAuth2**: скопировать **Client ID**, нажать Reset Secret и скопировать **Client Secret**.
- Там же **Redirects** -> добавить ровно:
  `https://kova-streak-api.codebreakerstf.workers.dev/auth/callback`
- Скоупы в коде запрашиваются сами (`identify`, плюс `guilds` если задан GUILD_ID), в портале ничего выбирать не надо.

Свой Discord ID: в клиенте включить Settings -> Advanced -> Developer Mode, потом правый клик по себе -> Copy User ID.
ID сервера (для GUILD_ID): правый клик по иконке сервера -> Copy Server ID.

### 2. Вебхук для дайджеста

В нужном канале: Edit Channel -> Integrations -> Webhooks -> New Webhook -> Copy Webhook URL.

### 3. KV

```bash
wrangler kv namespace create KOVA
```

Полученный `id` вписать в `wrangler.jsonc`.

## Деплой

```bash
cd worker
wrangler kv namespace create KOVA
wrangler secret put DISCORD_CLIENT_SECRET
wrangler secret put SESSION_SECRET
wrangler secret put DISCORD_WEBHOOK_URL
wrangler deploy
```

`SESSION_SECRET` это любая длинная случайная строка, ей подписываются сессии.
Сгенерировать можно так:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Перед деплоем в `wrangler.jsonc` заменить `DISCORD_CLIENT_ID`, `ADMIN_DISCORD_IDS` и id KV.

## Эндпоинты

| Метод | Путь | Кто | Что делает |
|---|---|---|---|
| GET | `/auth/login?redirect=` | все | редирект на Discord |
| GET | `/auth/callback` | Discord | обмен кода, выдача сессии, редирект назад с `#token=` |
| GET | `/api/me` | сессия | payload сессии |
| GET | `/api/playlist` | все | плейлиста недели |
| PUT | `/api/playlist` | админ | публикация плейлисты |
| POST | `/api/completion` | сессия | отметка за день |
| GET | `/api/group?month=YYYY-MM` | сессия | календарь, стрики, лидерборд |

Cron `0 20 * * *` шлет дайджест в вебхук.

## Модель данных в KV

```
playlist:current              { weekLabel, shareCode, scenarios: [{name, requiredRuns}], updatedAt }
user:{discordId}              { displayName, avatar, joinedAt, joinedDate }
completion:{discordId}:{date} { completedRuns, requiredRuns, done, completedAt }
```

Значения продублированы в KV metadata (`n/a/j` у профилей, `c/r/d` у отметок),
поэтому групповой вид собирается двумя `list`-запросами без единого `get`.
Стрики и пропуски нигде не хранятся, они считаются на чтении.

## Локальная проверка

```bash
wrangler dev
```

OAuth локально не заработает без отдельного redirect URI, но `/api/playlist`
и `/api/group` проверяются сразу.
