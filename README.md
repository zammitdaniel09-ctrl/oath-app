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

## Food

A food and drink diary in its own tab. It never touches HP and sets no targets.

- Log by search, a photo of anything (barcode, packet, nutrition label or plate), quick add, the drinks tray, or the shake, fruit bowl and plate builders. The coach can log too.
- Honest numbers: values nobody has sourced stay unknown, and a total that is missing some shows `+`. Photo readings of plates only estimate amounts; nutrition always comes from a catalogue record.
- Recipes (Oath's library and your own), cooked batches with their real weight, saved meals, plans that only count once eaten, and a coverage report against the content blueprint.
- Diary entries keep a copy of what was logged, so editing a food or recipe later never changes past days.

### Data and credits

- Generic foods: [USDA FoodData Central](https://fdc.nal.usda.gov/) (SR Legacy, April 2018, and Foundation Foods, April 2026), public domain (CC0). Refuse shares from USDA SR28. Built into `data/foods/usda-foods.json` by `scripts/build-usda.mjs` from the requirement maps in `data/foods/map`.
- UK foods: McCance and Widdowson's Composition of Foods Integrated Dataset (CoFID), Office for Health Improvement and Disparities. Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Built into `data/foods/cofid.json` by `scripts/build-cofid.mjs`.
- French and Mediterranean foods: [Ciqual](https://ciqual.anses.fr/), ANSES, under the Licence Ouverte / Etalab. Built into `data/foods/ciqual.json` by `scripts/build-ciqual.mjs`.
- Brands and chains: `data/foods/brands/*.json`, values as the brand or chain publishes them, each record with the URL it was read from. Checked by `node scripts/check-brands.mjs`.
- Products: [Open Food Facts](https://world.openfoodfacts.org/), © Open Food Facts contributors, under the [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/). Looked up by barcode or name when needed and cached in the database (never committed to the repo), within their rate limits.
- Recipes in `data/recipes` are original to Oath, AI-written and not kitchen-tested; their nutrition is worked out from the ingredient records. Check them with `node scripts/check-recipes.mjs`.
- The catalogue, requirement lists and recipes are seeded at boot when the data files change. Re-running the seed updates rows in place and never overwrites your own edits.
- `node scripts/import-off.mjs` imports products sold in Malta and the priority brands from Open Food Facts, slowly and resumably.

## Running on Railway

Variables on the app service:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `SETUP_CODE` | Code for the first password setup at `/setup?code=...`. Keep it: with Face ID only on, it is also the recovery code for logging in without Face ID |
| `ANTHROPIC_API_KEY` | Turns on the AI coach. Optional; without it briefs use plain numbers. |
| `COACH_MODEL` | Optional, defaults to `claude-sonnet-5-5` |

Push notification keys are generated on first boot and stored in the database.

Face ID login uses passkeys, which belong to the app's address (`PUBLIC_HOST`, else `RAILWAY_PUBLIC_DOMAIN`). If that address changes, log in with the password and turn Face ID on again in Settings.

## Code

- `src/engine.js`: HP, misses, deaths, pardons, rule changes, the tick
- `src/state.js`: read models for the screens and the coach's snapshot
- `src/coach.js`: Claude chat with tools, morning brief and evening check
- `src/food.js`, `src/food-recipes.js`, `src/food-history.js`, `src/food-seed.js`, `src/food-photo.js`, `src/off.js`: the food diary, meals and recipes, the Trends history, catalogue seeding, photo reading and Open Food Facts
- `src/calendar.js`, `src/ics.js`, `src/calendar-fetch.js`: feeds and events, the iCalendar parser, safe fetching
- `src/health.js`, `src/health-parse.js`: Apple Health storage and reads, and the export formats
- `public/nutrition.js`: the food maths, shared by the app and the server
- `src/loop.js`: the 30-second loop, reminders and scheduled briefs
- `src/push.js`: Web Push
- `public/`: the web app (no build step). `app.js` is the shell, routing and boot; each page is a module with `initX(ctx)` and its own view, click and submit functions (`today-list.js`, `plan.js`, `coach.js`, `food.js` and its `food-*.js` parts, and so on). `motion.js` decides what moves; sheets, row swipes and pull to refresh are in `motion-sheets.js` and `motion-touch.js`, built from `motion-core.js`. Stylesheets are cut per page and linked in `index.html` in cascade order: a new one goes where its rules belong in that order.
- Themes: `public/theme.js` holds the list, switches and saves the choice (the `theme` setting, so every device follows). Each theme is one stylesheet, `public/themes/<id>.css`, with every selector under `:root[data-theme="<id>"]`, loaded only while chosen. A new theme needs that file, an entry in `THEMES` and its id in `src/settings.js`.
- The app icon is one for every theme: `public/app-icon.js` draws it (moving on the login and lock screens and in Settings, `app-icon.css`), and the PNGs in `public/icons` are that drawing at rest, rendered by `../tools/themekit/render-app-icon.cjs`. Tape's dot-matrix face is built by `scripts/build-dot-font.mjs`.

**Refactor first.** Before any big launch or update, refactor first, in its own commit that changes no behaviour: split every file over about 1,000 lines or mixing unrelated parts, and remove dead code and copies. The same tests must pass and the screenshots must match. Only then start the work. This keeps every piece small enough to work on without excessive context. The passes so far are in `docs/audit-2026-10-29.md`.

## Tests

```
npm i --no-save embedded-postgres
npm test
```

The tests run the real rules against a real Postgres with a controllable clock.
