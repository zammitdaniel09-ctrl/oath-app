import crypto from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db } from './db.js';
import { verifyPasskeyLogin, passkeyCount } from './passkeys.js';
import { getSettings } from './engine.js';
import { nowUTC } from './time.js';

const COOKIE = 'oath_session';
const MAX_AGE = 60 * 60 * 24 * 400; // 400 days: log in once per device
// With the Face ID lock on, a session stays open while it is used and locks after this long idle.
const UNLOCKED_MIN = 15;
// A session nobody has used for this long is gone, whatever the cookie says.
const SESSION_IDLE_DAYS = 180;

function scryptHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptHash(password, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [, saltHex, keyHex] = stored.split('$');
  const key = await scryptHash(password, Buffer.from(saltHex, 'hex'));
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// The shortest password Oath takes; his choice, so it is easy to type on a computer.
export const MIN_PASSWORD = 8;

export async function ownerExists() {
  const rows = await db()`select 1 from owner where id = 1`;
  return rows.length > 0;
}

// Face ID only: on once a passkey exists, unless switched off in Settings.
export async function faceIdOnly() {
  if ((await getSettings()).faceIdLock === false) return false;
  return (await passkeyCount()) > 0;
}

// With Face ID only, the password still opens Oath on its own when he has switched this on in Settings
// (for a computer, where Face ID means his phone); otherwise it needs the recovery code too.
export async function passwordAlone() {
  return (await getSettings()).passwordAlone === true;
}

const unlockedUntil = () => nowUTC().plus({ minutes: UNLOCKED_MIN }).toJSDate();

// A fresh login replaces this device's previous session, so locked ones do not pile up.
async function startSession(c) {
  const old = getCookie(c, COOKIE);
  if (old) await db()`delete from sessions where token_hash = ${sha256(old)}`;
  const token = crypto.randomBytes(32).toString('base64url');
  await db()`insert into sessions (token_hash, user_agent, last_seen, unlocked_until)
             values (${sha256(token)}, ${c.req.header('user-agent') || ''}, ${nowUTC().toJSDate()}, ${unlockedUntil()})`;
  const secure = new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
  setCookie(c, COOKIE, token, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: MAX_AGE });
}

// Lockout against password guessing. Five failures from one address lock that address out for 15
// minutes, so nobody else on the internet can lock Daniel out. As a backstop for an attacker who
// changes address (or fakes the header), 50 failures in an hour from anywhere stop password logins
// for everyone until the hour has passed. Face ID is never counted and never locked: a passkey
// cannot be guessed.
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;
const ALL_MAX = 50;
const ALL_WINDOW_MS = 60 * 60 * 1000;
const MAX_ADDRESSES = 500;

const byAddress = new Map(); // address -> { times: [ms of recent failures], until: ms }
let allFailures = []; // ms of every failure in the last hour, any address

const clock = () => nowUTC().toMillis();

// Railway sits behind a proxy, so the caller's address is the first value of x-forwarded-for.
export function clientIp(c) {
  const forwarded = (c.req.header('x-forwarded-for') || '').split(',')[0].trim();
  return (forwarded || c.env?.incoming?.socket?.remoteAddress || 'unknown').slice(0, 64);
}

// Why this address may not try a password now, or null when it may. A phone that already holds a session
// of his (locked behind Face ID, say) is spared the backstop, so strangers spraying the login cannot keep
// his own recovery shut.
function lockedOut(ip, known = false) {
  const now = clock();
  allFailures = allFailures.filter((t) => now - t < ALL_WINDOW_MS);
  if (allFailures.length >= ALL_MAX && !known) return 'Too many attempts. Try again in an hour.';
  if (now < (byAddress.get(ip)?.until || 0)) return 'Too many attempts. Try again in 15 minutes.';
  return null;
}

function recordFailure(ip) {
  const now = clock();
  allFailures.push(now);
  const seen = byAddress.get(ip) || { times: [], until: 0 };
  seen.times = seen.times.filter((t) => now - t < LOCK_MS);
  seen.times.push(now);
  if (seen.times.length >= LOCK_AFTER) {
    seen.until = now + LOCK_MS;
    seen.times = [];
  }
  // Most recent last, so the oldest address is the one dropped when the table is full.
  byAddress.delete(ip);
  byAddress.set(ip, seen);
  if (byAddress.size > MAX_ADDRESSES) byAddress.delete(byAddress.keys().next().value);
}

export async function setup(c, { code, password }) {
  if (await ownerExists()) return { error: 'Setup is already done. Log in instead.', status: 409 };
  const ip = clientIp(c);
  const locked = lockedOut(ip);
  if (locked) return { error: locked, status: 429 };
  const expected = process.env.SETUP_CODE;
  if (!expected) return { error: 'SETUP_CODE is not configured on the server.', status: 500 };
  const a = Buffer.from(String(code || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    recordFailure(ip);
    return { error: 'This setup link is not valid.', status: 403 };
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return { error: `Use at least ${MIN_PASSWORD} characters.`, status: 400 };
  }
  await db()`insert into owner (id, password_hash) values (1, ${await hashPassword(password)})`;
  await startSession(c);
  return { ok: true };
}

// Whether the request carries a session this server issued, whatever its lock state.
async function knownSession(c) {
  const token = getCookie(c, COOKIE);
  if (!token) return false;
  const [row] = await db()`select 1 as ok from sessions where token_hash = ${sha256(token)}`.catch(() => []);
  return Boolean(row);
}

export async function login(c, { password, recovery }) {
  const ip = clientIp(c);
  const locked = lockedOut(ip, await knownSession(c));
  if (locked) return { error: locked, status: 429 };
  const rows = await db()`select password_hash from owner where id = 1`;
  if (!rows.length) return { error: 'Setup has not been done yet.', status: 409 };
  // With Face ID only, the password alone is not enough unless he allows it: it needs the recovery code
  // too, which is SETUP_CODE in Railway, for the day Face ID is lost.
  if ((await faceIdOnly()) && !(await passwordAlone())) {
    const expected = process.env.SETUP_CODE || '';
    // Without SETUP_CODE in Railway there is no recovery code to match; that is not his mistake, so it is
    // not counted against him.
    if (!expected) return { error: 'The recovery code is not set on the server: add SETUP_CODE in Railway.', status: 503 };
    // Pasted or typed on a phone, a code picks up stray spaces.
    const given = Buffer.from(String(recovery || '').trim());
    if (given.length !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(given, Buffer.from(expected))) {
      recordFailure(ip);
      return given.length
        ? { error: 'That recovery code is not right. It is SETUP_CODE in Railway, exactly as written there.', status: 403 }
        : { error: 'Oath opens with Face ID only. Without Face ID, use your password with the recovery code.', status: 403 };
    }
  }
  if (typeof password !== 'string' || !(await verifyPassword(password, rows[0].password_hash))) {
    recordFailure(ip);
    return { error: 'Wrong password.', status: 401 };
  }
  byAddress.delete(ip);
  await startSession(c);
  return { ok: true };
}

// Face ID login: a verified passkey opens the same kind of session as the password. It sits outside
// the password lockout: a failed attempt is not counted, and a locked address can still use it.
export async function passkeyLogin(c, response) {
  try {
    await verifyPasskeyLogin(c, response);
  } catch (err) {
    return { error: err.message, status: err.status || 401 };
  }
  await startSession(c);
  return { ok: true };
}

export async function logout(c) {
  const token = getCookie(c, COOKIE);
  if (token) await db()`delete from sessions where token_hash = ${sha256(token)}`;
  deleteCookie(c, COOKIE, { path: '/' });
}

export async function changePassword(current, next) {
  const rows = await db()`select password_hash from owner where id = 1`;
  if (!rows.length || !(await verifyPassword(String(current || ''), rows[0].password_hash))) {
    return { error: 'Current password is wrong.', status: 401 };
  }
  if (typeof next !== 'string' || next.length < MIN_PASSWORD) return { error: `Use at least ${MIN_PASSWORD} characters.`, status: 400 };
  await db()`update owner set password_hash = ${await hashPassword(next)} where id = 1`;
  return { ok: true };
}

// With Face ID only, a session counts only while unlocked, and every request keeps it unlocked for
// another 15 minutes, so one in use stays open. Idle longer than that, or locked by the app on
// opening, it needs Face ID again. Sessions unused for 180 days expire whatever the lock says.
export async function isAuthed(c) {
  const token = getCookie(c, COOKIE);
  if (!token) return false;
  const now = nowUTC().toJSDate();
  const [row] = await db()`select unlocked_until, last_seen from sessions where token_hash = ${sha256(token)}`;
  if (!row) return false;
  if (sessionExpired(row.last_seen)) {
    await db()`delete from sessions where token_hash = ${sha256(token)}`;
    return false;
  }
  if (await faceIdOnly()) {
    if (!row.unlocked_until || new Date(row.unlocked_until) <= now) return false;
    await db()`update sessions set last_seen = ${now}, unlocked_until = ${unlockedUntil()} where token_hash = ${sha256(token)}`;
  } else {
    await db()`update sessions set last_seen = ${now} where token_hash = ${sha256(token)}`;
  }
  return true;
}

// Face ID was just used on this device (to make a passkey), so the session is unlocked as if it had
// just logged in.
export async function unlockSession(c) {
  const token = getCookie(c, COOKIE);
  if (token) await db()`update sessions set unlocked_until = ${unlockedUntil()} where token_hash = ${sha256(token)}`;
}

// The app locks its own session every time it is opened, so opening it always asks for Face ID.
export async function lockSession(c) {
  const token = getCookie(c, COOKIE);
  if (token) await db()`update sessions set unlocked_until = null where token_hash = ${sha256(token)}`;
}

// Signed in on this device, Face ID or not. The login screen uses it to show "unlock" rather than
// "log in".
export async function hasSession(c) {
  const token = getCookie(c, COOKIE);
  if (!token) return false;
  const [row] = await db()`select last_seen from sessions where token_hash = ${sha256(token)}`;
  return Boolean(row) && !sessionExpired(row.last_seen);
}

const sessionCutoff = () => nowUTC().minus({ days: SESSION_IDLE_DAYS });
const sessionExpired = (lastSeen) => !lastSeen || new Date(lastSeen) < sessionCutoff().toJSDate();

// The daily upkeep drops expired sessions that were never presented again; returns how many.
export async function pruneSessions() {
  const gone = await db()`delete from sessions where last_seen < ${sessionCutoff().toJSDate()}`;
  return gone.count;
}

export function requireAuth() {
  return async (c, next) => {
    if (!(await isAuthed(c))) return c.json({ error: 'Log in first.' }, 401);
    await next();
  };
}
