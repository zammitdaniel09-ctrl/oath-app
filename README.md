# Oath

Personal habit tracker and daily accountability app for one person. It runs as a web app you add to the iPhone and iPad Home Screen, with push reminders, a strict HP system and a Claude-powered coach.

## How it works

- Every habit has a deadline. Miss it and you lose its HP (25 for non-negotiables, 10 for normal habits by default) and its streak resets.
- Once a deadline passes the habit is locked. Mistaken ticks can be undone for 10 minutes.
- Hard tasks cost 15 HP if not done by their deadline and cannot be deleted or moved once due.
- A clean day gives back 5 HP. At 0 HP you die: every streak is wiped and a new season starts.
- 2 pardons a month, each needing a written reason, usable within 24 hours of a miss.
- Rule changes to a habit that is still open today only take effect tomorrow.
- The server is the judge. It checks deadlines every 30 seconds and catches up on any days it missed while offline.

## Running on Railway

Variables on the app service:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `SETUP_CODE` | One-time code for the first password setup at `/setup?code=...` |
| `ANTHROPIC_API_KEY` | Turns on the AI coach. Optional; without it briefs use plain numbers. |
| `COACH_MODEL` | Optional, defaults to `claude-sonnet-5-5` |

Push notification keys are generated on first boot and stored in the database.

## Code

- `src/engine.js`: HP, misses, deaths, pardons, rule changes, the tick
- `src/state.js`: read models for the screens and the coach's snapshot
- `src/coach.js`: Claude chat with tools, morning brief and evening check
- `src/loop.js`: the 30-second loop, reminders and scheduled briefs
- `src/push.js`: Web Push
- `public/`: the web app (no build step)

## Tests

```
npm i --no-save embedded-postgres
npm test
```

The tests run the real rules against a real Postgres with a controllable clock.
