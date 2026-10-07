import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { IANAZone } from 'luxon';
import { connect, migrate, close as closeDb } from './db.js';
import { validTime, validDate } from './time.js';
import * as auth from './auth.js';
import * as engine from './engine.js';
import { buildToday, buildPlan, buildLedger } from './state.js';
import { vapidKeys, saveSubscription, removeSubscription, sendPush, subscriptionCount } from './push.js';
import { chat, coachHistory, generateBrief, aiEnabled } from './coach.js';
import { startLoop, runOnce, healIfEmpty } from './loop.js';
import * as drive from './drive.js';
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

const api = new Hono();
api.use('*', auth.requireAuth());

api.get('/today', async (c) => c.json(await buildToday()));
api.get('/plan', async (c) => c.json(await buildPlan()));
api.get('/ledger', async (c) => c.json(await buildLedger()));

// ---------- Habits ----------
api.post('/habits', async (c) => c.json(await engine.createHabit(await body(c), v)));
api.patch('/habits/:id', async (c) => c.json(await engine.updateHabit(idParam(c), await body(c), v)));
api.delete('/habits/:id', async (c) => c.json(await engine.archiveHabit(idParam(c))));
api.post('/habits/:id/keep', async (c) => {
  const id = idParam(c);
  await engine.completeHabit(id, (await body(c)).note);
  await drive.closeFocusFor('habit', id);
  return c.json({ ok: true, reaction: await drive.reactionAfterDone('habit', id) });
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
  const r = await engine.pardon(idParam(c), (await body(c)).reason);
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
