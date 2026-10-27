// What the web server and the app's outbound requests say, none of it needing a database: the web
// app's files answer 304 when the browser's copy is current, and the Open Food Facts User-Agent
// carries the app's address from the environment rather than from the (public) source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';

const { app } = await import('../src/server.js');
const { conditionalGet, publicFile } = await import('../src/static.js');
const off = await import('../src/off.js');

const get = (url, headers = {}, method = 'GET') => app.request(url, { method, headers });

test('a file is sent with an ETag and Last-Modified, and still must be revalidated', async () => {
  const res = await get('/app.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('etag'), /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
  assert.ok(res.headers.get('last-modified'));
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(res.headers.get('content-type'), /javascript/);
  const text = await res.text();
  assert.equal(text, fs.readFileSync('public/app.js', 'utf8'), 'the body is the file itself');
});

test('If-None-Match with the current ETag answers 304 with no body and no-cache', async () => {
  const first = await get('/app.js');
  await first.text();
  const etag = first.headers.get('etag');
  const res = await get('/app.js', { 'if-none-match': etag });
  assert.equal(res.status, 304);
  assert.equal(await res.text(), '');
  assert.equal(res.headers.get('etag'), etag);
  assert.equal(res.headers.get('last-modified'), first.headers.get('last-modified'));
  assert.equal(res.headers.get('cache-control'), 'no-cache', 'a 304 keeps the file revalidating');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('content-length'), null);
});

test('the service worker keeps its own headers on a 304', async () => {
  const first = await get('/sw.js');
  await first.text();
  const res = await get('/sw.js', { 'if-none-match': first.headers.get('etag') });
  assert.equal(res.status, 304);
  assert.equal(res.headers.get('service-worker-allowed'), '/');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
});

test('ETags are compared weakly and may be listed; * matches any file', async () => {
  const etag = (await get('/app.css')).headers.get('etag');
  const strong = etag.replace(/^W\//, '');
  assert.equal((await get('/app.css', { 'if-none-match': strong })).status, 304);
  assert.equal((await get('/app.css', { 'if-none-match': `"nope", ${etag}, "other"` })).status, 304);
  assert.equal((await get('/app.css', { 'if-none-match': '*' })).status, 304);
  assert.equal((await get('/app.css', { 'if-none-match': '"nope"' })).status, 200);
  assert.equal((await get('/app.css', { 'if-none-match': 'W/"1-1"' })).status, 200);
});

test('If-Modified-Since answers 304 for a copy at least as new as the file, and 200 for an older one', async () => {
  const modified = (await get('/app.js')).headers.get('last-modified');
  assert.equal((await get('/app.js', { 'if-modified-since': modified })).status, 304);
  const later = new Date(Date.parse(modified) + 3600000).toUTCString();
  assert.equal((await get('/app.js', { 'if-modified-since': later })).status, 304);
  const earlier = new Date(Date.parse(modified) - 1000).toUTCString();
  assert.equal((await get('/app.js', { 'if-modified-since': earlier })).status, 200);
  assert.equal((await get('/app.js', { 'if-modified-since': 'last tuesday' })).status, 200, 'an unreadable date is ignored');
  // If-None-Match decides when both are sent: a stale ETag means 200 whatever the date says.
  assert.equal((await get('/app.js', { 'if-none-match': 'W/"1-1"', 'if-modified-since': later })).status, 200);
});

test('HEAD answers 304 too, other methods are left alone, and the app shell and fallback work the same way', async () => {
  const etag = (await get('/app.js')).headers.get('etag');
  assert.equal((await get('/app.js', { 'if-none-match': etag }, 'HEAD')).status, 304);
  const post = await get('/app.js', { 'if-none-match': etag }, 'POST');
  assert.equal(post.status, 200, 'only GET and HEAD are conditional');
  await post.text();

  for (const url of ['/', '/index.html', '/some/screen/the/server/does/not/know']) {
    const res = await get(url);
    assert.equal(res.status, 200, url);
    assert.match(res.headers.get('content-type'), /html/, url);
    if (!url.includes('some/screen')) assert.equal(res.headers.get('cache-control'), 'no-cache', url);
    await res.text();
    const tag = res.headers.get('etag');
    assert.ok(tag, url);
    assert.equal((await get(url, { 'if-none-match': tag })).status, 304, url);
  }
});

test('a file that is not there, and paths that try to leave public/, are never served as files', async () => {
  for (const url of ['/%2e%2e/package.json', '/..%2fpackage.json', '/a/../../package.json']) {
    const res = await get(url);
    const text = await res.text();
    assert.ok(!text.includes('"oath-app"'), `${url} must not serve package.json`);
  }
  assert.equal(publicFile('./public', '/../package.json'), null);
  assert.equal(publicFile('./public', '/nothing-here.js'), null);
  assert.equal(publicFile('./public', '/%2e%2e/package.json'), null);
  assert.equal(publicFile('./public', '/fonts'), null, 'a folder without an index is not a file');
  assert.ok(publicFile('./public', '/')?.path.endsWith('index.html'), 'the root is the index');
});

test('a changed file gets a new ETag, so the old one no longer matches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-static-'));
  const file = path.join(root, 'app.js');
  fs.writeFileSync(file, 'console.log(1);');
  fs.utimesSync(file, new Date('2026-10-01T10:00:00Z'), new Date('2026-10-01T10:00:00Z'));
  const site = new Hono();
  site.use('*', conditionalGet((c) => publicFile(root, c.req.path)));
  site.use('*', serveStatic({ root }));
  const ask = (headers) => site.request('/app.js', { headers });

  const before = await ask({});
  const etag = before.headers.get('etag');
  assert.equal(before.headers.get('last-modified'), 'Thu, 01 Oct 2026 10:00:00 GMT');
  assert.equal((await ask({ 'if-none-match': etag })).status, 304);

  fs.writeFileSync(file, 'console.log(22);'); // a new size
  fs.utimesSync(file, new Date('2026-10-02T10:00:00Z'), new Date('2026-10-02T10:00:00Z'));
  const stale = await ask({ 'if-none-match': etag, 'if-modified-since': before.headers.get('last-modified') });
  assert.equal(stale.status, 200, 'the old ETag does not match the new file');
  assert.equal(await stale.text(), 'console.log(22);');
  assert.notEqual(stale.headers.get('etag'), etag);

  // Same size, only the time moves on (a redeploy of an identical-length file).
  fs.writeFileSync(file, 'console.log(33);');
  fs.utimesSync(file, new Date('2026-10-03T10:00:00Z'), new Date('2026-10-03T10:00:00Z'));
  assert.equal((await ask({ 'if-none-match': stale.headers.get('etag') })).status, 200);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------- Open Food Facts User-Agent ----------

test('the Open Food Facts User-Agent names the app by its configured address, never one written in the source', () => {
  const keep = { ...process.env };
  try {
    for (const k of ['PUBLIC_URL', 'APP_URL', 'PUBLIC_HOST', 'RAILWAY_PUBLIC_DOMAIN']) delete process.env[k];
    assert.equal(off.userAgent(), 'Oath/1.0 (personal food diary)', 'generic with nothing configured');
    process.env.RAILWAY_PUBLIC_DOMAIN = 'oath.example.up.railway.app';
    assert.equal(off.userAgent(), 'Oath/1.0 (personal food diary; https://oath.example.up.railway.app)');
    process.env.PUBLIC_HOST = 'oath.example.org';
    assert.equal(off.userAgent(), 'Oath/1.0 (personal food diary; https://oath.example.org)', 'a custom domain wins, as elsewhere');
    process.env.APP_URL = 'https://app.example.net';
    assert.equal(off.userAgent(), 'Oath/1.0 (personal food diary; https://app.example.net)');
  } finally {
    for (const k of ['PUBLIC_URL', 'APP_URL', 'PUBLIC_HOST', 'RAILWAY_PUBLIC_DOMAIN']) {
      if (keep[k] === undefined) delete process.env[k];
      else process.env[k] = keep[k];
    }
  }
  const source = fs.readFileSync('src/off.js', 'utf8');
  assert.ok(!/railway\.app/.test(source), 'no production hostname in the source');
});
