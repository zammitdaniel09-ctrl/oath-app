# Working on Oath

Oath is the owner's personal habit, task, food and health PWA. Replies to him are short; call him Boss.

## Refactor first

Before any big launch or update, split files over about 1,000 lines or mixing unrelated parts, and
remove dead code, in a commit that changes no behaviour (same tests, same screenshots against `main`).
Then do the work, so each piece fits in a small context. The last audit is `docs/audit-2026-10-29.md`.

- Front end: a page is a module with `initX(ctx)` and exported view, click and submit functions
  (see `public/plan.js`, `public/today-list.js`). `app.js` keeps the shell, routing and boot.
- Stylesheets are cut per page and linked in `public/index.html` in cascade order. Moving a rule to
  another file changes which rule wins; keep the order, or check every pair it jumps over.
- Server: pure parts (parsers, schema) go in their own module; the old module re-exports what it
  exported, so callers and tests stay the same.
- When moving code, carry its default imports too: Node's global `crypto` hides a missing
  `import crypto from 'node:crypto'` until `randomBytes` or `createHash` is called.

## Themes

- `public/theme.js` lists the themes and switches them; `index.html` applies the saved one before the first paint. A theme is `public/themes/<id>.css` (every selector under `:root[data-theme="<id>"]`, about 45 KB at most, only transform and opacity animate, at most one fixed background layer), `public/icons/themes/<id>/` and `public/themes/<id>.webmanifest`; its id also goes in `src/settings.js`.
- When base code needs a colour a theme must change, give it a variable with the old value as fallback (as `--mark-*` in `brandMark` and `--hp-area-*` in `review.js`), never a hard-coded colour in an inline style.
- A change to a shared component is seen in five looks: shoot it in each theme before calling it done.

## Rules

- The repository is public. Never commit personal data: body stats, birth date, emails, tokens,
  account IDs.
- Railway deploys `main` on every push, so a push to `main` is a release. Never push to `main` or
  deploy without his explicit OK: work on a branch, show screenshots, ask.
- No git identity is set: commit with `git -c user.name=Claude -c user.email=noreply@anthropic.com commit`
  and end the message with the Co-Authored-By line.
- Only stop processes your own work started.

## Releases

- Every deploy bumps `BUILD` in `public/app.js` and `CACHE` in `public/sw.js` together
  (`test/syntax.test.js` checks it).
- A new public file goes in `SHELL` in `public/sw.js`; a new stylesheet also gets its `<link>` in
  `public/index.html`, in cascade order.
- Run `node --check` on every edited file in `public/`: the server tests never load them, and a
  duplicate `const` once left the app blank on a fresh load.
- Never grow `PHOTO_SCHEMA` in `src/food-photo.js`: it sits at the API's structured-output size limit.

## Tests and preview

- `npm test` runs on embedded Postgres. After any `npm install`, run
  `npm i --no-save embedded-postgres@18.4.0-beta.17` again (npm prunes it).
- Set `OATH_PORT_SHIFT` (2500 by default) so parallel checkouts and a running preview do not share
  ports. Stop any preview on 4600 before the suite: test servers land on it at some shifts (2500, 3300) and the clash
  crashes test files and strands ports. A crashed run on Windows can leave a port listening with no process behind it;
  pick another shift rather than killing anything.
- `test/business.test.js` "refresh asks every site at once" can fail under load and passes alone.
- Preview: copy `../tools/preview-merged.mjs` into the repo as `preview-tmp.mjs` (never commit it, delete
  it when done) and run `node preview-tmp.mjs 4600`; it prints a session token. `PREVIEW_AT=10:00`
  pins the time of day. Screenshot at 402 px and 1440 px.
