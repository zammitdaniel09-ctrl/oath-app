// Face ID login end to end: a software authenticator (a real P-256 key, like the iPhone's Secure
// Enclave makes) registers a passkey and logs in with it, against a real Postgres.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { DateTime } from 'luxon';

let clock = DateTime.utc();
const later = (minutes) => { clock = clock.plus({ minutes }); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oath-faceid-pg-'));
fs.chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({
  databaseDir: path.join(dir, 'data'), user: 'postgres', password: 'test', port: 54351,
  persistent: false, createPostgresUser: process.platform !== 'win32', initdbFlags: ['--encoding=UTF8', '--locale=C'], postgresFlags: ['-c', 'io_method=sync'], onLog: () => {}, onError: () => {},
});

let app; let cookie = ''; let dbmod;
const ORIGIN = 'http://localhost';

async function call(method, url, json) {
  const headers = { cookie };
  if (json !== undefined || method !== 'GET') headers['content-type'] = 'application/json';
  const res = await app.request(`${ORIGIN}${url}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('oath');
  process.env.DATABASE_URL = 'postgres://postgres:test@localhost:54351/oath';
  process.env.SETUP_CODE = 'setup-code-for-tests-123';
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
  delete process.env.PUBLIC_HOST;
  const time = await import('../src/time.js');
  time.setClock(() => clock);
  dbmod = await import('../src/db.js');
  dbmod.connect();
  await dbmod.migrate();
  ({ app } = await import('../src/server.js'));
  const s = await call('POST', '/api/setup', { code: process.env.SETUP_CODE, password: 'long-enough-pass' });
  assert.equal(s.status, 200);
});

after(async () => {
  await dbmod.close();
  // Windows can keep the data folder locked after stopping; a leftover temp folder is harmless.
  await pg.stop().catch((err) => { if (process.platform !== 'win32') throw err; });
});

// ---------- A software authenticator ----------

const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const counterBytes = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const UP = 0x01; const UV = 0x04; const AT = 0x40;

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' });
const credId = crypto.randomBytes(16);
const coseKey = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));

function clientData(type, challenge) {
  return Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
}

function attestation(options, flags = UP | UV | AT) {
  const authData = Buffer.concat([
    sha256(options.rp.id), Buffer.from([flags]), counterBytes(0),
    Buffer.alloc(16), Buffer.from([0, credId.length]), credId, Buffer.from(coseKey),
  ]);
  const attestationObject = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
  return {
    id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
    response: { clientDataJSON: b64u(clientData('webauthn.create', options.challenge)), attestationObject: b64u(attestationObject), transports: ['internal'] },
  };
}

function assertion(options, { counter, flags = UP | UV, id = credId } = {}) {
  const authData = Buffer.concat([sha256('localhost'), Buffer.from([flags]), counterBytes(counter)]);
  const cd = clientData('webauthn.get', options.challenge);
  const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(cd)]), privateKey);
  return {
    id: b64u(id), rawId: b64u(id), type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
    response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: b64u('oath-owner') },
  };
}

// ---------- Tests ----------

test('Face ID can only be added from a logged-in session', async () => {
  const saved = cookie;
  cookie = '';
  assert.equal((await call('POST', '/api/passkey/register/options', {})).status, 401);
  cookie = saved;
});

test('adding Face ID: the passkey is stored and the login screen offers it', async () => {
  assert.equal((await call('GET', '/api/session')).data.faceId, false);
  const options = (await call('POST', '/api/passkey/register/options', {})).data;
  assert.equal(options.rp.id, 'localhost');
  assert.equal(options.authenticatorSelection.userVerification, 'required');
  const r = await call('POST', '/api/passkey/register', { response: attestation(options), device: 'iPhone' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const list = (await call('GET', '/api/passkeys')).data.passkeys;
  assert.equal(list.length, 1);
  assert.equal(list[0].device, 'iPhone');
  assert.equal((await call('GET', '/api/session')).data.faceId, true);
  const setup = (await call('GET', '/api/setup-status')).data;
  assert.equal(setup.items.find((i) => i.id === 'faceid').ok, true);
});

test('a registration without Face ID (user verification) is refused', async () => {
  const options = (await call('POST', '/api/passkey/register/options', {})).data;
  const r = await call('POST', '/api/passkey/register', { response: attestation(options, UP | AT) });
  assert.equal(r.status, 400);
});

test('logging in with Face ID opens a session; a replay and a missing Face ID check are refused', async () => {
  await call('POST', '/api/logout', {});
  assert.equal((await call('GET', '/api/today')).status, 401);

  let options = (await call('POST', '/api/passkey/login/options', {})).data;
  assert.equal(options.userVerification, 'required');
  const good = assertion(options, { counter: 1 });
  const ok = await call('POST', '/api/passkey/login', { response: good });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await call('GET', '/api/today')).status, 200);
  assert.ok((await call('GET', '/api/passkeys')).data.passkeys[0].lastUsed);

  await call('POST', '/api/logout', {});
  const replay = await call('POST', '/api/passkey/login', { response: good });
  assert.equal(replay.status, 401, 'a used challenge cannot log in again');

  options = (await call('POST', '/api/passkey/login/options', {})).data;
  const noFace = await call('POST', '/api/passkey/login', { response: assertion(options, { counter: 2, flags: UP }) });
  assert.equal(noFace.status, 401, 'presence without Face ID is not enough');

  options = (await call('POST', '/api/passkey/login/options', {})).data;
  const stranger = await call('POST', '/api/passkey/login', { response: assertion(options, { counter: 3, id: crypto.randomBytes(16) }) });
  assert.equal(stranger.status, 401);
  assert.match(stranger.data.error, /not known to Oath/);
  assert.equal((await call('GET', '/api/today')).status, 401);
});

async function faceIdLogin(counter) {
  const options = (await call('POST', '/api/passkey/login/options', {})).data;
  return call('POST', '/api/passkey/login', { response: assertion(options, { counter }) });
}

test('Face ID only: the password alone is refused, and works with the recovery code', async () => {
  assert.equal((await call('GET', '/api/session')).data.faceIdOnly, true);
  // Failed attempts count toward the lockout (five in 15 minutes), so a success comes between them.
  const alone = await call('POST', '/api/login', { password: 'long-enough-pass' });
  assert.equal(alone.status, 403);
  assert.match(alone.data.error, /Face ID only/);
  const ok = await call('POST', '/api/login', { password: 'long-enough-pass', recovery: process.env.SETUP_CODE });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/today')).status, 200);
  const wrong = await call('POST', '/api/login', { password: 'long-enough-pass', recovery: 'not-the-code' });
  assert.equal(wrong.status, 403);
  assert.equal((await call('GET', '/api/today')).status, 200, 'a failed attempt does not end the open session');
});

test('Face ID only: opening the app locks the session, and Face ID unlocks it', async () => {
  assert.equal((await call('POST', '/api/lock', {})).status, 200);
  assert.equal((await call('GET', '/api/today')).status, 401, 'nothing is readable while locked');
  const s = (await call('GET', '/api/session')).data;
  assert.equal(s.authed, false);
  assert.equal(s.locked, true);
  assert.equal((await faceIdLogin(10)).status, 200);
  assert.equal((await call('GET', '/api/today')).status, 200);
});

test('Face ID only: a session stays open while used and locks after 5 idle minutes', async () => {
  later(4);
  assert.equal((await call('GET', '/api/today')).status, 200, 'used within 5 minutes');
  later(4);
  assert.equal((await call('GET', '/api/today')).status, 200, 'each request keeps it open');
  later(6);
  assert.equal((await call('GET', '/api/today')).status, 401, 'idle for 6 minutes: locked');
  assert.equal((await faceIdLogin(11)).status, 200);
  assert.equal((await call('GET', '/api/today')).status, 200);
});

test('turning the lock off makes the password work alone and stops locking', async () => {
  assert.equal((await call('PATCH', '/api/settings', { faceIdLock: false })).status, 200);
  assert.equal((await call('GET', '/api/session')).data.faceIdOnly, false);
  later(30);
  assert.equal((await call('GET', '/api/today')).status, 200, 'no idle lock');
  await call('POST', '/api/logout', {});
  assert.equal((await call('POST', '/api/login', { password: 'long-enough-pass' })).status, 200);
  assert.equal((await call('PATCH', '/api/settings', { faceIdLock: true })).status, 200);
});

test('removing the last passkey ends Face ID only, so the password works alone again', async () => {
  const [key] = (await call('GET', '/api/passkeys')).data.passkeys;
  assert.equal((await call('DELETE', `/api/passkeys/${encodeURIComponent(key.id)}`)).status, 200);
  const s = (await call('GET', '/api/session')).data;
  assert.equal(s.faceId, false);
  assert.equal(s.faceIdOnly, false);
  await call('POST', '/api/logout', {});
  assert.equal((await call('POST', '/api/login', { password: 'long-enough-pass' })).status, 200);
});
