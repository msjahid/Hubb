'use strict';
/**
 * Hubb server — private real-time messenger for exactly two people.
 * Express (REST + static PWA) + Socket.IO (real-time) + SQLite (storage) + Web Push (notifications).
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const MAX_USERS = 2; // Hubb is for a couple only
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Database ----------
const db = new Database(path.join(DATA_DIR, 'hubb.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE COLLATE NOCASE NOT NULL,
    pass TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    sender_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(created_at);
  CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    sub TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`);

const q = {
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  partnerOf: db.prepare('SELECT * FROM users WHERE id != ? ORDER BY id LIMIT 1'),
  insertUser: db.prepare('INSERT INTO users (username, pass, name, created_at) VALUES (?, ?, ?, ?)'),
  updatePass: db.prepare('UPDATE users SET pass = ? WHERE id = ?'),
  updateName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
  updateAvatar: db.prepare('UPDATE users SET avatar = ? WHERE id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)'),
  sessionUser: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'),
  insertMsg: db.prepare('INSERT OR IGNORE INTO messages (id, sender_id, text, created_at) VALUES (?, ?, ?, ?)'),
  getMsg: db.prepare('SELECT * FROM messages WHERE id = ?'),
  lastMsgTime: db.prepare('SELECT MAX(created_at) AS t FROM messages'),
  msgsAfter: db.prepare('SELECT * FROM messages WHERE created_at > ? ORDER BY created_at ASC LIMIT 2000'),
  recentMsgs: db.prepare('SELECT * FROM (SELECT * FROM messages ORDER BY created_at DESC LIMIT 1000) ORDER BY created_at ASC'),
  upsertSub: db.prepare('INSERT INTO push_subs (endpoint, user_id, sub) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, sub = excluded.sub'),
  subsFor: db.prepare('SELECT * FROM push_subs WHERE user_id = ?'),
  delSub: db.prepare('DELETE FROM push_subs WHERE endpoint = ?'),
  getKv: db.prepare('SELECT v FROM kv WHERE k = ?'),
  setKv: db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
};

// ---------- Web Push (VAPID keys generated once and kept in the DB) ----------
let vapid = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
  ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
  : null;
if (!vapid) {
  const stored = q.getKv.get('vapid');
  vapid = stored ? JSON.parse(stored.v) : webpush.generateVAPIDKeys();
  if (!stored) q.setKv.run('vapid', JSON.stringify(vapid));
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:hubb@example.com', vapid.publicKey, vapid.privateKey);

// ---------- Helpers ----------
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const publicUser = (u) => (u ? { id: u.id, username: u.username, name: u.name, avatar: u.avatar || null } : null);
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400, code: 'invalid' });

function newSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  q.insertSession.run(hashToken(token), userId, Date.now()); // sessions never expire
  return token;
}
function userFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  return q.sessionUser.get(hashToken(token)) || null;
}

let lastTime = q.lastMsgTime.get().t || 0;
function nextTime() {
  lastTime = Math.max(Date.now(), lastTime + 1); // strictly increasing => stable order & sync cursor
  return lastTime;
}

let io; // assigned below
function saveMessage(user, data) {
  const id = data && typeof data.id === 'string' ? data.id.trim() : '';
  const text = data && typeof data.text === 'string' ? data.text.replace(/\s+$/, '') : '';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw badRequest('Bad message id');
  if (!text.trim() || text.length > 4000) throw badRequest('Message must be 1–4000 characters');

  const existing = q.getMsg.get(id);
  if (existing) return existing; // duplicate resend from an offline queue — already delivered

  q.insertMsg.run(id, user.id, text, nextTime());
  const msg = q.getMsg.get(id);
  io.to('couple').emit('message', msg);

  const partner = q.partnerOf.get(user.id);
  if (partner) {
    pushTo(partner.id, {
      title: user.name,
      body: text.length > 140 ? text.slice(0, 140) + '…' : text,
      message: text.length <= 1500 ? msg : null,
    });
  }
  return msg;
}

function pushTo(userId, payload) {
  const body = JSON.stringify(payload);
  for (const row of q.subsFor.all(userId)) {
    webpush
      .sendNotification(JSON.parse(row.sub), body, { TTL: 60 * 60 * 24, urgency: 'high' })
      .catch((err) => {
        if (err.statusCode === 404 || err.statusCode === 410) q.delSub.run(row.endpoint);
      });
  }
}

// Very small login throttle (per IP)
const attempts = new Map();
function throttle(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { n: 0, t: now };
  if (now - a.t > 15 * 60 * 1000) { a.n = 0; a.t = now; }
  a.n += 1;
  attempts.set(ip, a);
  return a.n > 20;
}


// ---------- Accounts (no sign-up in the app: the two accounts are set here) ----------
// Set HUBB_USER1 / HUBB_PASS1 / HUBB_NAME1 and HUBB_USER2 / HUBB_PASS2 / HUBB_NAME2
// as environment variables, or run:  node scripts/set-user.js <username> <password> "<Name>"
function setUser(username, password, name) {
  username = String(username || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) throw new Error(`Bad username "${username}" (3-30 letters, numbers, . - _)`);
  if (!password || String(password).length < 6) throw new Error(`Password for ${username} must be at least 6 characters`);
  const existing = q.userByName.get(username);
  if (existing) {
    if (!bcrypt.compareSync(String(password), existing.pass)) q.updatePass.run(bcrypt.hashSync(String(password), 10), existing.id);
    if (name && name.trim() && name.trim() !== existing.name) q.updateName.run(name.trim().slice(0, 40), existing.id);
    return 'updated';
  }
  if (q.countUsers.get().n >= MAX_USERS) throw new Error('Hubb already has two accounts — it is only for a couple.');
  q.insertUser.run(username, bcrypt.hashSync(String(password), 10), (name && name.trim() ? name.trim() : username).slice(0, 40), Date.now());
  return 'created';
}
module.exports.setUser = setUser;
for (const n of [1, 2]) {
  const u = process.env['HUBB_USER' + n];
  if (!u) continue;
  try { console.log(`Account ${u}: ${setUser(u, process.env['HUBB_PASS' + n], process.env['HUBB_NAME' + n])}`); }
  catch (e) { console.error('Account setup error:', e.message); }
}

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

function auth(req, res, next) {
  const h = req.get('authorization') || '';
  const user = userFromToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/api/login', (req, res) => {
  if (throttle(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { username, password } = req.body || {};
  const user = typeof username === 'string' ? q.userByName.get(username.trim()) : null;
  if (!user || typeof password !== 'string' || !bcrypt.compareSync(password, user.pass)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  attempts.delete(req.ip);
  const token = newSession(user.id);
  res.json({ token, me: publicUser(user), partner: publicUser(q.partnerOf.get(user.id)) });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ me: publicUser(req.user), partner: publicUser(q.partnerOf.get(req.user.id)), online: [...online.keys()] });
});

app.post('/api/profile', auth, (req, res) => {
  const { name, avatar } = req.body || {};
  if (typeof name === 'string') {
    const n = name.trim().slice(0, 40);
    if (!n) return res.status(400).json({ error: 'Name cannot be empty.' });
    q.updateName.run(n, req.user.id);
  }
  if (avatar !== undefined) {
    if (avatar !== null && (typeof avatar !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(avatar) || avatar.length > 400000)) {
      return res.status(400).json({ error: 'Invalid picture.' });
    }
    q.updateAvatar.run(avatar, req.user.id);
  }
  const me = publicUser(q.userById.get(req.user.id));
  io.to('couple').emit('profile', me);
  res.json({ me });
});

app.get('/api/messages', auth, (req, res) => {
  const after = Number(req.query.after) || 0;
  res.json({ messages: after > 0 ? q.msgsAfter.all(after) : q.recentMsgs.all() });
});

// Used by the service worker's background sync (sends queued messages even if the app is closed)
app.post('/api/messages', auth, (req, res) => {
  try {
    res.json({ message: saveMessage(req.user, req.body) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/api/push/key', (req, res) => res.json({ key: vapid.publicKey }));

app.post('/api/push/subscribe', auth, (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) return res.status(400).json({ error: 'Bad subscription' });
  q.upsertSub.run(sub.endpoint, req.user.id, JSON.stringify(sub));
  res.json({ ok: true });
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, p) {
      if (/(sw\.js|\.html|\.webmanifest)$/.test(p)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// ---------- Socket.IO (real-time) ----------
const server = http.createServer(app);
io = new Server(server, { pingInterval: 20000, pingTimeout: 20000, maxHttpBufferSize: 1e6 });
const online = new Map(); // userId -> open connection count

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.userId = user.id;
  next();
});

io.on('connection', (socket) => {
  const uid = socket.data.userId;
  socket.join('couple');
  online.set(uid, (online.get(uid) || 0) + 1);
  io.to('couple').emit('presence', { userId: uid, online: true });
  socket.emit('presence:list', [...online.keys()]);

  socket.on('send', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const user = q.userById.get(uid);
      reply({ ok: true, message: saveMessage(user, data) });
    } catch (e) {
      reply({ ok: false, error: e.code || 'error', message: e.message });
    }
  });

  socket.on('disconnect', () => {
    const n = (online.get(uid) || 1) - 1;
    if (n <= 0) {
      online.delete(uid);
      io.to('couple').emit('presence', { userId: uid, online: false });
    } else online.set(uid, n);
  });
});

if (require.main === module) server.listen(PORT, () => console.log(`Hubb is running on http://localhost:${PORT}`));
