// Recipe import: reading schema.org Recipe JSON-LD, the guard against opening private addresses, the
// size and type limits, the Claude reading of a page without JSON-LD, the matching of ingredient lines
// (flagged, never dropped or guessed) and the API, which returns a draft and saves nothing. DNS and the
// network are stood in for: no real site is ever fetched. Every page and recipe here is made up.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
// Parallel checkouts run the suite at once with OATH_PORT_SHIFT set apart.
const SHIFT = Number(process.env.OATH_PORT_SHIFT || 0);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-import-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54435 + SHIFT,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

let app; let cookie = ''; let dbmod; let coach; let imp; let food;

async function call(method, url, json) {
  const headers = { cookie };
  if (json !== undefined || method !== 'GET') headers['content-type'] = 'application/json';
  const res = await app.request(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
const ok = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
const get = async (url) => ok(await call('GET', url));
const post = async (url, body = {}) => ok(await call('POST', url, body));

// ---------- The stand-in internet ----------

const PUBLIC_IP = '93.184.216.34';
// Host → the addresses DNS gives for it.
const DNS = new Map([
  ['recipes.example', [{ address: PUBLIC_IP, family: 4 }]],
  ['short.example', [{ address: PUBLIC_IP, family: 4 }]],
  ['sneaky.example', [{ address: '127.0.0.1', family: 4 }]],
  ['half.example', [{ address: PUBLIC_IP, family: 4 }, { address: '10.0.0.7', family: 4 }]],
  ['six.example', [{ address: 'fd00::7', family: 6 }]],
  ['localhost', [{ address: '127.0.0.1', family: 4 }]],
]);
// URL → the answer: { status, headers, body or chunks }.
const PAGES = new Map();
let requests = [];
const headersOf = (h) => ({ get: (k) => h[k.toLowerCase()] ?? null });
const page = (url, body, headers = {}) => PAGES.set(url, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body });
const redirect = (from, to, status = 302) => PAGES.set(from, { status, headers: { location: to }, body: '' });

const html = (ld, extra = '') => `<!doctype html><html><head><title>Test</title><meta property="og:site_name" content="Made-up Kitchen">
  ${[ld].flat().filter(Boolean).map((x) => `<script type="application/ld+json">${typeof x === 'string' ? x : JSON.stringify(x)}</script>`).join('\n')}</head>
  <body><h1>A page</h1>${extra}</body></html>`;

// ---------- The stand-in Claude ----------

function scripted(responses) {
  const requests = [];
  return {
    requests,
    beta: { messages: { create: async (params) => {
      requests.push(JSON.parse(JSON.stringify(params)));
      const r = responses.shift();
      if (!r) throw new Error('no scripted response left');
      return typeof r === 'function' ? r(params) : r;
    } } },
  };
}
const said = (obj) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });
const ingredient = (line, over) => ({ line, written: '', name: 'Food', brand: '', variety: '', preparation: '', size: '', amount: 0, unit: 'g', weight: 0, confidence: 'medium', searches: [], ...over });
const chose = (...picks) => said({ choices: picks.map(([item, key, unit, qty, why = 'Closest record']) => ({ item, key, unit, qty, why })) });

// A made-up recipe page's JSON-LD.
const PASTA = {
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Weeknight tomato spaghetti',
  description: 'A quick tomato pasta for &amp; two.',
  recipeYield: '4 servings',
  prepTime: 'PT10M',
  cookTime: 'PT20M',
  totalTime: 'PT30M',
  recipeCategory: 'Main course',
  keywords: 'pasta, quick, tomato',
  recipeIngredient: ['200 g spaghetti', '2 tbsp olive oil', '1 onion, chopped', '1 x 400 g tin chopped tomatoes', 'a pinch of zzqx saffron', 'Salt, to taste'],
  recipeInstructions: [
    { '@type': 'HowToStep', text: 'Boil the spaghetti.' },
    { '@type': 'HowToStep', text: 'Fry the onion in the oil.' },
    { '@type': 'HowToStep', text: 'Add the tomatoes and simmer.' },
  ],
};

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = `postgres://postgres:test@localhost:${54435 + SHIFT}/oath`;
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  process.env.ANTHROPIC_API_KEY = 'test';
  delete process.env.TELEGRAM_BOT_TOKEN;
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  const engine = await import('../src/engine.js');
  await engine.ensureGame();
  ({ app } = await import('../src/server.js'));
  coach = await import('../src/coach.js');
  food = await import('../src/food.js');
  imp = await import('../src/food-import.js');
  imp.setImportLookup(async (host) => {
    if (DNS.has(host)) return DNS.get(host);
    const err = new Error(`getaddrinfo ENOTFOUND ${host}`);
    err.code = 'ENOTFOUND';
    throw err;
  });
  imp.setImportRequest(async (url, opts) => {
    requests.push({ url: url.toString(), address: opts.address, ua: opts.headers['user-agent'] });
    const p = PAGES.get(url.toString());
    if (!p) return { status: 404, headers: headersOf({}), body: [] };
    return { status: p.status, headers: headersOf(p.headers), body: p.chunks || [Buffer.from(p.body)] };
  });
  const s = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(s.status, 200);
  // A small catalogue of made-up records for the matcher to find.
  const item = (key, name, kcal, extra = {}) => food.upsertItem({ key, kind: 'generic', name, basis: 'g', source: 'usda', nutrients: { kcal, protein: 1, carbs: 1, sugars: 0, fat: 1, satfat: 0, fibre: 0, salt: 0 }, ...extra });
  await item('test-spaghetti-dry', 'Spaghetti, dry', 371, { state: 'dry' });
  await item('test-olive-oil', 'Olive oil', 884, { portions: [{ label: '1 tbsp', g: 13.5, source: 'usda' }] });
  await item('test-onion-raw', 'Onion, raw', 40, { state: 'raw', portions: [{ label: '1 medium', g: 110, source: 'usda' }] });
  await item('test-tomatoes-tinned', 'Tomatoes, chopped, tinned', 21, { state: 'tinned' });
  await item('test-salt', 'Salt, table', 0, { portions: [{ label: '1 tsp', g: 6, source: 'usda' }] });
});

after(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await dbmod.close();
  // Windows can keep the data folder locked after stopping; a leftover temp folder is harmless.
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

// ---------- Reading JSON-LD ----------

test('JSON-LD: a plain Recipe gives its name, yield, ingredients, steps, times and description', () => {
  const r = imp.recipeFromHtml(html(PASTA));
  assert.equal(r.name, 'Weeknight tomato spaghetti');
  assert.equal(r.servings, 4);
  assert.deepEqual(r.ingredients, PASTA.recipeIngredient);
  assert.deepEqual(r.method, ['Boil the spaghetti.', 'Fry the onion in the oil.', 'Add the tomatoes and simmer.']);
  assert.equal(r.prep_min, 10);
  assert.equal(r.cook_min, 20);
  assert.equal(r.summary, 'A quick tomato pasta for & two.', 'entities decoded');
  assert.equal(imp.familyOf({ category: r.category, name: r.name, keywords: r.keywords }), 'pasta');
});

test('JSON-LD: a Recipe inside @graph, with @type as a list, among other nodes', () => {
  const ld = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebSite', name: 'Made-up Kitchen' },
    { '@type': 'BreadcrumbList', itemListElement: [] },
    { '@type': ['Recipe', 'NewsArticle'], name: 'Lentil soup', recipeYield: ['4', '4 people'], recipeIngredient: ['200 g red lentils', '1 litre stock'],
      recipeInstructions: 'Rinse the lentils.\nSimmer everything for 25 minutes.', totalTime: 'PT35M', recipeCategory: ['Soup'] },
  ] };
  const r = imp.recipeFromHtml(html(ld));
  assert.equal(r.name, 'Lentil soup');
  assert.equal(r.servings, 4, '["4", "4 people"] is 4');
  assert.deepEqual(r.method, ['Rinse the lentils.', 'Simmer everything for 25 minutes.']);
  assert.equal(r.prep_min, null);
  assert.equal(r.cook_min, 35, 'only a total: it stands as the time');
  assert.equal(imp.familyOf({ category: r.category, name: r.name }), 'soups');
  // A top-level array of blocks, and a Recipe under a WebPage's mainEntity, are found too.
  assert.equal(imp.recipeFromHtml(html([[{ '@type': 'Organization' }, { '@type': 'Recipe', name: 'A', recipeIngredient: ['1 egg'] }]])).name, 'A');
  assert.equal(imp.recipeFromHtml(html({ '@type': 'WebPage', mainEntity: { '@type': 'http://schema.org/Recipe', name: 'B', recipeIngredient: ['1 egg'] } })).name, 'B');
  // No Recipe at all, or one without ingredients, is none.
  assert.equal(imp.recipeFromHtml(html({ '@type': 'Article', name: 'News' })), null);
  assert.equal(imp.recipeFromHtml('<html><body>No data</body></html>'), null);
});

test('JSON-LD: HowToSection steps are flattened in order, the section naming its first step; broken JSON is mended or skipped', () => {
  const ld = { '@type': 'Recipe', name: 'Pie', recipeIngredient: ['300 g flour'], recipeInstructions: [
    { '@type': 'HowToSection', name: 'For the pastry', itemListElement: [{ '@type': 'HowToStep', text: 'Rub the butter into the flour.' }, { '@type': 'HowToStep', text: 'Chill for 30 minutes.' }] },
    { '@type': 'HowToSection', name: 'For the filling:', itemListElement: [{ '@type': 'HowToStep', text: '<p>Cook the apples &amp; sugar.</p>' }] },
    { '@type': 'HowToStep', name: 'Bake', text: 'Bake for 40 minutes.' },
  ] };
  const r = imp.recipeFromHtml(html(ld));
  assert.deepEqual(r.method, ['For the pastry: Rub the butter into the flour.', 'Chill for 30 minutes.', 'For the filling: Cook the apples & sugar.', 'Bake for 40 minutes.']);
  // A raw line break inside a JSON string (invalid JSON, common on real pages) is mended; a broken block is skipped.
  const raw = '{"@type":"Recipe","name":"Line\nbreak","recipeIngredient":["1 egg"]}';
  assert.equal(imp.recipeFromHtml(html([raw, '{not json'])).name, 'Line break');
});

test('durations and yields', () => {
  assert.equal(imp.minutesOf('PT1H30M'), 90);
  assert.equal(imp.minutesOf('P0DT45M'), 45);
  assert.equal(imp.minutesOf('PT0.5H'), 30);
  assert.equal(imp.minutesOf('PT90S'), 2);
  assert.equal(imp.minutesOf('P1D'), 1440);
  assert.equal(imp.minutesOf('1 hr 10 mins'), 70);
  assert.equal(imp.minutesOf(''), null);
  assert.equal(imp.minutesOf('PT0M'), null);
  assert.equal(imp.servingsOf('4 servings'), 4);
  assert.equal(imp.servingsOf(['4', '4 people']), 4);
  assert.equal(imp.servingsOf('Serves 4-6'), 4);
  assert.equal(imp.servingsOf('Makes 12 cookies'), 12);
  assert.equal(imp.servingsOf(6), 6);
  assert.equal(imp.servingsOf('a few'), null);
  assert.equal(imp.servingsOf(['one loaf', '1 loaf']), 1);
});

// ---------- Fetching safely ----------

test('private, local and odd addresses are refused before anything is fetched', async () => {
  const refused = [
    'http://localhost/recipe', 'http://127.0.0.1/recipe', 'http://127.8.9.10/', 'http://10.0.0.5/', 'http://172.16.4.2/', 'http://172.31.0.1/',
    'http://192.168.1.10/', 'http://169.254.169.254/latest/meta-data/', 'http://100.64.1.1/', 'http://0.0.0.0/', 'http://[::1]/', 'http://[fc00::1]/',
    'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.1]/', 'http://2130706433/', 'http://0x7f.1/',
    'https://sneaky.example/recipe', 'https://half.example/recipe', 'https://six.example/recipe', 'https://sub.localhost/',
  ];
  requests = [];
  for (const url of refused) {
    const r = await call('POST', '/api/food/recipes/import', { url });
    assert.equal(r.status, 400, `${url}: ${JSON.stringify(r.data)}`);
    assert.match(r.data.error, /private or local address/, url);
  }
  for (const [url, why] of [['ftp://recipes.example/x', /http or https/], ['file:///etc/passwd', /http or https/], ['https://user:pw@recipes.example/x', /name and password/],
    ['https://recipes.example:22/x', /usual ports/], ['not a link', /not a web address/], ['https://nowhere.example/x', /could not be found/]]) {
    const r = await call('POST', '/api/food/recipes/import', { url });
    assert.ok(r.status >= 400 && r.status < 500, url);
    assert.match(r.data.error, why, url);
  }
  assert.equal(requests.length, 0, 'nothing was fetched');
  // The guard on its own, IPv4 inside IPv6 included.
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.1', '169.254.1.1', '100.100.0.1', '::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::1']) {
    assert.ok(imp.privateAddress(ip), ip);
  }
  for (const ip of [PUBLIC_IP, '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(imp.privateAddress(ip), null, ip);
});

test('redirects are followed three times at most, each one checked again; the connection goes to the address checked', async () => {
  requests = [];
  redirect('https://short.example/r', 'https://short.example/r2', 301);
  redirect('https://short.example/r2', '/r3');
  redirect('https://short.example/r3', 'https://sneaky.example/inside');
  let r = await call('POST', '/api/food/recipes/import', { url: 'https://short.example/r' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /private or local/);
  assert.deepEqual(requests.map((x) => x.url), ['https://short.example/r', 'https://short.example/r2', 'https://short.example/r3'], 'the private one was never asked for');
  assert.ok(requests.every((x) => x.address === PUBLIC_IP), 'pinned to the vetted address');
  assert.match(requests[0].ua, /^Oath\/1\.0 \(personal food diary/, 'the same User-Agent as Open Food Facts gets');

  redirect('https://short.example/a', 'https://short.example/b');
  redirect('https://short.example/b', 'https://short.example/c');
  redirect('https://short.example/c', 'https://short.example/d');
  redirect('https://short.example/d', 'https://short.example/e');
  page('https://short.example/e', html(PASTA));
  requests = [];
  r = await call('POST', '/api/food/recipes/import', { url: 'https://short.example/a' });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /redirects too many times/);
  assert.equal(requests.length, 4, 'the first request and three redirects');

  redirect('https://short.example/to-file', 'file:///etc/passwd');
  r = await call('POST', '/api/food/recipes/import', { url: 'https://short.example/to-file' });
  assert.match(r.data.error, /http or https/);
});

test('a page over 3 MB, or anything but HTML, is refused', async () => {
  page('https://recipes.example/huge-declared', 'x', { 'content-length': String(4 * 1024 * 1024) });
  let r = await call('POST', '/api/food/recipes/import', { url: 'https://recipes.example/huge-declared' });
  assert.equal(r.status, 413);
  assert.match(r.data.error, /too big/);
  // No length given: the reading stops once 3 MB have arrived.
  const chunk = Buffer.alloc(512 * 1024, 'a');
  PAGES.set('https://recipes.example/huge', { status: 200, headers: { 'content-type': 'text/html' }, chunks: Array(8).fill(chunk) });
  r = await call('POST', '/api/food/recipes/import', { url: 'https://recipes.example/huge' });
  assert.equal(r.status, 413);
  for (const type of ['application/json', 'image/jpeg', 'application/pdf', 'text/plain']) {
    page('https://recipes.example/not-html', '{"@type":"Recipe"}', { 'content-type': type });
    r = await call('POST', '/api/food/recipes/import', { url: 'https://recipes.example/not-html' });
    assert.equal(r.status, 415, type);
    assert.match(r.data.error, /not a web page/);
  }
  r = await call('POST', '/api/food/recipes/import', { url: 'https://recipes.example/missing' });
  assert.equal(r.status, 502);
  assert.match(r.data.error, /not there any more/);
});

test('the real transport connects to the address that was checked, never a fresh lookup, and unpacks gzip', async () => {
  // A loopback server only; the name in the link resolves nowhere, so reaching it proves the pin.
  const http = await import('node:http');
  const zlib = await import('node:zlib');
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.host);
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync('<p>pinned</p>'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const res = await imp.nodeRequest(new URL(`http://pinned-host.invalid:${port}/page`), { address: '127.0.0.1', family: 4, signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'test' } });
    assert.equal(res.status, 200);
    let body = '';
    for await (const chunk of res.body) body += chunk;
    assert.equal(body, '<p>pinned</p>');
    assert.equal(seen[0], `pinned-host.invalid:${port}`, 'the Host header keeps the name');
  } finally {
    server.close();
  }
});

// ---------- Matching and the draft ----------

test('the API returns a draft for the editor, every line kept, unmatched and unmeasured lines flagged, and saves nothing', async () => {
  page('https://recipes.example/spaghetti', html(PASTA));
  const reading = scripted([
    said({ items: [
      ingredient(0, { written: '200 g', name: 'spaghetti', preparation: 'dry', amount: 200, unit: 'g', weight: 200, confidence: 'high', searches: ['spaghetti dry', 'spaghetti'] }),
      ingredient(1, { written: '2 tbsp', name: 'olive oil', amount: 30, unit: 'ml', weight: 27, searches: ['olive oil'] }),
      ingredient(2, { written: '1', name: 'onion', preparation: 'raw', amount: 1, unit: 'piece', weight: 110, searches: ['onion raw', 'onion'] }),
      ingredient(3, { written: '1 x 400 g tin', name: 'chopped tomatoes', preparation: 'tinned', amount: 400, unit: 'g', weight: 400, searches: ['tomatoes chopped tinned'] }),
      ingredient(4, { written: '', name: 'zzqx saffron', searches: ['zzqx saffron'] }),
      ingredient(5, { written: '', name: 'salt', searches: ['salt'] }),
    ] }),
    chose([0, 'test-spaghetti-dry', 'g', 200], [1, 'test-olive-oil', 'p:1 tbsp', 2, 'Two tablespoons'], [2, 'test-onion-raw', 'p:1 medium', 1],
      [3, 'test-tomatoes-tinned', 'g', 400], [5, 'test-salt', 'g', 1]),
  ]);
  coach.setCoachClient(reading);
  const count = async () => (await dbmod.db()`select (select count(*)::int from recipes) as recipes, (select count(*)::int from recipe_lines) as lines, (select count(*)::int from food_log) as log`)[0];
  const before = await count();
  const { draft } = await post('/api/food/recipes/import', { url: 'https://recipes.example/spaghetti' });
  assert.deepEqual(await count(), before, 'nothing saved');
  assert.equal(reading.requests.length, 2, 'one reading of every line, one choice for every line');
  assert.match(reading.requests[0].messages[0].content[0].text, /0: 200 g spaghetti\n1: 2 tbsp olive oil/);
  assert.equal(reading.requests[0].output_config.format.type, 'json_schema');

  assert.equal(draft.name, 'Weeknight tomato spaghetti');
  assert.equal(draft.servings, 4);
  assert.equal(draft.status, 'imported');
  assert.equal(draft.source_url, 'https://recipes.example/spaghetti');
  assert.equal(draft.source_name, 'Made-up Kitchen');
  assert.equal(draft.family, 'pasta');
  assert.deepEqual([draft.prep_min, draft.cook_min], [10, 20]);
  assert.equal(draft.method.length, 3);
  assert.equal(draft.imported.via, 'json-ld');
  assert.equal(draft.lines.length, 6, 'every line kept');
  const [spag, oil, onion, toms, saffron, salt] = draft.lines;
  assert.deepEqual([spag.ref_key, spag.qty, spag.unit, spag.estimate, spag.flag], ['test-spaghetti-dry', 200, 'g', false, undefined]);
  assert.equal(spag.item.key, 'test-spaghetti-dry', 'the record comes with it, for the editor');
  assert.equal(spag.label, 'spaghetti');
  assert.equal(spag.note, '200 g spaghetti', 'the page\'s own words');
  assert.deepEqual([oil.ref_key, oil.qty, oil.unit, oil.estimate], ['test-olive-oil', 2, 'p:1 tbsp', false]);
  assert.deepEqual([onion.ref_key, onion.unit], ['test-onion-raw', 'p:1 medium']);
  assert.equal(toms.qty, 400);
  // No record for it: kept, flagged, with the page's words; nothing guessed.
  assert.equal(saffron.flag, 'unmatched');
  assert.equal(saffron.ref_key, '');
  assert.equal(saffron.item, null);
  assert.equal(saffron.qty, null);
  assert.equal(saffron.note, 'a pinch of zzqx saffron');
  // A record but no amount on the page: flagged, never given one.
  assert.equal(salt.flag, 'unmeasured');
  assert.equal(salt.item.key, 'test-salt');
  assert.equal(salt.qty, null, 'the chooser\'s 1 g is not taken: the page gave no amount');
  assert.equal(draft.imported.flagged, 2);

  // Saved from the editor once he has fixed the two lines: the status and the page come along, and an
  // edit later that does not mention the page keeps it.
  const lines = draft.lines.slice(0, 4).map((l) => ({ ref: 'item', ref_key: l.ref_key, qty: l.qty, unit: l.unit, label: l.label, note: l.note }));
  const saved = await post('/api/food/recipes', { name: draft.name, servings: draft.servings, method: draft.method, family: draft.family, summary: draft.summary,
    prep_min: draft.prep_min, cook_min: draft.cook_min, tags: draft.tags, status: draft.status, source_url: draft.source_url, source_name: draft.source_name, lines });
  let r = await get(`/api/food/recipes/${encodeURIComponent(saved.key)}`);
  assert.equal(r.status, 'imported');
  assert.equal(r.source, 'you');
  assert.equal(r.source_url, 'https://recipes.example/spaghetti');
  assert.equal(r.source_name, 'Made-up Kitchen');
  assert.equal(r.lines[0].note, '200 g spaghetti');
  await post('/api/food/recipes', { key: saved.key, name: 'My tomato spaghetti', servings: 2, lines });
  r = await get(`/api/food/recipes/${encodeURIComponent(saved.key)}`);
  assert.equal(r.name, 'My tomato spaghetti');
  assert.equal(r.source_url, 'https://recipes.example/spaghetti', 'kept through an edit');
  assert.equal(r.status, 'imported');
  // A status nobody knows is not stored; a non-web source is not either.
  const other = await post('/api/food/recipes', { name: 'Odd', servings: 1, status: 'made-up', source_url: 'javascript:alert(1)', lines });
  r = await get(`/api/food/recipes/${encodeURIComponent(other.key)}`);
  assert.equal(r.status, 'user-reviewed');
  assert.equal(r.source_url, null);
});

test('without the AI, metric lines are still matched and the rest stay flagged, never guessed', async () => {
  page('https://recipes.example/spaghetti-2', html(PASTA));
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const { draft } = await post('/api/food/recipes/import', { url: 'https://recipes.example/spaghetti-2' });
    const byNote = Object.fromEntries(draft.lines.map((l) => [l.note, l]));
    assert.equal(byNote['200 g spaghetti'].ref_key, 'test-spaghetti-dry');
    assert.equal(byNote['200 g spaghetti'].qty, 200);
    assert.equal(byNote['2 tbsp olive oil'].flag, 'unmeasured', 'spoons are not turned into grams without the AI');
    assert.equal(byNote['2 tbsp olive oil'].qty, null);
    assert.equal(byNote['a pinch of zzqx saffron'].flag, 'unmatched');
    assert.equal(draft.lines.length, 6);
  } finally {
    process.env.ANTHROPIC_API_KEY = 'test';
  }
});

test('a page without JSON-LD is read once by Claude from its visible text; a page with no recipe says so plainly', async () => {
  const body = `<script>var secret = "never sent";</script><style>.x{}</style>
    <h1>Gran's flapjacks</h1><p>Makes 12.</p><ul><li>250 g oats</li><li>zzqx golden syrup</li></ul><ol><li>Melt.</li><li>Bake for 20 minutes.</li></ol>`;
  page('https://recipes.example/flapjacks', html(null, body));
  await food.upsertItem({ key: 'test-oats', kind: 'generic', name: 'Oats', basis: 'g', source: 'usda', nutrients: { kcal: 379, protein: 13, carbs: 68, sugars: 1, fat: 6.5, satfat: 1.1, fibre: 10, salt: 0 } });
  const reading = scripted([
    said({ found: true, name: "Gran's flapjacks", servings: 12, ingredients: ['250 g oats', 'zzqx golden syrup'], method: ['Melt.', 'Bake for 20 minutes.'], prep_min: 0, cook_min: 20, total_min: 0, category: 'baking', summary: '' }),
    said({ items: [
      ingredient(0, { written: '250 g', name: 'oats', amount: 250, unit: 'g', weight: 250, searches: ['oats'] }),
      ingredient(1, { written: '', name: 'zzqx golden syrup', searches: ['zzqx golden syrup'] }),
    ] }),
    chose([0, 'test-oats', 'g', 250]),
  ]);
  coach.setCoachClient(reading);
  const { draft } = await post('/api/food/recipes/import', { url: 'https://recipes.example/flapjacks' });
  assert.equal(draft.imported.via, 'page');
  assert.equal(draft.name, "Gran's flapjacks");
  assert.equal(draft.servings, 12);
  assert.equal(draft.cook_min, 20);
  assert.equal(draft.prep_min, null);
  assert.deepEqual(draft.method, ['Melt.', 'Bake for 20 minutes.']);
  assert.equal(draft.family, 'sweets');
  assert.equal(draft.lines[0].ref_key, 'test-oats');
  assert.equal(draft.lines[1].flag, 'unmatched');
  const first = reading.requests[0];
  assert.equal(first.output_config.format.type, 'json_schema');
  const text = first.messages[0].content[0].text;
  assert.match(text, /Gran's flapjacks\n.*\n?250 g oats/);
  assert.doesNotMatch(text, /never sent/, 'scripts are not page text');
  // The schema keeps to the API's limit: nothing nullable.
  assert.ok(!JSON.stringify(first.output_config.format.schema).includes('"null"'));

  page('https://recipes.example/about', html(null, '<h1>About us</h1><p>We are a made-up kitchen that writes about food and cooking every week.</p>'));
  coach.setCoachClient(scripted([said({ found: false, name: '', servings: 0, ingredients: [], method: [], prep_min: 0, cook_min: 0, total_min: 0, category: '', summary: '' })]));
  const r = await call('POST', '/api/food/recipes/import', { url: 'https://recipes.example/about' });
  assert.equal(r.status, 422);
  assert.equal(r.data.error, 'There is no recipe on that page that Oath could find.');
});
