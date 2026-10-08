// Service worker: offline shell and push notifications.
const CACHE = 'oath-v4';
const SHELL = ['/', '/app.css', '/app.js', '/ui.js', '/parse.js', '/goals.js', '/manifest.webmanifest', '/icons/apple-touch-icon.png', '/icons/icon-192.png', '/icons/badge.png', '/fonts/archivo-latin-wdth-normal.woff2'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Network first so updates land immediately; the cache is only a fallback for offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && req.mode !== 'navigate') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : Response.error()))),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Oath', body: event.data?.text() || '' }; }
  // Declarative Web Push payloads ({web_push: 8030, notification: {...}}) and the older shape.
  const n = data.web_push === 8030 && data.notification ? data.notification : data;
  let target = n.url || '/#/today';
  if (n.navigate) {
    try {
      const u = new URL(n.navigate);
      target = u.pathname + u.search + u.hash;
    } catch { /* keep the default */ }
  }
  const badge = Number(n.app_badge);
  event.waitUntil(Promise.all([
    self.registration.showNotification(n.title || 'Oath', {
      body: n.body || '',
      tag: n.tag || undefined,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge.png',
      data: { url: target },
    }),
    Number.isFinite(badge) && self.navigator.setAppBadge
      ? (badge > 0 ? self.navigator.setAppBadge(badge) : self.navigator.clearAppBadge()).catch(() => {})
      : Promise.resolve(),
  ]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/#/today';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) {
          w.navigate(target).catch(() => {});
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
