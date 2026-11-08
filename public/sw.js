/* Hubb service worker: offline app shell, push notifications, background delivery of queued messages. */
importScripts('/idb.js');

const CACHE = 'hubb-v13';
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
  // network-first: always the newest version when online, cached copy when offline
  e.respondWith(
    fetch(req)
      .then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});

// ---------- Push notifications ----------
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(handlePush(data));
});

// The running app hands over messages it received instantly over its live connection
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'notify') e.waitUntil(handlePush({ ...e.data.payload, fromPage: true }));
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
  if (data.test) {
    return self.registration.showNotification(data.title, { body: data.body, icon: '/icons/icon-192.png', badge: '/icons/badge-72.png', tag: 'hubb-test', vibrate: [80, 60, 80] });
  }
  if (!data.fromPage && wins.some((w) => w.visibilityState === 'visible')) { await saving; return; }
  // Same message may arrive twice (instantly from the open app, then via push): show it once.
  const id = data.messageId || (data.message && data.message.id);
  if (id) {
    const seen = (await HubbDB.kv.get('notified').catch(() => null)) || [];
    if (seen.includes(id)) { await saving; return; }
    await HubbDB.kv.set('notified', seen.concat(id).slice(-100));
  }

  const name = data.title || 'Hubb';
  const list = (unread || []).concat({ text: data.body || 'New message', at: Date.now() }).slice(-10);
  const n = list.length;
  const lines = list.slice(-6).map((m) => m.text.replace(/\s+/g, ' '));
  if (n > 6) lines.unshift(`+${n - 6} earlier`);

  const android = /Android/i.test(self.navigator.userAgent);
  const options = {
    body: lines.join('\n'),
    icon: icon || '/icons/icon-192.png',   // partner's round profile photo
    badge: '/icons/badge-72.png',
    // A NEW tag each time: Android only pops a banner at the top for a newly posted
    // notification, not for an update of one that's already in the panel.
    tag: 'hubb-chat-' + Date.now(),
    renotify: true,
    requireInteraction: false,
    silent: false,
    timestamp: Date.now(),
    vibrate: [80, 60, 80],
    data: { url: '/' },
    actions: android
      ? [{ action: 'reply', title: '💬 Reply' }, { action: 'heart', title: '❤️ Send love' }]
      : [{ action: 'reply', title: '💬 Reply', type: 'text', placeholder: `Message ${name}…` }, { action: 'heart', title: '❤️ Send love' }],
  };
  const title = n > 1 ? `${name} · ${n} new messages` : name;
  // Remove the previous Hubb notification, then post the stacked one fresh (so it pops up).
  try { (await self.registration.getNotifications()).forEach((x) => x.close()); } catch (_) {}
  try { await self.registration.showNotification(title, options); }
  catch (_) {
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
