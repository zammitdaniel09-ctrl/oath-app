// Business: the morning numbers of Daniel's own sites (GoldenStraddler, Exposed FX Journal and any
// later one) on one dashboard. Each site answers GET /api/oath/summary with its own Bearer token:
//   { site, url, generatedAt, metrics: [{ key, label, value, unit, format, change, series }],
//     status: { ok, text }, events: [{ at, text }], alerts: [text] }
//
// BUSINESS_SOURCES is a JSON array in the environment:
//   [{ "name": "GoldenStraddler", "url": "https://goldenstraddler.com/api/oath/summary", "token": "..." }]
// Entries without a name, an https address (http only for this machine) or a token are ignored.
//
// All sources are fetched in parallel, 10 s each, and the result is kept in kv 'business':
//   { fetchedAt, sources: [{ name, ok, error, data, fetchedAt, checkedAt }] }
// A source's fetchedAt is when its numbers arrived and checkedAt when it was last asked. A site
// that fails keeps its last good numbers (ok false, with the error), so a site that is down for a
// moment doesn't blank the dashboard. Tokens never leave the server and are never stored.
import { Hono } from 'hono';
import { DateTime } from 'luxon';
import { getKV, setKV } from './db.js';
import { nowUTC } from './time.js';

const KV_KEY = 'business';
const FETCH_TIMEOUT_MS = 10000;
const MAX_BYTES = 512 * 1024;
const MAX_SOURCES = 12;
const FORMATS = new Set(['money', 'count', 'percent', 'number']);

// Tests serve summaries from a local http server and shorten the timeout.
const testHooks = { timeoutMs: null };
export function setBusinessTestHooks(hooks = {}) {
  Object.assign(testHooks, hooks);
}

// ---------- Sources ----------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
let warnedFor = null;

function validUrl(raw) {
  if (typeof raw !== 'string') return null;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  // A token sent over plain http could be read on the way, so http is only for this machine.
  if (u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) return u.toString();
  return null;
}

export function businessSources() {
  const raw = (process.env.BUSINESS_SOURCES || '').trim();
  if (!raw) return [];
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    if (warnedFor !== raw) console.error('BUSINESS_SOURCES is not valid JSON; no business sources are used');
    warnedFor = raw;
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  const names = new Set();
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const name = typeof s.name === 'string' ? s.name.trim().slice(0, 60) : '';
    const url = validUrl(s.url);
    const token = typeof s.token === 'string' ? s.token.trim() : '';
    if (!name || !url || !token || /\s/.test(token) || names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());
    out.push({ name, url, token });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}

// ---------- Fetching ----------

const str = (v, n = 200) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isoOrNull = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

// Only the fields the dashboard shows, of the right types and sizes, whatever a site sends.
function cleanSummary(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || !Array.isArray(d.metrics)) throw new Error("The answer isn't a summary.");
  const metrics = d.metrics
    .filter((m) => m && typeof m === 'object' && str(m.key, 60) && num(m.value) !== null)
    .slice(0, 12)
    .map((m) => {
      const out = { key: str(m.key, 60), label: str(m.label, 80) || str(m.key, 60), value: num(m.value), format: FORMATS.has(m.format) ? m.format : 'number' };
      if (str(m.unit, 12)) out.unit = str(m.unit, 12);
      if (num(m.change) !== null) out.change = num(m.change);
      if (Array.isArray(m.series)) {
        out.series = m.series
          .filter((p) => p && typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && num(p.value) !== null)
          .slice(-60)
          .map((p) => ({ date: p.date, value: p.value }));
      }
      return out;
    });
  const status = d.status && typeof d.status === 'object' ? { ok: Boolean(d.status.ok), text: str(d.status.text) } : null;
  const events = (Array.isArray(d.events) ? d.events : [])
    .filter((e) => e && str(e.text) && isoOrNull(e.at))
    .slice(0, 10)
    .map((e) => ({ at: isoOrNull(e.at), text: str(e.text) }));
  const alerts = (Array.isArray(d.alerts) ? d.alerts : []).map((a) => str(a)).filter(Boolean).slice(0, 10);
  const url = str(d.url, 300);
  return {
    site: str(d.site, 80),
    url: /^https?:\/\//.test(url) ? url : '',
    generatedAt: isoOrNull(d.generatedAt),
    metrics,
    status,
    events,
    alerts,
  };
}

async function readLimited(res) {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_BYTES) throw new Error('The answer is too large.');
  if (!res.body) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('The answer is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function statusError(status) {
  if (status === 401 || status === 403) return new Error(`The site refused the token (${status}).`);
  if (status === 404) return new Error('Not found (404): is OATH_SUMMARY_TOKEN set on the site, and is the address right?');
  if (status === 429) return new Error('The site says too many tries (429). Check the token.');
  if (status >= 300 && status < 400) return new Error(`The site redirected (${status}). Use the final address.`);
  return new Error(`The site answered ${status}.`);
}

async function fetchSummary(source) {
  const ms = testHooks.timeoutMs || FETCH_TIMEOUT_MS;
  const signal = AbortSignal.timeout(ms);
  try {
    // A redirect could carry the token to another address, so none is followed.
    const res = await fetch(source.url, {
      headers: { authorization: `Bearer ${source.token}`, accept: 'application/json', 'user-agent': 'Oath/1.0 (business summary)' },
      redirect: 'manual',
      signal,
    });
    if (res.status !== 200) {
      res.body?.cancel().catch(() => {});
      throw statusError(res.status);
    }
    const text = await readLimited(res);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("The answer wasn't JSON.");
    }
    return cleanSummary(data);
  } catch (err) {
    if (signal.aborted || err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new Error(`No answer within ${Math.round(ms / 100) / 10} s.`);
    if (err?.message === 'fetch failed') throw new Error(`Couldn't reach the site${err.cause?.code ? ` (${err.cause.code})` : ''}.`);
    throw err;
  }
}

// ---------- Refresh and cache ----------

let inflight = null;

async function doRefresh() {
  const sources = businessSources();
  const prev = await getKV(KV_KEY, null);
  const before = new Map((prev?.sources || []).map((s) => [s.name, s]));
  const results = await Promise.all(sources.map(async (s) => {
    const old = before.get(s.name);
    try {
      const data = await fetchSummary(s);
      const at = nowUTC().toISO();
      return { name: s.name, ok: true, error: null, data, fetchedAt: at, checkedAt: at };
    } catch (err) {
      return { name: s.name, ok: false, error: String(err?.message || err).slice(0, 200), data: old?.data ?? null, fetchedAt: old?.fetchedAt ?? null, checkedAt: nowUTC().toISO() };
    }
  }));
  const value = { fetchedAt: nowUTC().toISO(), sources: results };
  await setKV(KV_KEY, value);
  return value;
}

// One refresh at a time: a second caller waits for the one already running.
export function refreshBusiness() {
  if (!inflight) inflight = doRefresh().finally(() => { inflight = null; });
  return inflight;
}

const minutesSince = (iso) => nowUTC().diff(DateTime.fromISO(iso, { zone: 'utc' })).as('minutes');

export async function businessSummary({ maxAgeMin = 10 } = {}) {
  const sources = businessSources();
  if (!sources.length) return { configured: false, sources: [] };
  let cache = await getKV(KV_KEY, null);
  const sameSources = cache && Array.isArray(cache.sources) && cache.sources.map((s) => s.name).join('\n') === sources.map((s) => s.name).join('\n');
  const age = Number(maxAgeMin);
  const tooOld = !cache?.fetchedAt || !(minutesSince(cache.fetchedAt) < (Number.isFinite(age) ? age : 10));
  if (!sameSources || tooOld) cache = await refreshBusiness();
  return { configured: true, fetchedAt: cache.fetchedAt, sources: cache.sources };
}

// ---------- Coach ----------

const nf = (d) => new Intl.NumberFormat('en-GB', { maximumFractionDigits: d });

function valueText(m) {
  if (m.format === 'money' && /^[A-Z]{3}$/.test(m.unit || '')) {
    const d = Number.isInteger(m.value) ? 0 : 2;
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: m.unit, minimumFractionDigits: d, maximumFractionDigits: d }).format(m.value);
  }
  if (m.format === 'percent') return `${nf(1).format(m.value)}%`;
  const v = nf(m.format === 'count' ? 0 : 2).format(m.value);
  return m.unit ? `${v} ${m.unit}` : v;
}

function metricText(m) {
  const ch = typeof m.change === 'number' && m.change !== 0 ? ` (${m.change > 0 ? 'up' : 'down'} ${nf(1).format(Math.abs(m.change))}% on the period before)` : '';
  return `${m.label}: ${valueText(m)}${ch}`;
}

// A few plain lines for the coach's context: each site's headline numbers and what needs Daniel,
// or '' when no business source is set up.
export async function businessForCoach() {
  try {
    const sum = await businessSummary({ maxAgeMin: 60 });
    if (!sum.configured) return '';
    const lines = ['Business (Daniel\'s own sites):'];
    for (const s of sum.sources) {
      if (!s.data) {
        lines.push(`  ${s.name}: no numbers yet${s.error ? ` (${s.error.replace(/\.$/, '')})` : ''}.`);
        continue;
      }
      const head = s.data.metrics.slice(0, 4).map(metricText).join('; ');
      const stale = !s.ok && s.fetchedAt ? ` These are from ${DateTime.fromISO(s.fetchedAt).toUTC().toFormat('d LLL HH:mm')} UTC; the latest check failed.` : '';
      lines.push(`  ${s.name}: ${head || 'no numbers'}.${s.data.status?.text ? ` Status: ${s.data.status.text}.` : ''}${stale}`);
      if (s.data.alerts.length) lines.push(`  ${s.name} needs: ${s.data.alerts.slice(0, 4).join('; ')}.`);
    }
    return lines.join('\n');
  } catch (err) {
    console.error('business for coach failed', err.message);
    return '';
  }
}

// ---------- API (mounted under the authenticated /api) ----------

export const businessApi = new Hono();
businessApi.get('/business', async (c) => {
  const force = ['1', 'true'].includes(c.req.query('refresh') || '');
  return c.json(await businessSummary(force ? { maxAgeMin: 0 } : {}));
});
