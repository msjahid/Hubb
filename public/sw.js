/* Hubb service worker: offline app shell, push notifications, background delivery of queued messages. */
importScripts('/idb.js');

const CACHE = 'hubb-v4';
const SHELL = [
  '/', '/index.html', '/app.css', '/app.js', '/idb.js', '/manifest.webmanifest',
  '/socket.io/socket.io.min.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-72.png', '/icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;                    // always live
  if (url.pathname.startsWith('/socket.io/') && url.search) return; // socket transport

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { caches.open(CACHE).then((c) => c.put('/index.html', res.clone())); return res; })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }
  // stale-while-revalidate for static files
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req)
        .then((res) => { if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())); return res; })
        .catch(() => cached);
      return cached || net;
    })
  );
});

// ---------- Push notifications ----------
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil((async () => {
    if (data.message) { try { await HubbDB.messages.put(data.message); } catch (_) {} }
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // App is open on screen: the page plays its own soft chime instead of a system banner.
    if (wins.some((w) => w.visibilityState === 'visible')) return;
    await self.registration.showNotification(data.title || 'Hubb', {
      body: data.body || 'New message',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      tag: 'hubb-chat',
      renotify: true,
      vibrate: [60, 80, 60],
      data: { url: '/' },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) return w.focus(); }
    return self.clients.openWindow('/');
  })());
});

// ---------- Background sync: deliver queued messages even if the app was closed ----------
self.addEventListener('sync', (e) => {
  if (e.tag === 'hubb-outbox') e.waitUntil(flushOutbox());
});

async function flushOutbox() {
  const token = await HubbDB.kv.get('token');
  if (!token) return;
  const items = (await HubbDB.outbox.all()).sort((a, b) => a.created_at - b.created_at);
  for (const it of items) {
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ id: it.id, text: it.text }),
    }); // throws while offline -> browser retries later
    if (res.ok) {
      const { message } = await res.json();
      await HubbDB.messages.put(message);
      await HubbDB.outbox.del(it.id);
    } else if (res.status === 400) {
      await HubbDB.outbox.del(it.id);
    } else {
      throw new Error('retry later');
    }
  }
  const wins = await self.clients.matchAll({ type: 'window' });
  wins.forEach((w) => w.postMessage({ type: 'outbox-synced' }));
}
