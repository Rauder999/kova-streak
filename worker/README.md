# kova-streak API (Cloudflare Worker + KV)

Discord auth, check-in storage, daily digest posted to a channel.

## Manual setup

### 1. Discord application

`https://discord.com/developers/applications` -> New Application.

- **OAuth2** tab: copy the **Client ID**, press Reset Secret and copy the **Client Secret**.
- On the same tab, **Redirects** -> add exactly:
  `https://kova-streak-api.codebreakerstf.workers.dev/auth/callback`
- The code requests the scopes on its own (`identify`, plus `guilds` when GUILD_ID is set), nothing needs to be selected in the portal.

Your own Discord ID: in the client enable Settings -> Advanced -> Developer Mode, then right-click yourself -> Copy User ID.
Server ID (for GUILD_ID): right-click the server icon -> Copy Server ID.

### 2. Digest webhook

In the target channel: Edit Channel -> Integrations -> Webhooks -> New Webhook -> Copy Webhook URL.

### 3. KV

```bash
wrangler kv namespace create KOVA
```

Put the returned `id` into `wrangler.jsonc`.

## Deployment

```bash
cd worker
wrangler kv namespace create KOVA
wrangler secret put DISCORD_CLIENT_SECRET
wrangler secret put SESSION_SECRET
wrangler secret put DISCORD_WEBHOOK_URL
wrangler deploy
```

`SESSION_SECRET` is any long random string, it is used to sign sessions.
Generate one like this:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Before deploying, replace `DISCORD_CLIENT_ID`, `ADMIN_DISCORD_IDS` and the KV
id in `wrangler.jsonc`.

## Endpoints

| Method | Path | Who | What it does |
|---|---|---|---|
| GET | `/auth/login?redirect=` | everyone | redirects to Discord |
| GET | `/auth/callback` | Discord | exchanges the code, issues a session, redirects back with `#token=` |
| GET | `/api/me` | session | session payload |
| GET | `/api/playlist` | everyone | playlist of the week |
| PUT | `/api/playlist` | admin | publishes the playlist |
| POST | `/api/completion` | session | check-in for the day |
| GET | `/api/group?month=YYYY-MM` | session | calendar, streaks, leaderboard |

The cron `0 0 * * *` (18:00 Denver time in summer) sends the digest to the
webhook. Manual send: POST `/api/digest` (admin) or the button in the Admin tab.

## KV data model

```
playlist:current              { weekLabel, shareCode, scenarios: [{name, requiredRuns}], updatedAt }
user:{discordId}              { displayName, avatar, joinedAt, joinedDate }
completion:{discordId}:{date} { completedRuns, requiredRuns, done, completedAt }
```

The values are duplicated into KV metadata (`n/a/j` on profiles, `c/r/d` on
check-ins), so the group view is assembled with two `list` requests and zero
`get` calls. Streaks and missed days are not stored anywhere, they are
computed at read time.

## Local testing

```bash
wrangler dev
```

OAuth will not work locally without a separate redirect URI, but
`/api/playlist` and `/api/group` can be tested right away.
