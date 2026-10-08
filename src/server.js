import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { IANAZone } from 'luxon';
import { connect, migrate, close as closeDb } from './db.js';
import { validTime, validDate } from './time.js';
import * as auth from './auth.js';
import * as engine from './engine.js';
import { buildToday, buildPlan, buildLedger, buildReview } from './state.js';
import * as goals from './goals.js';
import { captureTask, createToken, revokeTokens, tokenCount, tokenValid, doneByText, nextSay } from './capture.js';
import { prepareReview, finishReview } from './review.js';
import { db } from './db.js';
import { vapidKeys, saveSubscription, removeSubscription, sendPush, subscriptionCount } from './push.js';
import { chat, coachHistory, generateBrief, aiEnabled, checkCoach } from './coach.js';
import { startLoop, runOnce, healIfEmpty } from './loop.js';
import * as drive from './drive.js';
import { healthApi, healthShortcut } from './health.js';
import { calendarApi } from './calendar.js';
import { businessApi } from './business.js';
import { initTelegram, telegramStatus, createLink, unlink, sendTelegram, handleUpdate, webhookSecret } from './telegram.js';

const v = { validTime, validDate };
const app = new Hono();

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
});

// Mutating API calls must be JSON, which a cross-site form cannot send without a preflight.
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'GET' && !(c.req.header('content-type') || '').includes('application/json')) {
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
app.get('/api/session', async (c) => c.json({ authed: await auth.isAuthed(c), setupDone: await auth.ownerExists() }));
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
    return c.json({ error: 'Bad token.', say: 'Oath did not accept the token. Make a new one in Oath settings.' }, 401);
  }
  await next();
});
shortcut.onError((err, c) => {
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

const api = new Hono();
api.use('*', auth.requireAuth());

api.get('/today', async (c) => c.json(await buildToday()));
api.get('/plan', async (c) => c.json(await buildPlan()));
api.get('/ledger', async (c) => c.json(await buildLedger()));
api.get('/review', async (c) => c.json(await buildReview()));
api.post('/review/write', async (c) => c.json(await prepareReview()));
api.post('/review/finish', async (c) => c.json(await finishReview(await body(c))));

// ---------- Capture ----------
api.post('/capture', async (c) => c.json(await captureTask((await body(c)).text, 'you')));
api.get('/tokens', async (c) => c.json({ count: await tokenCount() }));
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
  'health_samples', 'health_workouts', 'cal_events'];
api.get('/export', async (c) => {
  const out = { exportedAt: new Date().toISOString(), app: 'Oath' };
  for (const t of EXPORT_TABLES) out[t] = await db().unsafe(`select * from ${t} order by 1`);
  out.game = (await db()`select value from kv where key = 'game'`)[0]?.value || null;
  out.settings = (await db()`select value from kv where key = 'settings'`)[0]?.value || null;
  c.header('Content-Disposition', `attachment; filename="oath-export-${new Date().toISOString().slice(0, 10)}.json"`);
  return c.json(out);
});

// ---------- Habits ----------
api.post('/habits', async (c) => c.json(await engine.createHabit(await body(c), v)));
api.patch('/habits/:id', async (c) => c.json(await engine.updateHabit(idParam(c), await body(c), v)));
api.delete('/habits/:id', async (c) => c.json(await engine.archiveHabit(idParam(c))));
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
  await saveSubscription(await body(c));
  return c.json({ ok: true, devices: await subscriptionCount() });
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
api.post('/briefs/:kind', async (c) => {
  const kind = c.req.param('kind');
  if (!['morning', 'midday', 'evening'].includes(kind)) throw new engine.RuleError('Unknown brief.');
  return c.json(await generateBrief(kind));
});

// ---------- Settings ----------
api.get('/settings', async (c) => c.json(await engine.getSettings()));
api.patch('/settings', async (c) => {
  const b = await body(c);
  const patch = {};
  if (b.morningTime !== undefined) {
    if (!validTime(b.morningTime)) throw new engine.RuleError('Morning time must be HH:MM.');
    patch.morningTime = b.morningTime;
  }
  if (b.dayEnd !== undefined) {
    if (!validTime(b.dayEnd)) throw new engine.RuleError('Day end must be HH:MM.');
    patch.dayEnd = b.dayEnd;
  }
  if (b.alerts !== undefined) {
    if (!['smart', 'both', 'push'].includes(b.alerts)) throw new engine.RuleError('Unknown alert setting.');
    patch.alerts = b.alerts;
  }
  if (b.middayTime !== undefined) {
    if (!validTime(b.middayTime)) throw new engine.RuleError('Midday time must be HH:MM.');
    patch.middayTime = b.middayTime;
  }
  if (b.eveningTime !== undefined) {
    if (!validTime(b.eveningTime)) throw new engine.RuleError('Evening time must be HH:MM.');
    patch.eveningTime = b.eveningTime;
  }
  if (b.timezone !== undefined) {
    if (!IANAZone.isValidZone(b.timezone)) throw new engine.RuleError('Unknown time zone.');
    patch.timezone = b.timezone;
  }
  return c.json(await engine.saveSettings(patch));
});
api.post('/password', async (c) => {
  const b = await body(c);
  const r = await auth.changePassword(b.current, b.next);
  return r.error ? c.json({ error: r.error }, r.status) : c.json({ ok: true });
});

// ---------- Your data: Apple Health, calendars, business sites ----------
api.route('/', healthApi);
api.route('/', calendarApi);
api.route('/', businessApi);

app.route('/api', api);

// Telegram calls this; it proves itself with the secret token set when the webhook was registered.
app.post('/telegram/webhook', async (c) => {
  const secret = await webhookSecret();
  if (!secret || c.req.header('x-telegram-bot-api-secret-token') !== secret) return c.text('forbidden', 403);
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
app.use('*', serveStatic({ root: './public' }));
app.get('*', serveStatic({ path: './public/index.html' }));

export { app };

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  connect();
  await migrate();
  await engine.ensureGame();
  await vapidKeys();
  initTelegram().catch((err) => console.error('telegram init failed:', err.message));
  checkCoach();
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
