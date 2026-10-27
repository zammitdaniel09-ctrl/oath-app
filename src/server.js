import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { connect, migrate, close as closeDb } from './db.js';
import { validTime, validDate } from './time.js';
import * as auth from './auth.js';
import * as engine from './engine.js';
import { buildToday, buildPlan, buildLedger, buildReview, buildSeason } from './state.js';
import * as goals from './goals.js';
import { captureTask, createToken, revokeTokens, tokenCount, tokenValid, keyShapeOk, refusedKeyReason, doneByText, nextSay } from './capture.js';
import { prepareReview, finishReview } from './review.js';
import { db } from './db.js';
import { vapidKeys, saveSubscription, removeSubscription, sendPush, subscriptionCount } from './push.js';
import { chat, coachHistory, generateBrief, aiEnabled, checkCoach, resolvePending } from './coach.js';
import { applySettings } from './settings.js';
import { startLoop, runOnce, healIfEmpty } from './loop.js';
import * as drive from './drive.js';
import { healthApi, healthShortcut } from './health.js';
import { calendarApi, calendarPublic } from './calendar.js';
import { businessApi } from './business.js';
import { initTelegram, telegramStatus, createLink, unlink, sendTelegram, handleUpdate, webhookAllowed } from './telegram.js';
import { setupStatus, noteIngestError } from './setup.js';
import { foodApi, saveCustomFood } from './food.js';
import { bodyApi } from './body.js';
import { ensureFoodSeed } from './food-seed.js';
import { readFoodPhoto, readFoodText } from './food-photo.js';
import { foodTake } from './food-take.js';
import { productByBarcode, searchOff } from './off.js';
import * as passkeys from './passkeys.js';
import { conditionalGet, publicFile } from './static.js';

const PUBLIC = './public';
const v = { validTime, validDate };
const app = new Hono();

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Frame-Options', 'DENY');
  // The camera is the app's own, for the live barcode scanner; no frame or other site gets it.
  c.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
});

// A failed Shortcuts or Health Auto Export request is noted on the setup list so Daniel can see what
// went wrong. Anyone can send a bad key, so only one of the right shape is noted (and the note is
// rate-limited): the rest is noise that must not overwrite a real diagnostic.
async function noteShortcutFailure(c, status, reason) {
  if (!keyShapeOk(c.req.header('authorization'))) return;
  await noteIngestError(c.req.path, status, reason).catch(() => {});
}

// Mutating API calls must be JSON, which a cross-site form cannot send without a preflight.
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' && !(c.req.header('content-type') || '').includes('application/json')) {
    if (c.req.path.startsWith('/api/shortcut')) await noteShortcutFailure(c, 415, 'The request body was not sent as JSON.');
    return c.json({ error: 'Send JSON.' }, 415);
  }
  await next();
});

app.onError(async (err, c) => {
  if (err instanceof engine.RuleError) return c.json({ error: err.message }, err.status);
  if (await healIfEmpty(err).catch(() => false)) {
    return c.json({ error: 'The database was just reset and has been rebuilt. Try again.' }, 503);
  }
  console.error(err);
  return c.json({ error: 'Something broke on the server. Check the Railway logs.' }, 500);
});

const body = async (c) => {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
};
const idParam = (c) => {
  const id = Number.parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id)) throw new engine.RuleError('Bad id.');
  return id;
};

app.get('/healthz', (c) => c.text('ok'));

// ---------- Session ----------
app.get('/api/session', async (c) => {
  const authed = await auth.isAuthed(c);
  const faceIdOnly = await auth.faceIdOnly();
  return c.json({
    authed,
    setupDone: await auth.ownerExists(),
    faceId: (await passkeys.passkeyCount()) > 0,
    faceIdOnly,
    locked: faceIdOnly && !authed && (await auth.hasSession(c)),
  });
});
// The app locks its own session on every open, so Face ID is asked for each time.
app.post('/api/lock', async (c) => {
  await auth.lockSession(c);
  return c.json({ ok: true });
});
// Face ID login, before there is a session.
app.post('/api/passkey/login/options', async (c) => c.json(await passkeys.loginOptions(c)));
app.post('/api/passkey/login', async (c) => {
  const r = await auth.passkeyLogin(c, (await body(c)).response);
  return r.error ? c.json({ error: r.error }, r.status) : c.json({ ok: true });
});
app.post('/api/setup', async (c) => {
  const r = await auth.setup(c, await body(c));
  return r.error ? c.json({ error: r.error }, r.status) : c.json({ ok: true });
});
app.post('/api/login', async (c) => {
  const r = await auth.login(c, await body(c));
  return r.error ? c.json({ error: r.error }, r.status) : c.json({ ok: true });
});
app.post('/api/logout', async (c) => {
  await auth.logout(c);
  return c.json({ ok: true });
});

// ---------- Siri and Shortcuts (personal token, no cookie) ----------
const shortcut = new Hono();
shortcut.use('*', async (c, next) => {
  if (!(await tokenValid(c.req.header('authorization'))) && !(await auth.isAuthed(c))) {
    await noteShortcutFailure(c, 401, refusedKeyReason(c.req.header('authorization')));
    return c.json({ error: 'Bad token.', say: 'Oath did not accept the token. Make a new one in Oath settings.' }, 401);
  }
  await next();
});
shortcut.onError(async (err, c) => {
  await noteIngestError(c.req.path, err.status || 500, err instanceof engine.RuleError ? err.message : 'Server error').catch(() => {});
  if (err instanceof engine.RuleError) return c.json({ error: err.message, say: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Server error', say: 'Oath hit an error. Try again in the app.' }, 500);
});
shortcut.post('/add', async (c) => {
  const r = await captureTask((await body(c)).text, 'siri');
  return c.json({ ok: true, say: r.say, task: { id: r.task.id, title: r.task.title, due: r.task.due_date, deadline: r.task.deadline } });
});
shortcut.post('/done', async (c) => c.json(await doneByText((await body(c)).text)));
shortcut.get('/next', async (c) => c.json(await nextSay()));
shortcut.route('/', healthShortcut); // POST /api/shortcut/health: Health Auto Export or the free Shortcut
app.route('/api/shortcut', shortcut);
app.route('/', calendarPublic); // /ical/<secret>.ics, for Apple Calendar to subscribe to

const api = new Hono();
api.use('*', auth.requireAuth());

api.get('/today', async (c) => c.json(await buildToday()));
api.get('/plan', async (c) => c.json(await buildPlan()));
api.get('/ledger', async (c) => c.json(await buildLedger()));
api.get('/season', async (c) => c.json(await buildSeason()));
api.get('/review', async (c) => c.json(await buildReview()));
api.post('/review/write', async (c) => c.json(await prepareReview()));
api.post('/review/finish', async (c) => c.json(await finishReview(await body(c))));

// ---------- Capture ----------
api.post('/capture', async (c) => c.json(await captureTask((await body(c)).text, 'you')));
api.get('/tokens', async (c) => c.json({ count: await tokenCount() }));
api.get('/setup-status', async (c) => c.json(await setupStatus()));

// ---------- Face ID ----------
api.get('/passkeys', async (c) => c.json({ passkeys: await passkeys.listPasskeys() }));
api.post('/passkey/register/options', async (c) => c.json(await passkeys.registrationOptions(c)));
api.post('/passkey/register', async (c) => {
  const r = await passkeys.registerPasskey(c, await body(c));
  await auth.unlockSession(c);
  return c.json(r);
});
api.delete('/passkeys/:id', async (c) => c.json(await passkeys.removePasskey(c.req.param('id'))));
api.post('/tokens', async (c) => c.json(await createToken((await body(c)).label)));
api.delete('/tokens', async (c) => c.json(await revokeTokens()));

// ---------- Goals and maps ----------
api.get('/goals', async (c) => c.json({ goals: await goals.listGoals({ includeClosed: c.req.query('all') === '1' }) }));
api.post('/goals', async (c) => c.json(await goals.createGoal(await body(c))));
api.get('/goals/:id', async (c) => c.json(await goals.getGoal(idParam(c))));
api.patch('/goals/:id', async (c) => c.json(await goals.updateGoal(idParam(c), await body(c))));
api.post('/goals/:id/status', async (c) => c.json(await goals.setGoalStatus(idParam(c), (await body(c)).status)));
api.post('/goals/:id/log', async (c) => {
  const b = await body(c);
  return c.json(await goals.logGoal(idParam(c), b.value, b.note));
});
api.post('/goals/:id/nodes', async (c) => c.json(await goals.addNode(idParam(c), await body(c))));
api.patch('/nodes/:id', async (c) => c.json(await goals.updateNode(idParam(c), await body(c))));
api.post('/nodes/:id/move', async (c) => c.json(await goals.moveNode(idParam(c), (await body(c)).op)));
api.delete('/nodes/:id', async (c) => c.json(await goals.deleteNode(idParam(c))));
api.post('/nodes/:id/convert', async (c) => {
  const b = await body(c);
  return c.json(await goals.convertNode(idParam(c), b.to, b.options || {}));
});
api.post('/nodes/:id/toggle', async (c) => c.json(await goals.toggleNodeTask(idParam(c))));

// ---------- Rest days ----------
api.get('/rest', async (c) => c.json({ days: await engine.listRest() }));
api.post('/rest', async (c) => {
  const b = await body(c);
  return c.json(await engine.bookRest(b.date, b.reason));
});
api.delete('/rest/:date', async (c) => c.json(await engine.cancelRest(c.req.param('date'))));

// ---------- Export: everything, as one JSON file ----------
const EXPORT_TABLES = ['habits', 'completions', 'tasks', 'misses', 'days', 'reflections', 'deferrals', 'focus_sessions',
  'day_plans', 'goals', 'goal_logs', 'nodes', 'rest_days', 'weekly_reviews', 'coach_messages', 'briefs', 'events',
  'health_samples', 'health_workouts', 'cal_events', 'oath_events', 'food_log', 'food_meals', 'food_batches', 'food_plans'];
api.get('/export', async (c) => {
  const out = { exportedAt: new Date().toISOString(), app: 'Oath' };
  for (const t of EXPORT_TABLES) out[t] = await db().unsafe(`select * from ${t} order by 1`);
  out.food_items_yours = await db()`select * from food_items where kind in ('custom', 'label') order by id`;
  out.recipes_yours = await db()`select r.*, (select json_agg(l order by l.sort) from recipe_lines l where l.recipe_id = r.id) as lines from recipes r where source = 'you' order by id`;
  out.game = (await db()`select value from kv where key = 'game'`)[0]?.value || null;
  out.settings = (await db()`select value from kv where key = 'settings'`)[0]?.value || null;
  c.header('Content-Disposition', `attachment; filename="oath-export-${new Date().toISOString().slice(0, 10)}.json"`);
  return c.json(out);
});

// ---------- Habits ----------
api.post('/habits', async (c) => c.json(await engine.createHabit(await body(c), v)));
api.patch('/habits/:id', async (c) => c.json(await engine.updateHabit(idParam(c), await body(c), v)));
api.delete('/habits/:id', async (c) => c.json(await engine.archiveHabit(idParam(c))));
api.post('/habits/:id/restore', async (c) => c.json(await engine.restoreHabit(idParam(c))));
api.post('/habits/:id/keep', async (c) => {
  const id = idParam(c);
  const b = await body(c);
  const r = await engine.completeHabit(id, { note: b.note, minimum: b.minimum });
  await drive.closeFocusFor('habit', id);
  return c.json({ ok: true, comeback: r.comeback || 0, reaction: await drive.reactionAfterDone('habit', id, { comeback: r.comeback, minimum: r.minimum }) });
});
api.post('/habits/:id/undo', async (c) => c.json(await engine.undoHabit(idParam(c))));

// ---------- Tasks ----------
api.post('/tasks', async (c) => c.json(await engine.createTask(await body(c), v)));
api.patch('/tasks/:id', async (c) => c.json(await engine.updateTask(idParam(c), await body(c), v)));
api.delete('/tasks/:id', async (c) => c.json(await engine.deleteTask(idParam(c))));
api.post('/tasks/:id/done', async (c) => {
  const id = idParam(c);
  await engine.completeTask(id);
  await drive.closeFocusFor('task', id);
  return c.json({ ok: true, reaction: await drive.reactionAfterDone('task', id) });
});
api.post('/tasks/:id/undo', async (c) => c.json(await engine.undoTask(idParam(c))));
api.post('/tasks/:id/triage', async (c) => c.json(await engine.triageTask(idParam(c), (await body(c)).action)));

// ---------- The daily drive ----------
api.post('/oath', async (c) => c.json(await drive.commitDay(await body(c))));
api.post('/focus', async (c) => c.json(await drive.startFocus(await body(c))));
api.post('/focus/:id/finish', async (c) => c.json(await drive.finishFocus(idParam(c), (await body(c)).outcome)));
api.post('/defer', async (c) => c.json(await drive.defer(await body(c))));
api.post('/reflection', async (c) => c.json(await drive.reflect(await body(c))));

// ---------- Telegram ----------
api.get('/telegram', async (c) => c.json(await telegramStatus()));
api.post('/telegram/link', async (c) => c.json(await createLink()));
api.post('/telegram/unlink', async (c) => {
  await unlink();
  return c.json({ ok: true });
});
api.post('/telegram/test', async (c) => {
  const sent = await sendTelegram({ title: 'Test from Oath', body: 'Telegram works. Reminders and briefs will land here too.' });
  return c.json({ sent });
});

// ---------- Pardons ----------
api.post('/misses/:id/pardon', async (c) => {
  const b = await body(c);
  const r = await engine.pardon(idParam(c), { reason: b.reason, plan: b.plan });
  return c.json(r);
});

// ---------- Push ----------
api.get('/push/key', async (c) => c.json({ publicKey: (await vapidKeys()).publicKey, devices: await subscriptionCount() }));
api.post('/push/subscribe', async (c) => {
  const fresh = await saveSubscription(await body(c));
  return c.json({ ok: true, fresh, devices: await subscriptionCount() });
});
api.post('/push/unsubscribe', async (c) => {
  const { endpoint } = await body(c);
  if (endpoint) await removeSubscription(endpoint);
  return c.json({ ok: true });
});
api.post('/push/test', async (c) => {
  const sent = await sendPush({ title: 'Test from Oath', body: 'Notifications work on this device.', tag: 'test' });
  return c.json({ sent });
});

// ---------- Coach ----------
api.get('/coach', async (c) => c.json({ messages: await coachHistory(), aiEnabled: aiEnabled() }));
api.post('/coach', async (c) => c.json({ reply: await chat((await body(c)).text) }));
// The coach's destructive actions wait here until Daniel confirms or cancels them.
api.post('/coach/pending/:id', async (c) => c.json(await resolvePending(idParam(c), Boolean((await body(c)).confirm))));
api.post('/briefs/:kind', async (c) => {
  const kind = c.req.param('kind');
  if (!['morning', 'midday', 'evening'].includes(kind)) throw new engine.RuleError('Unknown brief.');
  return c.json(await generateBrief(kind));
});

// ---------- Settings ----------
api.get('/settings', async (c) => c.json(await engine.getSettings()));
api.patch('/settings', async (c) => c.json(await applySettings(await body(c))));
api.post('/password', async (c) => {
  const b = await body(c);
  const r = await auth.changePassword(b.current, b.next);
  return r.error ? c.json({ error: r.error }, r.status) : c.json({ ok: true });
});

// ---------- Your data: Apple Health, calendars, business sites ----------
api.route('/', healthApi);
api.route('/', calendarApi);
api.route('/', businessApi);

// ---------- Food ----------
// Photo of anything: barcode, packet, label or plate. The photo is read and dropped, never stored.
api.post('/food/photo', async (c) => c.json(await readFoodPhoto(await body(c))));
// "What did you eat?": typed words become catalogue matches with estimated amounts, never logged unseen.
api.post('/food/describe', async (c) => c.json(await readFoodText(await body(c))));
api.post('/food/label', async (c) => c.json(await saveCustomFood(await body(c), { fromLabel: true })));
api.get('/food/barcode/:code', async (c) => c.json({ item: await productByBarcode(c.req.param('code')) }));
api.get('/food/off-search', async (c) => c.json({ items: await searchOff(c.req.query('q')) }));
// The coach's take on the Food tab or Trends, kept until the numbers behind it change.
api.get('/food/take', async (c) => c.json(await foodTake({ view: c.req.query('view'), date: c.req.query('date'), days: c.req.query('days') })));
api.route('/', foodApi);
api.route('/', bodyApi);

app.route('/api', api);

// Telegram calls this; it proves itself with the secret token set when the webhook was registered.
app.post('/telegram/webhook', async (c) => {
  if (!(await webhookAllowed(c.req.header('x-telegram-bot-api-secret-token')))) return c.text('forbidden', 403);
  const update = await c.req.json().catch(() => null);
  if (update && typeof update.update_id === 'number') {
    handleUpdate(update).catch((err) => console.error('telegram update failed', err));
  }
  return c.text('ok');
});
app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));

// ---------- Web app ----------
app.use('/sw.js', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-cache');
  c.header('Service-Worker-Allowed', '/');
});
// The app's own code and pages are always revalidated, so a deploy shows up on the next open.
app.use('*', async (c, next) => {
  await next();
  const p = c.req.path;
  if (p === '/' || /\.(js|css|html|webmanifest)$/.test(p)) c.header('Cache-Control', 'no-cache');
});
// A file the browser already has answers 304 (ETag and If-Modified-Since), so opening the app does not
// download every file again. The no-cache above still makes it ask every time.
app.use('*', conditionalGet((c) => publicFile(PUBLIC, c.req.path)));
app.use('*', serveStatic({ root: PUBLIC }));
app.get('*', conditionalGet(() => publicFile(PUBLIC, '/index.html')), serveStatic({ path: `${PUBLIC}/index.html` }));

export { app };

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  connect();
  await migrate();
  await engine.ensureGame();
  await vapidKeys();
  initTelegram().catch((err) => console.error('telegram init failed:', err.message));
  checkCoach();
  ensureFoodSeed().catch((err) => console.error('food seed failed:', err.message));
  const port = Number(process.env.PORT || 3000);
  const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => console.log(`Oath listening on ${port}`));
  const loop = startLoop();
  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down`);
    clearInterval(loop);
    server.close();
    await closeDb().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export { runOnce };
