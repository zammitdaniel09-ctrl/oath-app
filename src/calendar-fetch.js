// Fetching a calendar feed safely: the address normalised (webcal, Google and Outlook share links), only
// public hosts (every DNS answer checked, again on each redirect), a size cap, a timeout, gzip, and errors
// in words.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { RuleError } from './engine.js';

const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const USER_AGENT = 'Oath/1.0 (personal calendar sync)';

// Tests serve feeds from a local http server: allow loopback and plain http there, let them point
// https:// links at it, and shorten the fetch timeout.
const testHooks = { allowLocal: false, rewriteUrl: null, timeoutMs: null };
export function setCalendarTestHooks(hooks = {}) {
  Object.assign(testHooks, hooks);
}
const localAllowed = () => process.env.NODE_ENV === 'test' || Boolean(testHooks.allowLocal);

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const dotted = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (dotted) return isPrivateIp(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
    if (hex) {
      const hi = Number.parseInt(hex[1], 16);
      const lo = Number.parseInt(hex[2], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x);
  }
  return true;
}

const privateHostError = () => new RuleError('That link points to a private network address. Use the public calendar link.');

function checkHost(hostname) {
  if (localAllowed()) return;
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) throw new RuleError('That link has no server name.');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw privateHostError();
    return;
  }
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) throw privateHostError();
}

// webcal:// becomes https://; only https is fetched (plain http and loopback only in tests).
export function normalizeFeedUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) throw new RuleError('Paste the calendar link.');
  if (s.length > 2000) throw new RuleError('That link is too long.');
  s = s.replace(/^webcals?:\/\//i, 'https://');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new RuleError('That does not look like a link. It should start with https:// or webcal://.');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && localAllowed())) {
    throw new RuleError(u.protocol === 'http:'
      ? 'Use the secure link: it should start with https:// or webcal://.'
      : 'Calendar links start with https:// or webcal://.');
  }
  if (u.username || u.password) throw new RuleError('Links with a user name or password inside are not supported.');
  checkHost(u.hostname);
  u.hash = '';
  return u.toString();
}

// DNS lookup that refuses private addresses, so a public name pointing inside the network (or
// changing its answer between check and connect) cannot reach internal services.
function guardedLookup(hostname, options, callback) {
  const opts = typeof options === 'number' ? { family: options } : { ...(options || {}) };
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!localAllowed() && addresses.some((a) => isPrivateIp(a.address))) {
      return callback(Object.assign(new Error('private address'), { code: 'EPRIVATE' }));
    }
    if (opts.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function getOnce(url, msLeft) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method: 'GET',
      lookup: guardedLookup,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5',
        'accept-encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return finish(resolve, { status, location: res.headers.location || '' });
      }
      if (status !== 200) {
        res.resume();
        return finish(resolve, { status });
      }
      const tooBig = Object.assign(new Error('too big'), { code: 'ETOOBIG' });
      if (Number(res.headers['content-length'] || 0) > MAX_BYTES) {
        req.destroy();
        return finish(reject, tooBig);
      }
      const enc = String(res.headers['content-encoding'] || '').trim().toLowerCase();
      let stream = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy();
          finish(reject, tooBig);
        } else chunks.push(chunk);
      });
      stream.on('end', () => finish(resolve, { status, buffer: Buffer.concat(chunks) }));
      stream.on('error', (e) => finish(reject, e));
      res.on('error', (e) => finish(reject, e));
      res.on('aborted', () => finish(reject, Object.assign(new Error('aborted'), { code: 'ECONNRESET' })));
    });
    timer = setTimeout(() => {
      req.destroy();
      finish(reject, Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    }, Math.max(1, msLeft));
    req.on('error', (e) => finish(reject, e));
    req.end();
  });
}

function fetchError(err, url) {
  if (err instanceof RuleError) return err;
  const host = url.hostname;
  switch (err.code) {
    case 'ETIMEDOUT': return new RuleError('The calendar server took longer than 15 seconds to answer. Try again later.');
    case 'ENOTFOUND':
    case 'EAI_AGAIN': return new RuleError(`Could not find the server ${host}. Check the link.`);
    case 'EPRIVATE': return privateHostError();
    case 'ECONNREFUSED': return new RuleError(`${host} refused the connection. Try again later.`);
    case 'ECONNRESET': return new RuleError(`${host} dropped the connection. Try again later.`);
    case 'ETOOBIG': return new RuleError('That calendar is larger than 10 MB, too big to sync.');
    default:
      if (/CERT|SSL|TLS|EPROTO/i.test(`${err.code} ${err.message}`)) return new RuleError(`The secure connection to ${host} failed.`);
      return new RuleError(`Could not fetch the calendar from ${host} (${err.code || 'network error'}).`);
  }
}

function statusError(status) {
  if (status === 401 || status === 403) {
    return new RuleError(`The calendar server refused access (error ${status}). The link may be private, expired or reset. Copy a fresh link.`);
  }
  if (status === 404 || status === 410) {
    return new RuleError(`Nothing was found at that link (error ${status}). Check you copied the whole address, or copy a fresh one.`);
  }
  if (status === 429) return new RuleError('The calendar server says too many requests. Oath will try again later.');
  if (status >= 500) return new RuleError(`The calendar server had a problem (error ${status}). Oath will try again later.`);
  return new RuleError(`The calendar server answered with error ${status}.`);
}

// GET a feed: 15 s overall, at most 10 MB, redirects followed (each hop checked again).
export async function fetchCalendar(rawUrl) {
  const deadline = Date.now() + (testHooks.timeoutMs || FETCH_TIMEOUT_MS);
  let url = new URL(normalizeFeedUrl(rawUrl));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = testHooks.rewriteUrl ? new URL(testHooks.rewriteUrl(url.toString())) : url;
    let res;
    try {
      res = await getOnce(target, deadline - Date.now());
    } catch (err) {
      throw fetchError(err, url);
    }
    if (res.location !== undefined) {
      if (!res.location) throw statusError(res.status);
      url = new URL(normalizeFeedUrl(new URL(res.location, url).toString()));
      continue;
    }
    if (res.status !== 200) throw statusError(res.status);
    return res.buffer;
  }
  throw new RuleError('That link redirected too many times.');
}
