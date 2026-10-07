import webpush from 'web-push';
import { db, getKV, setKV } from './db.js';

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

async function configure() {
  if (configured) return;
  const keys = await vapidKeys();
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.PUBLIC_HOST;
  const subject = domain ? `https://${domain}` : 'https://oath.invalid';
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
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

export async function sendPush(note) {
  await configure();
  const subs = await db()`select endpoint, sub from push_subs`;
  const payload = JSON.stringify({ title: note.title, body: note.body, tag: note.tag || 'oath', url: note.url || '/' });
  let sent = 0;
  await Promise.all(
    subs.map(async ({ endpoint, sub }) => {
      try {
        await webpush.sendNotification(sub, payload, { TTL: 60 * 60 * 6, urgency: 'high' });
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) await removeSubscription(endpoint);
        else console.error('push failed', err.statusCode || '', err.body || err.message);
      }
    }),
  );
  return sent;
}
