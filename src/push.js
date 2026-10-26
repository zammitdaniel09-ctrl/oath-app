// Notifications: Web Push to the home-screen app, mirrored to Telegram by a one-channel rule.
//
// Pushes use the Declarative Web Push format (iOS 18.4+), so the icon badge and the tap target
// work even if the service worker is slow or evicted; other browsers get the same JSON in the
// service worker. Each reminder expires when its deadline passes and carries a Topic, so a phone
// that was offline does not receive a pile of stale reminders.
import crypto from 'node:crypto';
import webpush from 'web-push';
import { db, getKV, setKV } from './db.js';
import { sendTelegram, telegramStatus } from './telegram.js';
import { getSettings, localNow, openItemsToday } from './engine.js';

let configuredKey = null;

export async function vapidKeys() {
  let keys = await getKV('vapid');
  if (!keys) {
    // Generated once on first boot and kept in the database, so nothing has to be configured by hand.
    keys = webpush.generateVAPIDKeys();
    await setKV('vapid', keys);
  }
  return keys;
}

// A custom domain (PUBLIC_HOST) wins over the Railway one, so taps open the address in use.
function publicOrigin() {
  const domain = process.env.PUBLIC_HOST || process.env.RAILWAY_PUBLIC_DOMAIN;
  return domain ? `https://${domain}` : 'https://oath.invalid';
}

async function configure() {
  const keys = await vapidKeys();
  // Keys are regenerated if the database is rebuilt, so re-check them on every send.
  if (configuredKey === keys.publicKey) return;
  webpush.setVapidDetails(publicOrigin(), keys.publicKey, keys.privateKey);
  configuredKey = keys.publicKey;
}

// Returns true when the server did not know this device yet. A device the server dropped was
// refused by the push service, so the phone should make a fresh subscription.
export async function saveSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error('Invalid push subscription');
  }
  const [row] = await db()`insert into push_subs (endpoint, sub) values (${sub.endpoint}, ${db().json(sub)})
                           on conflict (endpoint) do update set sub = excluded.sub
                           returning (xmax = 0) as fresh`;
  return Boolean(row?.fresh);
}

export async function removeSubscription(endpoint) {
  await db()`delete from push_subs where endpoint = ${endpoint}`;
}

export async function subscriptionCount() {
  const [{ n }] = await db()`select count(*)::int as n from push_subs`;
  return n;
}

// The icon badge: how many things can still cost HP today.
export async function badgeCount() {
  const { today, tz } = await localNow();
  return (await openItemsToday(today, tz)).length;
}

// Apple rejects topics it cannot decode as base64url (BadWebPushTopic), so the topic is a fixed
// 32-character digest of the key: valid everywhere, and still the same for the same reminder.
export const topicOf = (key) => crypto.createHash('sha256').update(String(key || 'oath')).digest('base64url').slice(0, 32);

const hostOf = (endpoint) => {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown host';
  }
};

async function sendWebPush(note, badge) {
  await configure();
  const subs = await db()`select endpoint, sub from push_subs`;
  const tag = note.tag || note.topic || undefined;
  const payload = JSON.stringify({
    web_push: 8030,
    notification: {
      title: note.title,
      body: note.body || '',
      navigate: `${publicOrigin()}${note.url || '/#/today'}`,
      lang: 'en-GB',
      dir: 'ltr',
      silent: false,
      app_badge: badge,
      tag,
    },
  });
  const options = {
    TTL: Math.max(60, Math.round(note.ttl || 6 * 3600)),
    urgency: note.urgent ? 'high' : 'normal',
    topic: topicOf(note.topic || note.tag),
  };
  let sent = 0;
  await Promise.all(
    subs.map(async ({ endpoint, sub }) => {
      const host = hostOf(endpoint);
      try {
        try {
          await webpush.sendNotification(sub, payload, options);
        } catch (err) {
          // A push service that still refuses the topic gets the message once without one.
          if (err.statusCode !== 400 || !String(err.body || '').includes('BadWebPushTopic')) throw err;
          console.warn('push topic refused, retrying without a topic', host, options.topic);
          await webpush.sendNotification(sub, payload, { ...options, topic: undefined });
        }
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          console.warn('push device gone, removing it', err.statusCode, host);
          await removeSubscription(endpoint);
        } else {
          console.error('push failed', err.statusCode || '', host, `topic=${options.topic}`, err.body || err.message);
        }
      }
    }),
  );
  return sent;
}

// "both" (the default) sends everything to the lock screen and to Telegram, so Telegram backs up a
// phone that lost its push subscription. In "smart" mode with Telegram linked, Telegram gets
// everything that benefits from a Done button or full text; the lock-screen push is kept for last
// calls and deaths. "push" keeps Telegram quiet.
export async function sendPush(note) {
  const s = await getSettings();
  const tg = await telegramStatus().catch(() => ({ linked: false }));
  const devices = await subscriptionCount();
  const mode = s.alerts || 'both';
  let toPush = devices > 0;
  let toTelegram = tg.linked;
  if (mode === 'push') toTelegram = false;
  if (mode === 'smart' && tg.linked && devices > 0) {
    toPush = Boolean(note.urgent || note.both);
    toTelegram = !note.urgent || Boolean(note.both);
  }
  if (toTelegram) sendTelegram(note).catch((err) => console.error('telegram send failed', err.message));
  if (!toPush) return 0;
  const badge = await badgeCount().catch(() => 0);
  return sendWebPush(note, badge);
}
