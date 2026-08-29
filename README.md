# kova-streak

A group daily-training streak tracker for KovaaK's. You play the playlist of
the week, the site sees it in your stats folder and marks the day for you.
There is no "I did it" button.

Ranking is based on the number of missed days, not on score: a weaker aimer
does not lose to a stronger one, the winner is whoever shows up every day.

## How it works

1. An admin imports the playlist JSON from `FPSAimTrainer\Saved\SaveGames\Playlists`
   and publishes it to KV. This is the single source of truth for the whole group.
2. A player logs in with Discord and, once per session, grants access to the
   `FPSAimTrainer\FPSAimTrainer\stats` folder.
3. The tab stays open; every 5 seconds the site re-reads the folder listing,
   counts today's runs for each scenario and checks them against `play_Count`.
4. At 100% the day is automatically submitted to the backend. Partial progress
   is submitted too, at most once per minute, so the group can see who is
   getting close.
5. At 18:00 group time (00:00 UTC) the worker posts the daily digest to the
   Discord channel: who cleared the day, who is on scheduled leave, who did
   not finish, and who has gone silent.

A day is detected from file names alone: KovaaK's writes
`{Scenario} - Challenge - YYYY.MM.DD-HH.MM.SS Stats.csv` after EVERY run, and
the timestamp is the completion time. CSV contents are never read at all, so
scanning a folder with 1700+ files costs next to nothing.

## Structure

```
index.html          three tabs: Today, Group, Admin
css/style.css       Obsidian Signal tokens, shared with AIMSOMA
js/parser.js        stats file name parsing, local dates
js/fs.js            File System Access API, run counting, playlist matching
js/db.js            IndexedDB, persists the folder handle between sessions
js/auth.js          Discord session
js/api.js           worker client
js/app.js           state, polling, auto check-in, rendering
worker/             Cloudflare Worker + KV, see worker/README.md
```

## Running locally

```bash
python serve.py 8080
```

The File System Access API requires a secure context; `localhost` qualifies,
a file opened via `file://` does not. Desktop Chrome or Edge only.

To run the frontend against a local worker:

```js
localStorage.setItem('kova-streak-api', 'http://127.0.0.1:8787')
```

## Deployment

- Frontend: GitHub Pages, repository `rauder999.github.io/kova-streak`.
- Backend: `cd worker && wrangler deploy`, instructions and the list of
  secrets are in [worker/README.md](worker/README.md).

The origins the worker accepts requests from are hardcoded in
`ALLOWED_ORIGINS` in `worker/worker.js`.

## Manual setup before the first run

1. A Discord application (Client ID, Client Secret, Redirect URI).
2. A webhook in the channel for the daily digest.
3. A KV namespace.
4. Put your own Discord ID into `ADMIN_DISCORD_IDS` in `worker/wrangler.jsonc`,
   otherwise nobody gets the Admin tab.

Step-by-step instructions for all of this are in
[worker/README.md](worker/README.md).
