/* Hubb — client app */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const DB = self.HubbDB;

  const diag = { live: 'Not started', err: '' };
  const state = {
    token: null,
    me: null,
    partner: null,
    msgs: new Map(),   // id -> message ({pending:true} while queued)
    lastTs: 0,         // newest server timestamp we have (sync cursor)
    socket: null,
    soundOn: true,
    partnerOnline: false,
    installEvt: null,
  };

  // ---------------- Utilities ----------------
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
  const initials = (n) => (n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
  }
  function show(id) {
    for (const s of ['#splash', '#auth', '#chat']) $(s).classList.toggle('hidden', s !== id);
  }
  function setAvatar(el, user) {
    if (user && user.avatar) { el.style.backgroundImage = `url("${user.avatar}")`; el.textContent = ''; }
    else { el.style.backgroundImage = ''; el.textContent = user ? initials(user.name) : '♡'; }
  }

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (res.status === 401 && state.token && !opts.noAuthReset) { await signedOut(); throw new Error('Signed out'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { status: res.status });
    return data;
  }

  // ---------------- Sound: soft, relaxing chime (generated, no file needed) ----------------
  let actx = null;
  function audio() {
    if (!actx) { const C = window.AudioContext || window.webkitAudioContext; if (C) actx = new C(); }
    if (actx && actx.state === 'suspended') actx.resume();
    return actx;
  }
  function chime() {
    if (!state.soundOn) return;
    const ctx = audio(); if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    const master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);
    // gentle two-note bell (E5 -> B5) with soft attack and long fade, plus a quiet octave shimmer
    [[659.25, 0, 0.22], [987.77, 0.16, 0.18], [1318.5, 0.16, 0.04]].forEach(([f, d, vol]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(vol, t + d + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 1.8);
      o.connect(g).connect(master); o.start(t + d); o.stop(t + d + 1.9);
    });
  }
  document.addEventListener('pointerdown', () => audio(), { once: true, capture: true });

  // ---------------- Boot ----------------
  async function boot() {
    registerSW();
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (_) {}
    state.token = await DB.kv.get('token');
    state.soundOn = (await DB.kv.get('soundOn')) !== false;
    if (!state.token) return showAuth();

    state.me = (await DB.kv.get('me')) || null;
    state.partner = (await DB.kv.get('partner')) || null;
    state.lastTs = (await DB.kv.get('lastTs')) || 0;
    await loadCache();
    enterChat();
    refreshProfile();
    connect();
  }

  async function loadCache() {
    const [msgs, out] = await Promise.all([DB.messages.all(), DB.outbox.all()]);
    state.msgs.clear();
    for (const m of msgs) state.msgs.set(m.id, m);
    for (const m of out) if (!state.msgs.has(m.id)) state.msgs.set(m.id, { ...m, pending: true });
  }

  // ---------------- Auth ----------------
  function showAuth() {
    show('#auth');
    $('#authError').textContent = '';
  }

  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#fUser').value.trim(), password = $('#fPass').value;
    if (!username || !password) { $('#authError').textContent = 'Please enter your username and password.'; return; }
    const btn = $('#authSubmit'); btn.disabled = true; $('#authError').textContent = '';
    try {
      const data = await api('/api/login', { method: 'POST', body: { username, password }, noAuthReset: true });
      // Let the browser's password manager remember the username & password too.
      try { if (window.PasswordCredential) await navigator.credentials.store(new PasswordCredential({ id: username, password, name: data.me.name })); } catch (_) {}
      state.token = data.token;
      await DB.kv.set('token', data.token);
      await saveProfile(data.me, data.partner);
      state.lastTs = 0; await DB.kv.set('lastTs', 0);
      await loadCache();
      enterChat();
      connect();
    } catch (err) {
      $('#authError').textContent = err.message || 'Could not connect. Check your internet.';
    } finally { btn.disabled = false; }
  });

  async function signedOut() {
    // Only happens if the server no longer recognises this device (e.g. the database was reset).
    if (state.socket) { state.socket.close(); state.socket = null; }
    state.token = null;
    await Promise.all([DB.kv.del('token'), DB.messages.clear(), DB.outbox.clear(), DB.kv.del('lastTs')]);
    state.msgs.clear();
    showAuth();
  }

  // ---------------- Profile ----------------
  async function saveProfile(me, partner) {
    if (me) { state.me = me; await DB.kv.set('me', me); }
    if (partner !== undefined) { state.partner = partner; await DB.kv.set('partner', partner); }
    renderHeader();
    if (!$('#chat').classList.contains('hidden')) renderAll(true);
  }
  async function refreshProfile() {
    try {
      const d = await api('/api/me');
      await saveProfile(d.me, d.partner);
      if (d.partner) setPresence(d.online.includes(d.partner.id));
    } catch (_) {}
  }
  // Build a round version of the partner's photo for notifications (stored for the service worker)
  async function makeNotifIcon(user) {
    if (!user) return;
    const key = user.id + ':' + (user.avatar ? user.avatar.length + user.avatar.slice(-40) : user.name);
    if ((await DB.kv.get('notifIconKey')) === key) return;
    const S = 192, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); g.closePath(); g.clip();
    if (user.avatar) {
      const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = user.avatar; });
      if (img) g.drawImage(img, 0, 0, S, S);
    } else {
      const gr = g.createLinearGradient(0, 0, S, S);
      gr.addColorStop(0, '#FF8A80'); gr.addColorStop(0.55, '#E8508A'); gr.addColorStop(1, '#7C4DC4');
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
      g.fillStyle = '#fff'; g.font = '600 78px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(initials(user.name), S / 2, S / 2 + 4);
    }
    await DB.kv.set('notifIcon', c.toDataURL('image/png'));
    await DB.kv.set('notifIconKey', key);
  }

  // Opening the app counts as reading: clear the stacked notification
  async function clearNotifications() {
    try {
      await DB.kv.set('unread', []);
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) (await reg.getNotifications()).forEach((n) => n.close());
    } catch (_) {}
  }

  function renderHeader() {
    makeNotifIcon(state.partner).catch(() => {});
    const p = state.partner;
    $('#partnerName').textContent = p ? p.name : 'Waiting for your partner…';
    setAvatar($('#partnerAvatar'), p);
    setAvatar($('#meAvatar'), state.me);
    setAvatar($('#sheetAvatar'), state.me);
    if (!p) { $('#partnerStatus').textContent = 'Not set up yet'; }
    else setPresence(state.partnerOnline);
    if (state.me) { $('#sheetUser').textContent = '@' + state.me.username; }
  }
  function setPresence(on) {
    state.partnerOnline = on;
    if (!state.partner) return;
    $('#presenceDot').classList.toggle('on', on);
    const s = $('#partnerStatus');
    s.textContent = on ? 'Active now' : 'Away';
    s.classList.toggle('on', on);
  }

  // ---------------- Real-time connection ----------------
  function connect() {
    if (state.socket || !state.token) return;
    if (typeof io === 'undefined') {
      const sc = document.createElement('script');
      sc.src = '/socket.io/socket.io.min.js?r=' + Date.now();
      sc.onload = () => connect();
      sc.onerror = () => setTimeout(connect, 3000);
      document.head.appendChild(sc);
      return;
    }
    const s = io({ auth: { token: state.token }, transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 4000 });
    state.socket = s;
    s.on('connect', () => { diag.live = 'Connected (' + s.io.engine.transport.name + ')'; diag.err = ''; });
    s.on('connect', async () => { setNet(true); setPresence(state.partnerOnline); await syncMessages(); flushOutbox(); });
    s.on('disconnect', (reason) => {
      setNet(navigator.onLine ? 'reconnecting' : false);
      if (reason === 'io server disconnect') setTimeout(() => s.connect(), 1000);
    });
    s.on('connect_error', (err) => { diag.live = 'Not connected'; diag.err = (err && (err.message + (err.description ? ' / ' + (err.description.message || err.description) : ''))) || 'unknown'; });
    s.on('disconnect', (r) => { diag.live = 'Disconnected'; diag.err = r; });
    s.on('connect_error', (err) => {
      if (err && err.message === 'unauthorized') { signedOut(); return; }
      setNet(navigator.onLine ? 'reconnecting' : false);
      if (!s.active) setTimeout(() => s.connect(), 2500);
    });
    s.on('message', (m) => receive(m));
    s.on('presence', (p) => { if (state.partner && p.userId === state.partner.id) setPresence(p.online); });
    s.on('presence:list', (ids) => { if (state.partner) setPresence(ids.includes(state.partner.id)); });
    s.on('profile', (u) => {
      if (state.me && u.id === state.me.id) saveProfile(u);
      else { const wasNone = !state.partner; saveProfile(undefined, u); if (wasNone) setPresence(true); }
    });
  }

  function setNet(on) {
    $('#offlineBanner').classList.toggle('hidden', on === true || on === 'reconnecting');
    if (on !== true && state.partner) { $('#presenceDot').classList.remove('on'); }
  }
  window.addEventListener('online', () => {
    setNet(state.socket && state.socket.connected ? true : 'reconnecting');
    if (state.socket && state.socket.connected) setPresence(state.partnerOnline);
    if (state.socket && !state.socket.connected) state.socket.connect();
    flushOutbox();
  });
  window.addEventListener('offline', () => setNet(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.token) return;
    clearNotifications();
    checkAlive();
    refreshProfile();
    reloadFromStore();
  });

  // A phone that slept may hold a dead connection that still looks "connected".
  function checkAlive() {
    const s = state.socket;
    if (!s) return;
    if (!s.connected) { s.connect(); return; }
    s.timeout(3000).emit('alive', (err, ids) => {
      if (err) { s.disconnect(); s.connect(); return; }   // dead: reconnect now
      if (state.partner) setPresence(ids.includes(state.partner.id));
      syncMessages(); flushOutbox();
    });
  }
  setInterval(() => { if (document.visibilityState === 'visible') checkAlive(); }, 15000);
  window.addEventListener('focus', checkAlive);
  window.addEventListener('pageshow', checkAlive);

  async function syncMessages() {
    try {
      const { messages } = await api('/api/messages?after=' + state.lastTs);
      let changed = false;
      for (const m of messages) changed = (await storeServer(m, false)) || changed;
      if (changed) renderAll(true);
    } catch (_) {}
  }

  async function storeServer(m, render = true) {
    const prev = state.msgs.get(m.id);
    const isNew = !prev || prev.pending;
    state.msgs.set(m.id, m);
    await DB.messages.put(m);
    if (m.created_at > state.lastTs) { state.lastTs = m.created_at; DB.kv.set('lastTs', m.created_at); }
    if (render && isNew) { if (prev) updateRow(m); else appendOrRender(m); }
    return isNew;
  }

  async function instantNotify(m) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const reg = await navigator.serviceWorker.ready;
      const target = navigator.serviceWorker.controller || reg.active;
      if (!target) return;
      const text = m.text.length > 200 ? m.text.slice(0, 200) + '…' : m.text;
      target.postMessage({ type: 'notify', payload: { title: state.partner ? state.partner.name : 'Hubb', body: text, messageId: m.id } });
    } catch (_) {}
  }

  async function receive(m) {
    const known = state.msgs.get(m.id);
    if (known && !known.pending) return;
    await storeServer(m);
    if (state.me && Number(m.sender_id) !== Number(state.me.id)) {
      if (document.visibilityState === 'visible') chime();
      else instantNotify(m);   // app in background: show the banner right now (system sound plays with it)
    }
  }

  // Messages delivered by the service worker or a push while the page wasn't looking
  async function reloadFromStore() {
    const before = state.msgs.size;
    const pendingBefore = [...state.msgs.values()].filter((m) => m.pending).length;
    await loadCache();
    const pendingAfter = [...state.msgs.values()].filter((m) => m.pending).length;
    if (state.msgs.size !== before || pendingAfter !== pendingBefore) renderAll(true);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (!e.data) return;
      if (e.data.type === 'outbox-synced') reloadFromStore();
      if (e.data.type === 'focus-input') { reloadFromStore(); $('#input').focus(); }
    });
  }

  // ---------------- Sending (offline-first outbox) ----------------
  async function send(text) {
    text = text.replace(/\s+$/, '');
    if (!text.trim()) return;
    const m = { id: uid(), sender_id: state.me ? state.me.id : 0, text, created_at: Date.now() };
    await DB.outbox.put(m);
    const local = { ...m, pending: true };
    state.msgs.set(m.id, local);
    appendOrRender(local, true);
    flushOutbox();
  }

  let flushing = false;
  async function flushOutbox() {
    if (!state.token) return;
    if (!state.socket || !state.socket.connected) { requestBackgroundSync(); return; }
    if (flushing) return;
    flushing = true;
    try {
      const items = (await DB.outbox.all()).sort((a, b) => a.created_at - b.created_at);
      for (const it of items) {
        const res = await new Promise((resolve) =>
          state.socket.timeout(10000).emit('send', { id: it.id, text: it.text }, (err, r) => resolve(err ? null : r)));
        if (res && res.ok) { await DB.outbox.del(it.id); await storeServer(res.message); }
        else if (res && res.error === 'invalid') { await DB.outbox.del(it.id); state.msgs.delete(it.id); renderAll(); toast(res.message || 'Message could not be sent'); }
        else { requestBackgroundSync(); break; }
      }
    } finally { flushing = false; }
  }
  async function requestBackgroundSync() {
    try { const reg = await navigator.serviceWorker.ready; if (reg.sync) await reg.sync.register('hubb-outbox'); } catch (_) {}
  }

  // ---------------- Rendering ----------------
  const list = $('#list'), scroller = $('#messages');
  const dayKey = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
  function dayLabel(ts) {
    const d = new Date(ts), now = new Date();
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (dayKey(ts) === dayKey(now)) return 'Today';
    if (dayKey(ts) === dayKey(y)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }
  const timeLabel = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const isJumbo = (t) => {
    const s = t.trim();
    if (!s || s.length > 24) return false;
    if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|\s)+$/u.test(s)) return false;
    const seg = window.Intl && Intl.Segmenter ? [...new Intl.Segmenter().segment(s.replace(/\s/g, ''))].length : 1;
    return seg <= 3;
  };
  const sorted = () => [...state.msgs.values()].sort((a, b) => a.created_at - b.created_at);
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
  const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };

  function rowFor(m, prev) {
    const mine = !!state.me && Number(m.sender_id) === Number(state.me.id);
    const row = document.createElement('div');
    row.className = 'row ' + (mine ? 'mine' : 'theirs') + (m.pending ? ' pending' : '');
    row.dataset.id = m.id;
    if (prev && prev.sender_id === m.sender_id && m.created_at - prev.created_at < 3 * 60 * 1000 && dayKey(prev.created_at) === dayKey(m.created_at)) row.classList.add('cont');
    // Show who sent it: name above the first message of each group, partner's photo beside their messages
    const who = mine ? state.me : state.partner;
    if (!row.classList.contains('cont')) {
      const label = document.createElement('div');
      label.className = 'sender';
      label.textContent = mine ? 'You' : (who ? who.name : 'Partner');
      row.appendChild(label);
    }
    if (!mine) {
      const av = document.createElement('div');
      av.className = 'avatar tiny' + (row.classList.contains('cont') ? ' ghost' : '');
      setAvatar(av, who);
      row.appendChild(av);
    }
    const b = document.createElement('div');
    b.className = 'bubble' + (isJumbo(m.text) ? ' jumbo' : '');
    b.appendChild(document.createTextNode(m.text));
    const t = document.createElement('span'); t.className = 'time'; t.textContent = timeLabel(m.created_at);
    b.appendChild(t);
    row.appendChild(b);
    return row;
  }
  function dayEl(ts) { const d = document.createElement('div'); d.className = 'day'; d.textContent = dayLabel(ts); return d; }

  let lastRendered = null;
  function renderAll(keepPosition) {
    const stick = !keepPosition || nearBottom();
    const frag = document.createDocumentFragment();
    let prev = null;
    for (const m of sorted()) {
      if (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) frag.appendChild(dayEl(m.created_at));
      const r = rowFor(m, prev);
      if (prev && r.classList.contains('cont')) frag.lastChild && frag.lastChild.classList && frag.lastChild.classList.add('cont-next');
      frag.appendChild(r);
      prev = m;
    }
    list.replaceChildren(frag);
    lastRendered = prev;
    $('#empty').classList.toggle('hidden', state.msgs.size > 0);
    if (stick) toBottom();
  }
  function appendOrRender(m, forceScroll) {
    if (lastRendered && m.created_at < lastRendered.created_at) return renderAll(true);
    const stick = forceScroll || nearBottom();
    if (!lastRendered || dayKey(lastRendered.created_at) !== dayKey(m.created_at)) list.appendChild(dayEl(m.created_at));
    const r = rowFor(m, lastRendered);
    if (r.classList.contains('cont') && list.lastElementChild) list.lastElementChild.classList.add('cont-next');
    list.appendChild(r);
    lastRendered = m;
    $('#empty').classList.add('hidden');
    if (stick) requestAnimationFrame(toBottom);
  }
  function updateRow(m) {
    const row = list.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
    if (!row) return appendOrRender(m);
    row.classList.remove('pending');
    const t = row.querySelector('.time'); if (t) t.textContent = timeLabel(m.created_at);
  }

  function enterChat() {
    show('#chat');
    clearNotifications();
    if (location.search.includes('reply=1')) { history.replaceState(null, '', '/'); setTimeout(() => $('#input').focus(), 300); }
    renderHeader();
    renderAll();
    setupNotifBanner();
    $('#input').focus({ preventScroll: true });
  }

  // ---------------- Composer ----------------
  const input = $('#input'), sendBtn = $('#sendBtn');
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    const empty = !input.value.trim();
    sendBtn.classList.toggle('heart', empty);
    sendBtn.setAttribute('aria-label', empty ? 'Send a heart' : 'Send');
  }
  input.addEventListener('input', autosize);
  const touch = matchMedia('(pointer: coarse)').matches;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    audio();
    const text = input.value;
    if (!text.trim()) {
      send('❤️');
      sendBtn.classList.remove('beat'); void sendBtn.offsetWidth; sendBtn.classList.add('beat');
    } else {
      send(text);
      input.value = ''; autosize();
    }
    if (!touch) input.focus();
  });

  // ---------------- Emoji picker ----------------
  const EMOJI = [
    ['💗', 'Love', '❤️ 🧡 💛 💚 💙 💜 🤎 🖤 🤍 💕 💞 💓 💗 💖 💘 💝 💟 ❣️ 💌 💋 😘 😍 🥰 😻 💑 👩‍❤️‍👨 💏 👩‍❤️‍💋‍👨 🫶 🤗 🌹 💐 🌷 🌸 💍 💎 🎁 🍫 🧸 🕯️ 🥂 🍷 ✨ 🌙 ⭐ 🌟 🔥 💯 ♾️ 🏡 👶 🍼'],
    ['😊', 'Smileys', '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥹 😋 😛 😜 🤪 😝 🤑 🤭 🫢 🤫 🤔 🫡 🤐 🤨 😐 😑 😶 🫥 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 🫤 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 🤡 👻 👽 🤖 😺 😸 😹 😼 🙈 🙉 🙊'],
    ['👋', 'Gestures', '👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 💪 🫂 👀 💅 🤳 💃 🕺 🙋‍♀️ 🙋‍♂️ 🤦‍♀️ 🤦‍♂️ 🤷‍♀️ 🤷‍♂️ 🙆‍♀️ 🙅‍♂️ 💁‍♀️ 🧎 🚶‍♀️ 🏃‍♂️'],
    ['🌿', 'Nature', '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🐤 🦋 🐝 🐞 🐢 🐬 🐳 🦄 🌵 🌲 🌳 🌴 🌱 🌿 🍀 🍁 🍂 🌺 🌻 🌼 🌞 🌝 🌛 ⭐ 🌈 ☀️ ⛅ 🌧️ ⛈️ ❄️ ☃️ 🌊 💧 🌍'],
    ['🍕', 'Food', '🍎 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🌽 🥕 🧄 🍞 🧀 🥚 🍳 🥞 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍚 🍰 🎂 🧁 🍩 🍪 🍫 🍬 🍭 🍦 ☕ 🍵 🧋 🥤 🧃 🍹'],
    ['🎉', 'Activities', '🎉 🎊 🎈 🎂 🎁 🎄 🎆 🎇 🏆 🥇 ⚽ 🏀 🏏 🏸 🎾 🏓 🎮 🎲 🧩 🎯 🎬 🎤 🎧 🎵 🎶 🎸 🎹 📚 ✏️ 💻 📱 📷 🛍️ 🛒 🚗 ✈️ 🏖️ 🏝️ ⛰️ 🏕️ 🕌 🏠 ⏰ 💤 💡 💰 📍 ✅ ❌ ❓ ❗ 💬 💭 🔔'],
  ];
  const panel = $('#emojiPanel'), grid = $('#emojiGrid'), tabs = $('#emojiTabs');
  let recent = [];
  function buildTabs() {
    tabs.innerHTML = '';
    const all = [['🕘', 'Recent', null], ...EMOJI];
    all.forEach(([icon, name], i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = icon; b.title = name; b.dataset.i = i;
      tabs.appendChild(b);
    });
  }
  function showCat(i) {
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.i) === i));
    grid.innerHTML = '';
    const items = i === 0 ? recent : EMOJI[i - 1][2].split(' ');
    const label = document.createElement('div'); label.className = 'emoji-label';
    label.textContent = i === 0 ? (recent.length ? 'Recently used' : 'Your recently used emoji will appear here') : EMOJI[i - 1][1];
    grid.appendChild(label);
    for (const e of items) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = e; grid.appendChild(b);
    }
    grid.scrollTop = 0;
  }
  tabs.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showCat(Number(b.dataset.i)); });
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const em = b.textContent;
    const s = input.selectionStart ?? input.value.length, en = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, s) + em + input.value.slice(en);
    const pos = s + em.length; input.setSelectionRange(pos, pos);
    autosize();
    recent = [em, ...recent.filter((x) => x !== em)].slice(0, 32);
    DB.kv.set('recentEmoji', recent);
  });
  $('#emojiBtn').addEventListener('click', async () => {
    const open = panel.classList.contains('hidden');
    if (open) {
      recent = (await DB.kv.get('recentEmoji')) || [];
      if (!tabs.children.length) buildTabs();
      showCat(recent.length ? 0 : 1);
      input.blur();
    }
    panel.classList.toggle('hidden', !open);
    $('#emojiBtn').classList.toggle('active', open);
    if (nearBottom()) requestAnimationFrame(toBottom);
  });
  input.addEventListener('focus', () => { if (touch) { panel.classList.add('hidden'); $('#emojiBtn').classList.remove('active'); } });

  // ---------------- Profile sheet ----------------
  async function renderDiag() {
    const el = $('#diag'); if (!el) return;
    const lines = [];
    const sock = state.socket;
    lines.push('Live connection: ' + (sock && sock.connected ? '✅ ' + diag.live : '❌ ' + diag.live + (diag.err ? ' — ' + diag.err : '')));
    lines.push('Socket library: ' + (typeof io === 'undefined' ? '❌ not loaded' : '✅ loaded'));
    lines.push('Internet: ' + (navigator.onLine ? '✅' : '❌ offline'));
    lines.push('Notification permission: ' + ('Notification' in window ? Notification.permission : 'not supported'));
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
      lines.push('Push registered on this device: ' + (sub ? '✅' : '❌'));
    } catch (e) { lines.push('Push check error: ' + e.message); }
    lines.push('Partner online: ' + (state.partnerOnline ? 'yes' : 'no'));
    el.textContent = lines.join('\n');
  }

  function openSheet() {
    renderDiag();
    $('#nameInput').value = state.me ? state.me.name : '';
    $('#soundToggle').checked = state.soundOn;
    updateNotifUI();
    $('#installRow').classList.toggle('hidden', !state.installEvt);
    $('#backdrop').classList.remove('hidden'); $('#sheet').classList.remove('hidden');
  }
  function closeSheet() { $('#backdrop').classList.add('hidden'); $('#sheet').classList.add('hidden'); }
  $('#meBtn').addEventListener('click', openSheet);
  $('#backdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  $('#nameSave').addEventListener('click', async () => {
    const name = $('#nameInput').value.trim(); if (!name) return;
    try { const { me } = await api('/api/profile', { method: 'POST', body: { name } }); await saveProfile(me); toast('Name updated'); }
    catch (e) { toast(navigator.onLine ? e.message : 'Connect to the internet to update your profile'); }
  });

  $('#avatarInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0]; e.target.value = '';
    if (!file) return;
    try {
      const avatar = await resizeImage(file, 320);
      const { me } = await api('/api/profile', { method: 'POST', body: { avatar } });
      await saveProfile(me); toast('Profile picture updated');
    } catch (err) { toast(navigator.onLine ? (err.message || 'Could not use that picture') : 'Connect to the internet to change your picture'); }
  });
  async function resizeImage(file, size) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const c = document.createElement('canvas'); c.width = c.height = size;
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
      return c.toDataURL('image/jpeg', 0.85);
    } finally { URL.revokeObjectURL(url); }
  }

  $('#soundToggle').addEventListener('change', (e) => { state.soundOn = e.target.checked; DB.kv.set('soundOn', state.soundOn); if (state.soundOn) chime(); });
  $('#soundTest').addEventListener('click', () => { const was = state.soundOn; state.soundOn = true; chime(); state.soundOn = was; });

  // ---------------- Notifications (Web Push) ----------------
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  function updateNotifUI() {
    const el = $('#notifState'), btn = $('#notifBtn');
    if (!pushSupported()) { el.textContent = 'Not supported in this browser'; btn.classList.add('hidden'); return; }
    const p = Notification.permission;
    el.textContent = p === 'granted' ? 'On — you’ll be notified of new messages' : p === 'denied' ? 'Blocked — allow them in your browser’s site settings' : 'Off';
    btn.classList.toggle('hidden', p !== 'default');
  }
  async function setupNotifBanner() {
    if (!pushSupported()) return;
    if (Notification.permission === 'granted') { subscribePush().catch(() => {}); return; }
    const dismissed = await DB.kv.get('notifDismissed');
    $('#notifBanner').classList.toggle('hidden', Notification.permission !== 'default' || !!dismissed);
  }
  async function enableNotifications() {
    if (!pushSupported()) return toast('Notifications are not supported here');
    const perm = await Notification.requestPermission();
    $('#notifBanner').classList.add('hidden');
    updateNotifUI();
    if (perm !== 'granted') return toast('Notifications were not allowed');
    try { await subscribePush(); chime(); toast('Notifications are on 🔔'); }
    catch (e) { toast('Could not turn on notifications: ' + e.message); }
  }
  async function subscribePush() {
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('/api/push/key');
    const appKey = b64ToBytes(key);
    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options && sub.options.applicationServerKey) {
      const cur = new Uint8Array(sub.options.applicationServerKey);
      if (cur.length !== appKey.length || cur.some((v, i) => v !== appKey[i])) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
    await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  }
  function b64ToBytes(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  $('#notifTest').addEventListener('click', async () => {
    const btn = $('#notifTest'); btn.disabled = true;
    try {
      if (!pushSupported()) return toast('This browser/app does not support notifications');
      if (Notification.permission === 'denied') return toast('Notifications are blocked. Allow them in phone Settings → Apps → Hubb → Notifications');
      if (Notification.permission !== 'granted') { await enableNotifications(); if (Notification.permission !== 'granted') return; }
      await subscribePush();
      const { devices } = await api('/api/push/test', { method: 'POST' });
      toast(devices ? 'Test sent — a notification should appear in a few seconds' : 'This device is not registered for notifications yet');
    } catch (e) { toast('Test failed: ' + e.message); }
    finally { btn.disabled = false; }
  });
  $('#notifEnable').addEventListener('click', enableNotifications);
  $('#notifBtn').addEventListener('click', enableNotifications);
  $('#notifDismiss').addEventListener('click', () => { $('#notifBanner').classList.add('hidden'); DB.kv.set('notifDismissed', true); });

  // ---------------- Install (Chrome "Install app") ----------------
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installEvt = e;
    $('#installBtn').classList.remove('hidden');
  });
  async function doInstall() {
    if (!state.installEvt) return;
    state.installEvt.prompt();
    await state.installEvt.userChoice.catch(() => {});
    state.installEvt = null;
    $('#installBtn').classList.add('hidden'); $('#installRow').classList.add('hidden');
  }
  $('#installBtn').addEventListener('click', doInstall);
  $('#installBtn2').addEventListener('click', doInstall);
  window.addEventListener('appinstalled', () => { state.installEvt = null; $('#installBtn').classList.add('hidden'); toast('Hubb installed 💞'); });

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((reg) => {
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
    // A new version was installed: reload once so it's used straight away
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
  }

  // refresh relative day labels after midnight
  setInterval(() => { if (!document.hidden && state.token) renderAll(true); }, 30 * 60 * 1000);

  boot().catch((e) => { console.error(e); showAuth(); });
})();
