import crypto from 'node:crypto';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { db } from './db.js';

const COOKIE = 'oath_session';
const MAX_AGE = 60 * 60 * 24 * 400; // 400 days: log in once per device

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

export async function ownerExists() {
  const rows = await db()`select 1 from owner where id = 1`;
  return rows.length > 0;
}

async function startSession(c) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db()`insert into sessions (token_hash, user_agent) values (${sha256(token)}, ${c.req.header('user-agent') || ''})`;
  const secure = new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
  setCookie(c, COOKIE, token, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: MAX_AGE });
}

// Simple lockout against password guessing: 5 failures locks login for 15 minutes.
const failures = { count: 0, until: 0 };

export function loginLocked() {
  return Date.now() < failures.until;
}

function recordFailure() {
  failures.count += 1;
  if (failures.count >= 5) {
    failures.until = Date.now() + 15 * 60 * 1000;
    failures.count = 0;
  }
}

export async function setup(c, { code, password }) {
  if (await ownerExists()) return { error: 'Setup is already done. Log in instead.', status: 409 };
  const expected = process.env.SETUP_CODE;
  if (!expected) return { error: 'SETUP_CODE is not configured on the server.', status: 500 };
  const a = Buffer.from(String(code || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    recordFailure();
    return { error: 'This setup link is not valid.', status: 403 };
  }
  if (typeof password !== 'string' || password.length < 10) {
    return { error: 'Use at least 10 characters.', status: 400 };
  }
  await db()`insert into owner (id, password_hash) values (1, ${await hashPassword(password)})`;
  await startSession(c);
  return { ok: true };
}

export async function login(c, { password }) {
  if (loginLocked()) return { error: 'Too many attempts. Try again in 15 minutes.', status: 429 };
  const rows = await db()`select password_hash from owner where id = 1`;
  if (!rows.length) return { error: 'Setup has not been done yet.', status: 409 };
  if (typeof password !== 'string' || !(await verifyPassword(password, rows[0].password_hash))) {
    recordFailure();
    return { error: 'Wrong password.', status: 401 };
  }
  failures.count = 0;
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
  if (typeof next !== 'string' || next.length < 10) return { error: 'Use at least 10 characters.', status: 400 };
  await db()`update owner set password_hash = ${await hashPassword(next)} where id = 1`;
  return { ok: true };
}

export async function isAuthed(c) {
  const token = getCookie(c, COOKIE);
  if (!token) return false;
  const rows = await db()`update sessions set last_seen = now() where token_hash = ${sha256(token)} returning 1`;
  return rows.length > 0;
}

export function requireAuth() {
  return async (c, next) => {
    if (!(await isAuthed(c))) return c.json({ error: 'Log in first.' }, 401);
    await next();
  };
}
