// Service worker: offline shell and push notifications.
const CACHE = 'oath-v1';
const SHELL = ['/', '/app.css', '/app.js', '/manifest.webmanifest', '/icons/apple-touch-icon.png', '/icons/icon-192.png', '/icons/badge.png', '/fonts/archivo-latin-wdth-normal.woff2'];

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
  event.waitUntil(
    self.registration.showNotification(data.title || 'Oath', {
      body: data.body || '',
      tag: data.tag || 'oath',
      renotify: true,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge.png',
      data: { url: data.url || '/#/today' },
    }),
  );
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
