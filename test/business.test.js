// Business dashboard: BUSINESS_SOURCES parsing, parallel fetches of each site's /api/oath/summary
// with its own Bearer token (a good site, one answering 500, one slower than the timeout and one
// that refuses the token), the kv cache that keeps the last good numbers, the coach lines and the
// API route, against a real Postgres with a controllable clock and a local http server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import EmbeddedPostgres from 'embedded-postgres';
import { DateTime } from 'luxon';
import { Hono } from 'hono';

const ZONE = 'Europe/Malta';
let clock = DateTime.fromISO('2026-10-12T08:00', { zone: ZONE });
const advance = (minutes) => { clock = clock.plus({ minutes }); };
const nowIso = () => clock.toUTC().toISO();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-business-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54343,
  persistent: false, createPostgresUser: true, onLog: () => {}, onError: () => {},
});

// ---------- Local sites ----------

const GOOD_TOKEN = 'good-token-0123456789abcdef';
const JOURNAL_TOKEN = 'journal-token-0123456789abcdef';
const WRONG_TOKEN = 'wrong-token-0123456789abcdef';
const OTHER_TOKEN = 'other-token-0123456789abcdef';
const TIMEOUT_MS = 400;
const SLOW_MS = 3000;

let goodBroken = false;
let goodRevenue = 1797;
const hits = new Map(); // pathname -> count
const auths = new Map(); // pathname -> last Authorization header
const arrivals = []; // [pathname, ms]

const summary = () => ({
  site: 'GoldenStraddler',
  url: 'https://goldenstraddler.com',
  generatedAt: nowIso(),
  metrics: [
    { key: 'revenue_30d', label: 'Revenue, 30 days', value: goodRevenue, unit: 'EUR', format: 'money', change: 19.9,
      series: [{ date: '2026-10-11', value: 149 }, { date: '2026-10-12', value: goodRevenue - 149 }] },
    { key: 'sales_30d', label: 'New sales, 30 days', value: 2, format: 'count', change: 100 },
    { key: 'mrr', label: 'Monthly recurring revenue', value: 337, unit: 'EUR', format: 'money' },
    { key: 'active_licences', label: 'Active EA licences', value: 3, format: 'count' },
    { key: 'eas_online', label: 'Customer EAs online now', value: 1, format: 'count' },
  ],
  status: { ok: true, text: 'Live account EA online, +3,210 points over 142 trades; 1 customer EA online' },
  events: [{ at: nowIso(), text: 'New sale: lifetime licence, €1,499 by card' }],
  alerts: ['1 refund request to answer', '1 demo trial ends in the next 24 hours'],
});

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://local');
  hits.set(pathname, (hits.get(pathname) || 0) + 1);
  auths.set(pathname, req.headers.authorization || '');
  arrivals.push([pathname, Date.now()]);
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const guard = (token) => req.headers.authorization === `Bearer ${token}`;
  switch (pathname) {
    case '/good/api/oath/summary':
      if (!guard(GOOD_TOKEN)) return send(401, { ok: false, error: 'Unauthorized' });
      return goodBroken ? send(500, { ok: false, error: 'Something went wrong' }) : send(200, summary());
    case '/broken/api/oath/summary':
      return send(500, { ok: false, error: 'Something went wrong' });
    case '/slow/api/oath/summary': {
      const t = setTimeout(() => send(200, summary()), SLOW_MS);
      res.on('close', () => clearTimeout(t));
      return undefined;
    }
    case '/journal/api/oath/summary':
      if (!guard(JOURNAL_TOKEN)) return send(401, { ok: false, error: 'Unauthorized' });
      return send(200, { ...summary(), site: 'Exposed FX Journal' });
    case '/moved/api/oath/summary':
      res.writeHead(301, { location: `${base}/good/api/oath/summary` });
      return res.end();
    case '/html/api/oath/summary':
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Not an API</title>');
    case '/messy/api/oath/summary':
      return send(200, {
        site: 'Messy', url: 'javascript:alert(1)', generatedAt: 'yesterday', secret: 'not-for-oath',
        metrics: [
          { key: 'ok', label: 'Fine', value: 5, format: 'count', series: [{ date: '2026-10-12', value: 5 }, { date: 'bad', value: 1 }, { date: '2026-10-11', value: 'x' }] },
          { key: 'nan', label: 'Not a number', value: 'many' },
          null,
          { label: 'No key', value: 1 },
          { key: 'odd', label: 'x'.repeat(500), value: 2, format: 'weird', unit: 'EUR-EUR-EUR-EUR' },
        ],
        status: 'fine',
        events: [{ at: 'never', text: 'dropped' }, { at: nowIso(), text: 'kept' }, 'junk'],
        alerts: ['real alert', 42, '', null],
      });
    default:
      return send(404, { ok: false, error: 'Not found' });
  }
});
const sockets = new Set();
server.on('connection', (s) => {
  sockets.add(s);
  s.on('close', () => sockets.delete(s));
});
let base = '';

// ---------- Harness ----------

let biz; let dbmod; let app;

const setSources = (list) => { process.env.BUSINESS_SOURCES = typeof list === 'string' ? list : JSON.stringify(list); };
const FOUR = () => [
  { name: 'GoldenStraddler', url: `${base}/good/api/oath/summary`, token: GOOD_TOKEN },
  { name: 'Broken site', url: `${base}/broken/api/oath/summary`, token: OTHER_TOKEN },
  { name: 'Slow site', url: `${base}/slow/api/oath/summary`, token: OTHER_TOKEN },
  { name: 'Exposed FX Journal', url: `${base}/journal/api/oath/summary`, token: WRONG_TOKEN },
];
const byName = (r) => Object.fromEntries(r.sources.map((s) => [s.name, s]));
const hitsOf = (name) => hits.get(`/${name}/api/oath/summary`) || 0;
const noTokens = (text) => {
  for (const t of [GOOD_TOKEN, JOURNAL_TOKEN, WRONG_TOKEN, OTHER_TOKEN]) assert.ok(!text.includes(t), `no token ${t.slice(0, 6)}... in ${text.slice(0, 80)}`);
};

async function get(url) {
  const res = await app.request(url);
  const text = await res.text();
  return { status: res.status, text, data: JSON.parse(text) };
}

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54343/oath';
  delete process.env.BUSINESS_SOURCES;
  const time = await import('../src/time.js');
  time.setClock(() => clock.toUTC());
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  biz = await import('../src/business.js');
  biz.setBusinessTestHooks({ timeoutMs: TIMEOUT_MS });
  app = new Hono();
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'Something broke on the server.' }, 500);
  });
  app.route('/api', biz.businessApi);
});

after(async () => {
  delete process.env.BUSINESS_SOURCES;
  await dbmod.close();
  for (const s of sockets) s.destroy();
  await new Promise((resolve) => server.close(resolve));
  await pg.stop();
});

async function reset(iso = '2026-10-12T08:00') {
  clock = DateTime.fromISO(iso, { zone: ZONE });
  goodBroken = false;
  goodRevenue = 1797;
  hits.clear();
  auths.clear();
  arrivals.length = 0;
  delete process.env.BUSINESS_SOURCES;
  await dbmod.db()`delete from kv where key = 'business'`;
}

// ---------- Tests ----------

test('1. BUSINESS_SOURCES: well-formed entries are read in order, malformed ones are ignored', async () => {
  await reset();
  assert.deepEqual(biz.businessSources(), []);
  setSources('not json at all');
  assert.deepEqual(biz.businessSources(), []);
  setSources({ name: 'One', url: 'https://one.example/api/oath/summary', token: 't' });
  assert.deepEqual(biz.businessSources(), [], 'an object instead of an array');
  setSources([
    { name: ' GoldenStraddler ', url: 'https://goldenstraddler.com/api/oath/summary', token: ` ${GOOD_TOKEN} ` },
    null,
    42,
    'GoldenStraddler',
    { name: 'No token', url: 'https://a.example/api/oath/summary' },
    { name: 'Empty token', url: 'https://a.example/api/oath/summary', token: '   ' },
    { name: 'Spaced token', url: 'https://a.example/api/oath/summary', token: 'two words' },
    { name: '', url: 'https://a.example/api/oath/summary', token: 'x' },
    { name: 'Bad URL', url: 'not a url', token: 'x' },
    { name: 'FTP', url: 'ftp://a.example/summary', token: 'x' },
    { name: 'Plain http elsewhere', url: 'http://a.example/api/oath/summary', token: 'x' },
    { name: 'goldenstraddler', url: 'https://other.example/api/oath/summary', token: 'x' },
    { name: 'Exposed FX Journal', url: 'https://journal.exposedfx.com/api/oath/summary', token: JOURNAL_TOKEN },
    { name: 'Local', url: 'http://127.0.0.1:9/api/oath/summary', token: 'x' },
  ]);
  assert.deepEqual(biz.businessSources(), [
    { name: 'GoldenStraddler', url: 'https://goldenstraddler.com/api/oath/summary', token: GOOD_TOKEN },
    { name: 'Exposed FX Journal', url: 'https://journal.exposedfx.com/api/oath/summary', token: JOURNAL_TOKEN },
    { name: 'Local', url: 'http://127.0.0.1:9/api/oath/summary', token: 'x' },
  ]);
});

test('2. nothing set up: configured false, no fetch, nothing stored, nothing for the coach', async () => {
  await reset();
  assert.deepEqual(await biz.businessSummary(), { configured: false, sources: [] });
  setSources([{ name: 'Broken entry', url: 'nope', token: 'x' }]);
  assert.deepEqual(await biz.businessSummary(), { configured: false, sources: [] });
  assert.equal(await biz.businessForCoach(), '');
  const r = await get('/api/business');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { configured: false, sources: [] });
  assert.equal(await dbmod.getKV('business'), null);
  assert.equal(arrivals.length, 0);
});

test('3. refresh asks every site at once with its own token; 500, timeout and a refused token are reported per site', async () => {
  await reset();
  setSources(FOUR());
  const t0 = Date.now();
  const r = await biz.refreshBusiness();
  const took = Date.now() - t0;
  assert.ok(took < SLOW_MS, `didn't wait for the slow site (${took} ms)`);
  assert.ok(took >= TIMEOUT_MS - 50, `waited for the timeout (${took} ms)`);
  // In parallel: every request reached the server before the slow one timed out.
  const times = arrivals.map(([, at]) => at);
  assert.equal(arrivals.length, 4);
  assert.ok(Math.max(...times) - Math.min(...times) < TIMEOUT_MS, `requests were sent together (spread ${Math.max(...times) - Math.min(...times)} ms)`);

  assert.equal(r.fetchedAt, nowIso());
  assert.deepEqual(r.sources.map((s) => s.name), ['GoldenStraddler', 'Broken site', 'Slow site', 'Exposed FX Journal']);
  const s = byName(r);
  assert.equal(s.GoldenStraddler.ok, true);
  assert.equal(s.GoldenStraddler.error, null);
  assert.equal(s.GoldenStraddler.fetchedAt, nowIso());
  assert.equal(s.GoldenStraddler.checkedAt, nowIso());
  assert.equal(s.GoldenStraddler.data.site, 'GoldenStraddler');
  assert.equal(s.GoldenStraddler.data.metrics.length, 5);
  assert.deepEqual(s.GoldenStraddler.data.metrics[0], summary().metrics[0]);
  assert.deepEqual(s.GoldenStraddler.data.status, { ok: true, text: summary().status.text });
  assert.deepEqual(s.GoldenStraddler.data.alerts, summary().alerts);
  assert.equal(auths.get('/good/api/oath/summary'), `Bearer ${GOOD_TOKEN}`);

  assert.equal(s['Broken site'].ok, false);
  assert.match(s['Broken site'].error, /500/);
  assert.equal(s['Broken site'].data, null);
  assert.equal(s['Broken site'].fetchedAt, null);
  assert.equal(s['Broken site'].checkedAt, nowIso());

  assert.equal(s['Slow site'].ok, false);
  assert.match(s['Slow site'].error, /No answer within 0\.4 s/);
  assert.equal(s['Slow site'].data, null);

  assert.equal(s['Exposed FX Journal'].ok, false);
  assert.match(s['Exposed FX Journal'].error, /refused the token \(401\)/);
  assert.equal(auths.get('/journal/api/oath/summary'), `Bearer ${WRONG_TOKEN}`);

  // Stored as it was returned, without any token.
  const stored = await dbmod.getKV('business');
  assert.deepEqual(stored, r);
  noTokens(JSON.stringify(stored));
});

test('4. a site that fails keeps its last good numbers, marked not ok with the error, until it answers again', async () => {
  await reset();
  setSources(FOUR());
  const first = byName(await biz.refreshBusiness()).GoldenStraddler;
  assert.equal(first.ok, true);
  const goodAt = nowIso();

  goodBroken = true;
  advance(15);
  const down = byName(await biz.refreshBusiness()).GoldenStraddler;
  assert.equal(down.ok, false);
  assert.match(down.error, /500/);
  assert.deepEqual(down.data, first.data, 'the last good numbers are kept');
  assert.equal(down.fetchedAt, goodAt, 'and say when they arrived');
  assert.equal(down.checkedAt, nowIso());
  const sum = await biz.businessSummary();
  assert.equal(byName(sum).GoldenStraddler.data.metrics[0].value, 1797);

  goodBroken = false;
  goodRevenue = 2100;
  advance(15);
  const back = byName(await biz.refreshBusiness()).GoldenStraddler;
  assert.equal(back.ok, true);
  assert.equal(back.error, null);
  assert.equal(back.data.metrics[0].value, 2100);
  assert.equal(back.fetchedAt, nowIso());

  // The journal starts answering once its token is put right; the broken site still has nothing.
  setSources(FOUR().map((x) => (x.name === 'Exposed FX Journal' ? { ...x, token: JOURNAL_TOKEN } : x)));
  const fixed = byName(await biz.refreshBusiness());
  assert.equal(fixed['Exposed FX Journal'].ok, true);
  assert.equal(fixed['Exposed FX Journal'].data.site, 'Exposed FX Journal');
  assert.equal(fixed['Broken site'].data, null);
});

test('5. businessSummary uses the cache while it is fresh and refreshes when old, on ?refresh=1 or when the sources change', async () => {
  await reset();
  setSources(FOUR().slice(0, 2));
  const a = await biz.businessSummary();
  assert.equal(a.configured, true);
  assert.equal(a.fetchedAt, nowIso());
  assert.equal(a.sources.length, 2);
  assert.equal(hitsOf('good'), 1);

  advance(9);
  const b = await biz.businessSummary();
  assert.equal(hitsOf('good'), 1, 'nine minutes old: served from the cache');
  assert.deepEqual(b, a);

  advance(2);
  const c = await biz.businessSummary();
  assert.equal(hitsOf('good'), 2, 'eleven minutes old: refreshed');
  assert.equal(c.fetchedAt, nowIso());

  advance(20);
  await biz.businessSummary({ maxAgeMin: 30 });
  assert.equal(hitsOf('good'), 2, 'a longer maxAgeMin keeps using the cache');
  await biz.businessSummary({ maxAgeMin: 0 });
  assert.equal(hitsOf('good'), 3, 'maxAgeMin 0 always refreshes');

  // The API: cached by default, forced with ?refresh=1, never with a token in it.
  let r = await get('/api/business');
  assert.equal(r.status, 200);
  assert.equal(r.data.configured, true);
  assert.equal(hitsOf('good'), 3);
  r = await get('/api/business?refresh=1');
  assert.equal(r.status, 200);
  assert.equal(hitsOf('good'), 4);
  noTokens(r.text);

  // A source added to BUSINESS_SOURCES shows up at once rather than after the cache runs out.
  setSources([...FOUR().slice(0, 2), { name: 'Exposed FX Journal', url: `${base}/journal/api/oath/summary`, token: JOURNAL_TOKEN }]);
  const d = await biz.businessSummary();
  assert.deepEqual(d.sources.map((s) => s.name), ['GoldenStraddler', 'Broken site', 'Exposed FX Journal']);
  assert.equal(byName(d)['Exposed FX Journal'].ok, true);

  // Two callers at once share one refresh.
  const before = hitsOf('good');
  const [x, y] = await Promise.all([biz.refreshBusiness(), biz.refreshBusiness()]);
  assert.equal(hitsOf('good'), before + 1);
  assert.equal(x, y);
});

test('6. the coach gets each site\'s headline numbers, status and alerts in a few plain lines', async () => {
  await reset();
  setSources(FOUR());
  await biz.refreshBusiness();
  const text = await biz.businessForCoach();
  const lines = text.split('\n');
  assert.equal(lines[0], "Business (Daniel's own sites):");
  assert.ok(lines.length <= 1 + 2 * 4, `a few lines (${lines.length})`);
  const gs = lines.find((l) => l.startsWith('  GoldenStraddler: '));
  assert.ok(gs.includes('Revenue, 30 days: €1,797 (up 19.9% on the period before)'), gs);
  assert.ok(gs.includes('New sales, 30 days: 2 (up 100% on the period before)'), gs);
  assert.ok(gs.includes('Monthly recurring revenue: €337'), gs);
  assert.ok(gs.includes('Status: Live account EA online'), gs);
  assert.ok(!gs.includes('Customer EAs online now'), 'only the first four numbers');
  assert.ok(lines.includes('  GoldenStraddler needs: 1 refund request to answer; 1 demo trial ends in the next 24 hours.'), text);
  assert.ok(lines.includes('  Broken site: no numbers yet (The site answered 500).'), text);
  assert.ok(lines.some((l) => /^ {2}Slow site: no numbers yet \(No answer within 0\.4 s\)\.$/.test(l)), text);
  assert.ok(!text.includes('\u2014'), 'no em dashes');
  noTokens(text);

  // Numbers kept after a failed check say how old they are.
  goodBroken = true;
  advance(60 * 3);
  await biz.refreshBusiness();
  const later = await biz.businessForCoach();
  assert.ok(later.includes('These are from 12 Oct 06:00 UTC; the latest check failed.'), later);
});

test('7. redirects are not followed, and answers that are not summaries are refused or cleaned', async () => {
  await reset();
  setSources([
    { name: 'Moved', url: `${base}/moved/api/oath/summary`, token: GOOD_TOKEN },
    { name: 'Web page', url: `${base}/html/api/oath/summary`, token: OTHER_TOKEN },
    { name: 'Messy', url: `${base}/messy/api/oath/summary`, token: OTHER_TOKEN },
    { name: 'Gone', url: `${base}/gone/api/oath/summary`, token: OTHER_TOKEN },
  ]);
  const s = byName(await biz.refreshBusiness());
  assert.equal(s.Moved.ok, false);
  assert.match(s.Moved.error, /redirected \(301\)/);
  assert.equal(hitsOf('good'), 0, 'the token was not carried to where it pointed');
  assert.equal(s['Web page'].ok, false);
  assert.match(s['Web page'].error, /wasn't JSON/);
  assert.equal(s.Gone.ok, false);
  assert.match(s.Gone.error, /404.*OATH_SUMMARY_TOKEN/);

  assert.equal(s.Messy.ok, true);
  const m = s.Messy.data;
  assert.equal(m.url, '', 'only http(s) addresses');
  assert.equal(m.generatedAt, null);
  assert.ok(!('secret' in m));
  assert.deepEqual(m.metrics.map((x) => x.key), ['ok', 'odd']);
  assert.deepEqual(m.metrics[0].series, [{ date: '2026-10-12', value: 5 }]);
  assert.equal(m.metrics[1].label.length, 80);
  assert.equal(m.metrics[1].format, 'number');
  assert.equal(m.metrics[1].unit.length, 12);
  assert.equal(m.status, null);
  assert.deepEqual(m.events.map((e) => e.text), ['kept']);
  assert.deepEqual(m.alerts, ['real alert']);
});
