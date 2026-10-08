// Notifications: Web Push to the home-screen app, mirrored to Telegram by a one-channel rule.
//
// Pushes use the Declarative Web Push format (iOS 18.4+), so the icon badge and the tap target
// work even if the service worker is slow or evicted; other browsers get the same JSON in the
// service worker. Each reminder expires when its deadline passes and carries a Topic, so a phone
// that was offline does not receive a pile of stale reminders.
import webpush from 'web-push';
import { db, getKV, setKV } from './db.js';
import { sendTelegram, telegramStatus } from './telegram.js';
import { getSettings, localNow, openItemsToday } from './engine.js';

let configured = false;

export async function vapidKeys() {
  let keys = await getKV('vapid');
  if (!keys) {
    // Generated once on first boot and kept in the database, so nothing has to be configured by hand.
    keys = webpush.generateVAPIDKeys();
    await setKV('vapid', keys);
  }
  return keys;
}

function publicOrigin() {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.PUBLIC_HOST;
  return domain ? `https://${domain}` : 'https://oath.invalid';
}

async function configure() {
  if (configured) return;
  const keys = await vapidKeys();
  webpush.setVapidDetails(publicOrigin(), keys.publicKey, keys.privateKey);
  configured = true;
}

export async function saveSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error('Invalid push subscription');
  }
  await db()`insert into push_subs (endpoint, sub) values (${sub.endpoint}, ${db().json(sub)})
             on conflict (endpoint) do update set sub = excluded.sub`;
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

const topicOf = (t) => String(t || 'oath').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'oath';

async function sendWebPush(note, badge) {
  await configure();
  const subs = await db()`select endpoint, sub from push_subs`;
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
    },
  });
  let sent = 0;
  await Promise.all(
    subs.map(async ({ endpoint, sub }) => {
      try {
        await webpush.sendNotification(sub, payload, {
          TTL: Math.max(60, Math.round(note.ttl || 6 * 3600)),
          urgency: note.urgent ? 'high' : 'normal',
          topic: topicOf(note.topic || note.tag),
        });
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) await removeSubscription(endpoint);
        else console.error('push failed', err.statusCode || '', err.body || err.message);
      }
    }),
  );
  return sent;
}

// One channel per alert. In "smart" mode with Telegram linked, Telegram gets everything that
// benefits from a Done button or full text; the lock-screen push is kept for last calls and
// deaths. "both" sends everything everywhere; "push" keeps Telegram quiet.
export async function sendPush(note) {
  const s = await getSettings();
  const tg = await telegramStatus().catch(() => ({ linked: false }));
  const devices = await subscriptionCount();
  const mode = s.alerts || 'smart';
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
