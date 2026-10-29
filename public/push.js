// Web Push on this device: on, off, and kept in step with the server on every launch.

export async function refreshPushState() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  state.push = { supported, permission: supported ? Notification.permission : 'default', subscribed: false, devices: null };
  state.push.devices = await api('GET', '/api/push/key').then((k) => k.devices).catch(() => null);
  if (!supported) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  state.push.subscribed = Boolean(sub);
}

// The server's key changes if its database is rebuilt; a subscription made with the old key is dead.
function sameKey(sub, publicKey) {
  const key = sub.options?.applicationServerKey;
  if (!key) return true;
  const mine = new Uint8Array(key);
  const theirs = b64ToBytes(publicKey);
  return mine.length === theirs.length && mine.every((b, i) => b === theirs[i]);
}

export async function pushOn() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new ApiError('Notifications were not allowed. Turn them on in iOS Settings, Notifications, Oath.');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('GET', '/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await api('POST', '/api/push/subscribe', sub.toJSON());
  return true;
}

export async function pushOff() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  return true;
}

// iOS never tells the page when a push subscription changes, so re-send it on every launch. If the
// server had dropped it (the push service refused it) or it was made with an old key, replace it.
export async function resyncPush() {
  try {
    if (!('serviceWorker' in navigator) || !('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const { publicKey } = await api('GET', '/api/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, publicKey)) {
      await sub.unsubscribe();
      sub = null;
    }
    if (sub) {
      const r = await api('POST', '/api/push/subscribe', sub.toJSON());
      if (!r.fresh) return;
      await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    await api('POST', '/api/push/subscribe', sub.toJSON());
  } catch { /* try again next launch */ }
}import { state, api, b64ToBytes, ApiError } from './ui.js';

