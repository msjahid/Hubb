/* Hubb service worker: offline app shell, push notifications, background delivery of queued messages. */
importScripts('/idb.js');

const CACHE = 'hubb-v5';
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
  e.waitUntil(handlePush(data));
});

// Unread messages are stacked into ONE notification until the app is opened.
let unreadChain = Promise.resolve();
async function handlePush(data) {
  const saving = data.message ? HubbDB.messages.put(data.message).catch(() => {}) : null;
  const [wins, icon, unread] = await Promise.all([
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }),
    HubbDB.kv.get('notifIcon').catch(() => null),
    HubbDB.kv.get('unread').catch(() => null),
  ]);
  // App open on screen: the page plays its own soft chime, no system banner needed.
  if (wins.some((w) => w.visibilityState === 'visible')) { await saving; return; }

  const name = data.title || 'Hubb';
  const list = (unread || []).concat({ text: data.body || 'New message', at: Date.now() }).slice(-10);
  const n = list.length;
  const lines = list.slice(-6).map((m) => m.text.replace(/\s+/g, ' '));
  if (n > 6) lines.unshift(`+${n - 6} earlier`);

  const options = {
    body: lines.join('\n'),
    icon: icon || '/icons/icon-192.png',   // partner's round profile photo
    badge: '/icons/badge-72.png',
    tag: 'hubb-chat',
    renotify: true,
    timestamp: Date.now(),
    vibrate: [40, 60, 40],
    data: { url: '/' },
    actions: [
      { action: 'reply', title: '💬 Reply', type: 'text', placeholder: `Message ${name}…` },
      { action: 'heart', title: '❤️ Send love' },
    ],
  };
  const title = n > 1 ? `${name} · ${n} new messages` : name;
  try { await self.registration.showNotification(title, options); }
  catch (_) {
    // Platforms that don't allow inline-reply actions: same notification with simple buttons.
    options.actions = [{ action: 'reply', title: '💬 Reply' }, { action: 'heart', title: '❤️ Send love' }];
    await self.registration.showNotification(title, options);
  }
  await Promise.all([HubbDB.kv.set('unread', list), saving]);
}

const newId = () => (self.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

async function quickSend(text) {
  const token = await HubbDB.kv.get('token');
  if (!token || !text || !text.trim()) return;
  const m = { id: newId(), text: text.trim(), created_at: Date.now() };
  try {
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ id: m.id, text: m.text }),
    });
    if (!res.ok) throw new Error('send failed');
    const { message } = await res.json();
    await HubbDB.messages.put(message);
  } catch (_) {
    const me = await HubbDB.kv.get('me');
    await HubbDB.outbox.put({ ...m, sender_id: me ? me.id : 0 });
    try { await self.registration.sync.register('hubb-outbox'); } catch (_) {}
  }
}

async function openApp(focusInput) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of wins) {
    if ('focus' in w) { await w.focus(); if (focusInput) w.postMessage({ type: 'focus-input' }); return; }
  }
  return self.clients.openWindow(focusInput ? '/?reply=1' : '/');
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    if (e.action === 'heart') { await HubbDB.kv.set('unread', []); return quickSend('❤️'); }
    if (e.action === 'reply' && e.reply) { await HubbDB.kv.set('unread', []); return quickSend(e.reply); } // inline reply (where supported)
    await HubbDB.kv.set('unread', []);
    return openApp(e.action === 'reply');
  })());
});

self.addEventListener('notificationclose', (e) => {
  e.waitUntil(HubbDB.kv.set('unread', []));
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
