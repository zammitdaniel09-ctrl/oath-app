// Face ID login: passkeys (WebAuthn). The iPhone keeps a private key that only unlocks with Face ID;
// Oath keeps the public half and checks every login against it.
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { db, logEvent } from './db.js';
import { getSettings, RuleError } from './engine.js';
import { nowUTC } from './time.js';

// A passkey belongs to the address it was made at. Behind Railway's proxy the request says http,
// so the public address wins when it is known.
function relyingParty(c) {
  const url = new URL(c.req.url);
  const host = process.env.PUBLIC_HOST || process.env.RAILWAY_PUBLIC_DOMAIN || url.host;
  const proto = process.env.PUBLIC_HOST || process.env.RAILWAY_PUBLIC_DOMAIN ? 'https:' : url.protocol;
  return { rpID: host.replace(/:\d+$/, ''), origin: `${proto}//${host}` };
}

// Challenges live for five minutes and are good for one use.
const challenges = new Map();
function remember(challenge, kind) {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
  if (challenges.size > 50) challenges.delete(challenges.keys().next().value);
  challenges.set(challenge, { kind, expires: now + 5 * 60000 });
}
const take = (kind) => (challenge) => {
  const c = challenges.get(challenge);
  challenges.delete(challenge);
  return Boolean(c && c.kind === kind && c.expires >= Date.now());
};

export async function passkeyCount() {
  const [{ n }] = await db()`select count(*)::int as n from passkeys`;
  return n;
}

export async function listPasskeys() {
  const rows = await db()`select id, device, created_at, last_used from passkeys order by created_at`;
  return rows.map((k) => ({ id: k.id, device: k.device, createdAt: k.created_at, lastUsed: k.last_used }));
}

export async function removePasskey(id) {
  await db()`delete from passkeys where id = ${String(id)}`;
  await logEvent('passkey_removed', {});
  return { ok: true };
}

export async function registrationOptions(c) {
  const { rpID } = relyingParty(c);
  const s = await getSettings();
  const existing = await db()`select id, transports from passkeys`;
  const options = await generateRegistrationOptions({
    rpName: 'Oath',
    rpID,
    userName: s.ownerName || 'Owner',
    userDisplayName: s.ownerName || 'Owner',
    userID: new TextEncoder().encode('oath-owner'),
    attestationType: 'none',
    excludeCredentials: existing.map((k) => ({ id: k.id, transports: k.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  remember(options.challenge, 'register');
  return options;
}

export async function registerPasskey(c, { response, device } = {}) {
  const { rpID, origin } = relyingParty(c);
  let v;
  try {
    v = await verifyRegistrationResponse({
      response, expectedChallenge: take('register'), expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    });
  } catch (err) {
    throw new RuleError(`Face ID setup did not go through: ${err.message}`);
  }
  if (!v.verified || !v.registrationInfo) throw new RuleError('Face ID setup could not be verified. Try again.');
  const { credential } = v.registrationInfo;
  await db()`insert into passkeys (id, public_key, counter, transports, device, created_at)
             values (${credential.id}, ${Buffer.from(credential.publicKey)}, ${credential.counter}, ${credential.transports || []},
                     ${String(device || '').slice(0, 80)}, ${nowUTC().toJSDate()})
             on conflict (id) do nothing`;
  await logEvent('passkey_added', { device: String(device || '').slice(0, 80) });
  return { ok: true };
}

export async function loginOptions(c) {
  const { rpID } = relyingParty(c);
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [] });
  remember(options.challenge, 'login');
  return options;
}

// Throws unless the response is a fresh, Face ID-verified signature from a known passkey.
export async function verifyPasskeyLogin(c, response) {
  const { rpID, origin } = relyingParty(c);
  const [key] = await db()`select * from passkeys where id = ${String(response?.id || '')}`;
  if (!key) throw new RuleError('This Face ID key is not known to Oath. Log in with your password, then add Face ID again.', 401);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: take('login'),
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: { id: key.id, publicKey: new Uint8Array(key.public_key), counter: Number(key.counter), transports: key.transports },
    });
  } catch {
    throw new RuleError('Face ID login did not go through. Try again, or use your password.', 401);
  }
  if (!v.verified) throw new RuleError('Face ID login did not go through. Try again, or use your password.', 401);
  await db()`update passkeys set counter = ${v.authenticationInfo.newCounter}, last_used = ${nowUTC().toJSDate()} where id = ${key.id}`;
}
