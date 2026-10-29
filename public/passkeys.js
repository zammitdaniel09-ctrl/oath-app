// Face ID through passkeys: WebAuthn's binary fields to and from base64url, and the device's name.

const bytesToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createOptions(o) {
  return {
    ...o,
    challenge: b64ToBytes(o.challenge),
    user: { ...o.user, id: b64ToBytes(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((x) => ({ ...x, id: b64ToBytes(x.id) })),
  };
}

export function getOptions(o) {
  return { ...o, challenge: b64ToBytes(o.challenge), allowCredentials: (o.allowCredentials || []).map((x) => ({ ...x, id: b64ToBytes(x.id) })) };
}

export function credentialJSON(cred) {
  const r = cred.response;
  const response = { clientDataJSON: bytesToB64u(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = bytesToB64u(r.attestationObject);
    response.transports = r.getTransports?.() || [];
  } else {
    response.authenticatorData = bytesToB64u(r.authenticatorData);
    response.signature = bytesToB64u(r.signature);
    if (r.userHandle) response.userHandle = bytesToB64u(r.userHandle);
  }
  return {
    id: cred.id,
    rawId: bytesToB64u(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults?.() || {},
    response,
  };
}

export function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Mac/.test(ua)) return 'Mac';
  return 'This device';
}

// iOS used to show Face ID only for a request that came straight from a tap, so a challenge fetched
// ahead of time goes straight to Face ID. Challenges last five minutes. (Login: see the lock screen.)
export const fresh = (pre) => pre && Date.now() - pre.at < 4 * 60000;import { b64ToBytes } from './ui.js';

