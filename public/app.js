// Chat UI: chat list, one open chat, composer, usage, shortcuts. Talks to the
// server over a single WebSocket (/ws/chat); rendering lives in render.js and
// the "working" indicator in loader.js. Nothing here depends on which agent
// runs behind the server.

import { Thread } from '/render.js';
import { createLoader } from '/loader.js';
import { $, h, touch, narrow, isMac, MOD, standalone, native, appKey, isAppKey, itemKey, itemNumber, ask, api, storage, toast, fail, place, hidePopovers, showMenu, editInline, setupSidebar, setupPinning, setConn, accentFor, setHue, indexLabel, MORE_ICON, ago } from '/ui.js';

const randomId = () => Math.random().toString(36).slice(2, 10);
const local = storage('chat'); // last chat, unsent drafts, settings for new chats

const thread = new Thread($('#thread'));
const input = $('#input');
const messages = $('#messages');

const state = {
  chats: [], // pinned first, then newest first, stable: ⌘1…⌘9 follow this order
  view: 'chat', // chat | shortcuts
  chatId: null, // null = a new chat, created by its first message
  nextHue: null, // accent the next new chat will get
  status: 'idle',
  queue: [],
  limits: null, // { status, windows: [{ id, label, utilization, resetsAt }], updated }
  phase: {}, // what the working indicator shows: { phase, label, moment }
  opening: null, // { chatId, buffer } until the history arrives
  attachments: [], // { id, name, mediaType, preview, uploading, file, url }
  sends: new Map(), // ref -> what was sent, to restore it on error
  editing: false, // a title is being renamed inline: hold list re-renders
  agent: { models: [], efforts: [], cwd: null, home: null }, // per-chat choices the agent offers, where it starts
  newSettings: { model: null, effort: null, ...local.get('newSettings', {}) }, // for the next new chat
  newDir: null, // where the next new chat starts (a terminal's "New chat in this folder"); null = the agent's folder
  listed: false, // the first list arrived (later unread changes are news)
  off: false, // turned off from here: stop reconnecting
};
let loader = null;

// ------------------------------------------------------------------ utils

const hhmm = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function resetsIn(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const mins = Math.max(0, Math.round((ts - Date.now()) / 60000));
  const rel = mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`;
  const sameDay = d.toDateString() === new Date().toDateString();
  const when = sameDay ? hhmm(d) : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${hhmm(d)}`;
  return `resets in ${rel} (${when})`;
}

function tokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

const level = (pct) => (pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '');

// ---------------------------------------------------------------- accents

// Every chat has its own hue (picked by the server); it tints the whole
// page. The New chat button previews the next one.
function applyAccent() {
  setHue(state.chatId ? current()?.hue : state.nextHue);
  $('#new-chat').style.setProperty('--swatch', accentFor(state.nextHue));
}

// Inline rename (ui.js) with the list held still while the field is open.
function renameInline(el, chat) {
  editInline(el, chat?.title || '', (t) => (t ? renameChat(chat.id, t) : Promise.resolve()), {
    onStart: () => (state.editing = true),
    onEnd: () => {
      state.editing = false;
      renderList();
      renderHeader();
    },
  });
}

// ------------------------------------------------------------- connection

let ws = null;
let retries = 0;
let retryTimer = null;

function connect() {
  clearTimeout(retryTimer);
  if (state.off) return;
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/chat`);
  ws = socket;
  setConn('connecting');
  socket.onopen = () => {
    retries = 0;
    setConn('online');
    sendVisibility(); // before "open": a visible page marks the chat read
    openChat(state.chatId); // (re)load what's on screen
  };
  socket.onmessage = (e) => onMessage(JSON.parse(e.data));
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    setConn('offline');
    retryTimer = setTimeout(connect, Math.min(8000, 400 * 2 ** retries++));
    checkPower(); // closed because it was turned off?
  };
}

function wsSend(msg) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

// Phones drop sockets while asleep; reconnect as soon as the page is back.
// The server also needs to know: chats only count as read on a visible page.
const sendVisibility = () => wsSend({ op: 'visibility', visible: !document.hidden });
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('away', document.hidden); // holds the notice's countdown
  if (!document.hidden && state.off) checkPower();
  else if (!document.hidden && ws?.readyState !== WebSocket.OPEN) {
    retries = 0;
    connect();
  } else sendVisibility();
});

function onMessage(m) {
  const here = m.chatId && m.chatId === state.chatId;
  switch (m.op) {
    case 'agent':
      state.agent = { models: m.models, efforts: m.efforts, cwd: m.cwd || null, home: m.home || null };
      renderStats();
      renderDir();
      break;

    case 'chats': {
      const before = new Map(state.chats.map((c) => [c.id, c]));
      state.chats = m.chats;
      state.nextHue = m.nextHue;
      if (state.listed) for (const c of m.chats) if (c.unread && !before.get(c.id)?.unread) notify(c);
      state.listed = true;
      renderList();
      renderHeader();
      break;
    }

    case 'limits':
      state.limits = m.limits;
      renderHeader();
      break;

    // The open chat's last page; older ones come as it scrolls up.
    case 'history': {
      if (!here) return;
      const buffered = state.opening?.buffer || [];
      state.opening = null;
      thread.reset();
      thread.numberFrom(m.items, m.turnsBefore || 0);
      for (const item of [...m.items, ...buffered]) thread.add(item);
      remember([...(m.prompts || []).map((text) => ({ t: 'user', text })), ...m.items, ...buffered]);
      for (const draft of m.drafts) thread.live({ t: 'start', ...draft });
      applyStatus(m.status, m.queue);
      scrollToBottom();
      setPages(m.items[0]?.id, m.more);
      break;
    }

    case 'older': {
      if (!here || m.before !== pages.oldest) return; // another chat, or cleared since
      holdAnchor();
      thread.prepend(m.items, m.turnsBefore);
      followAnchor();
      setPages(m.items[0]?.id ?? pages.oldest, m.more);
      break;
    }

    // /clear: the conversation starts over on every device showing it.
    case 'cleared':
      if (!here) return;
      if (state.opening) state.opening.buffer = [];
      thread.reset();
      forgetRecent();
      setPages(null, false);
      break;

    case 'created':
      // Our first message made a new chat: it's the one on screen now.
      if (!state.sends.has(m.ref)) return;
      state.chatId = m.chatId;
      state.newDir = null;
      local.set('last', m.chatId);
      history.replaceState(null, '', `#${m.chatId}`);
      moveDraft('new', m.chatId);
      renderHeader();
      renderList();
      break;

    case 'item':
      if (!here) return;
      if (state.opening) return state.opening.buffer.push(m.item);
      thread.add(m.item);
      itemPhase(m.item);
      remember([m.item]);
      break;

    case 'live':
      if (!here || state.opening) return;
      thread.live(m.ev);
      livePhase(m.ev);
      break;

    case 'status':
      if (here) applyStatus(m.status, m.queue);
      break;

    case 'ack':
      state.sends.delete(m.ref);
      break;

    case 'error': {
      const sent = state.sends.get(m.ref);
      state.sends.delete(m.ref);
      if (sent && !input.value && !state.attachments.length) {
        input.value = sent.text;
        state.attachments = sent.attachments;
        renderAttachments();
        autosize();
      }
      if (state.opening && m.chatId === state.opening.chatId) {
        state.opening = null;
        go(null); // that chat is gone
      }
      fail(m.error);
      break;
    }

    case 'deleted':
      if (here) go(null);
      break;
  }
}

// ----------------------------------------------------------------- chats

// Routes: #<chatId> (or empty for a new chat) and #shortcuts.
function route() {
  const hash = location.hash.slice(1);
  return hash === 'shortcuts' ? { view: 'shortcuts' } : { view: 'chat', chatId: hash || null };
}
const hashId = () => route().chatId ?? null;

function go(id) {
  id = id || null;
  if (state.view === 'chat' && id === state.chatId && hashId() === id) return; // already open
  if (route().view === 'chat' && hashId() === id) applyRoute();
  else location.hash = id || '';
}

function applyRoute() {
  const r = route();
  if (r.view === 'shortcuts') return setView('shortcuts');
  // Back from Shortcuts to the chat that's still loaded behind it.
  if (state.view !== 'chat' && r.chatId === state.chatId) return setView('chat');
  setView('chat');
  openChat(r.chatId);
}
window.addEventListener('hashchange', applyRoute);

function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  $('#open-shortcuts').classList.toggle('active', view === 'shortcuts');
  hidePopovers();
  renderHeader();
  renderList();
  if (narrow()) setDrawer(false);
}

function openChat(id) {
  const changed = id !== state.chatId;
  if (changed) forgetRecent();
  state.chatId = id || null;
  if (state.chatId) state.newDir = null;
  local.set('last', state.chatId);
  thread.reset();
  setPages(null, false);
  applyStatus('idle', []);
  hidePopovers();
  $('#welcome').hidden = Boolean(state.chatId);
  if (!state.chatId) scrollToBottom();
  if (changed) restoreDraft();
  renderHeader();
  renderList();
  state.opening = state.chatId ? { chatId: state.chatId, buffer: [] } : null;
  wsSend({ op: 'open', chatId: state.chatId });
  if (narrow()) setDrawer(false);
}

function newChat() {
  state.newDir = null;
  renderDir();
  go(null);
  if (!touch) input.focus();
}

function focusInput() {
  // From Shortcuts, the composer only shows once the chat view is back (on hashchange).
  if (state.view !== 'chat') {
    addEventListener('hashchange', focusInput, { once: true });
    return go(state.chatId);
  }
  hidePopovers();
  if (narrow()) setDrawer(false);
  input.focus();
}

const current = () => state.chats.find((c) => c.id === state.chatId);

const renameChat = (id, title) => api('PATCH', `/api/chats/${id}`, { title });

async function deleteChat(chat) {
  const sure = await ask({
    title: 'Delete this chat?',
    text: `"${chat.title || 'New chat'}" and its history are removed from the app.`,
    confirm: 'Delete',
    danger: true,
  });
  if (!sure) return;
  await api('DELETE', `/api/chats/${chat.id}`)
    .then(() => chat.id === state.chatId && go(null))
    .catch(fail);
}

// Without the mouse (⇧⌘E): the same rename as double-clicking it in the sidebar.
async function renameWithDialog(chat) {
  const title = await ask({ title: 'Rename chat', value: chat.title || '', confirm: 'Rename' });
  if (title && title !== chat.title) await renameChat(chat.id, title).catch(fail);
}

// Pinned chats (meta.pinned, their place from 1) come first in the list, in
// the server's order — mirrored here so a drop shows at once.
const isPinned = (c) => c.pinned != null;
const byPlace = (a, b) => (a.pinned ?? Infinity) - (b.pinned ?? Infinity) || b.created - a.created;

// index: its place among the pinned chats; null unpins it.
function movePin(id, index) {
  const before = state.chats.filter(isPinned).map((c) => c.id);
  const ids = before.filter((x) => x !== id);
  if (index != null) ids.splice(index, 0, id);
  if (ids.join() === before.join()) return;
  state.chats = state.chats.map((c) => ({ ...c, pinned: ids.indexOf(c.id) + 1 || undefined })).sort(byPlace);
  renderList();
  // The server broadcasts the new list; if it refused, put the old one back.
  api('PUT', '/api/chats/pinned', { ids }).catch(async (err) => {
    fail(err);
    state.chats = await api('GET', '/api/chats').catch(() => state.chats);
    renderList();
  });
}
const togglePin = (chat) => movePin(chat.id, isPinned(chat) ? null : state.chats.filter(isPinned).length);

// Items are kept and updated in place (keyed by id): rebuilding them would
// break double-click-to-rename and lose focus while the list refreshes.
const listItems = new Map(); // chat id -> { el, avatar, name, sub, kbd }

function listItem(c) {
  const avatar = h('span', { class: 'avatar', 'aria-hidden': 'true' });
  const name = h('span', { class: 'name' });
  const sub = h('span', { class: 'sub' });
  const kbd = h('kbd', { class: 'kbd' });
  const rename = () => renameInline(name, state.chats.find((x) => x.id === c.id) || c);
  const more = h('button', {
    type: 'button',
    class: 'more',
    innerHTML: MORE_ICON,
    'aria-label': 'Chat options',
    onclick: (e) => {
      e.stopPropagation();
      const chat = state.chats.find((x) => x.id === c.id) || c;
      showMenu(more, [
        { label: isPinned(chat) ? 'Unpin' : 'Pin', run: () => togglePin(chat) },
        { label: 'Rename', run: rename },
        { label: 'Delete', danger: true, run: () => deleteChat(chat) },
      ]);
    },
  });
  const el = h(
    'div',
    {
      class: 'side-item',
      dataset: { id: c.id },
      role: 'button',
      tabIndex: 0,
      onclick: () => go(c.id),
      ondblclick: (e) => {
        e.preventDefault();
        rename();
      },
      onkeydown: (e) => e.key === 'Enter' && e.target === e.currentTarget && go(c.id),
    },
    avatar,
    h('span', { class: 'text' }, name, sub),
    h('span', { class: 'side' }, h('span', { class: 'unread-dot', title: 'New reply' }), kbd, more),
  );
  return { el, avatar, name, sub, kbd };
}

function renderList() {
  if (state.editing || pinning.dragging) return; // would clobber the rename field / the drag
  const nav = $('#chat-list');
  const ids = new Set(state.chats.map((c) => c.id));
  for (const [id, item] of listItems) {
    if (!ids.has(id)) {
      item.el.remove();
      listItems.delete(id);
    }
  }
  state.chats.forEach((c, i) => {
    let item = listItems.get(c.id);
    if (!item) listItems.set(c.id, (item = listItem(c)));
    const name = c.title || 'New chat';
    const busy = c.status === 'running';
    item.el.classList.toggle('active', state.view === 'chat' && c.id === state.chatId);
    item.el.style.setProperty('--item-accent', accentFor(c.hue));
    item.el.title = i < 9 ? `${name}  (${itemKey(i + 1)})` : name;
    item.avatar.textContent = indexLabel(i);
    item.avatar.classList.toggle('busy', busy);
    item.name.textContent = name;
    const when = ago(c.updated) === 'now' ? 'just now' : `${ago(c.updated)} ago`;
    item.sub.textContent = busy ? (c.queued ? `working · ${c.queued} queued` : 'working…') : c.unread ? `replied ${when}` : when;
    item.sub.classList.toggle('busy', busy || c.unread);
    item.el.classList.toggle('unread', c.unread && !busy);
    item.kbd.textContent = i < 9 ? itemKey(i + 1) : '';
    item.kbd.hidden = i >= 9;
    (isPinned(c) ? pinning.nav : nav).append(item.el); // moves existing nodes into order
  });
  const pinned = state.chats.filter(isPinned).length;
  pinning.update(pinned);
  $('#chat-count').textContent = state.chats.length > pinned ? indexLabel(state.chats.length - pinned - 1) : '';
  let empty = nav.querySelector('.side-list-empty');
  if (!state.chats.length && !empty) nav.append((empty = h('div', { class: 'side-list-empty', textContent: 'No chats yet.' })));
  if (state.chats.length) empty?.remove();
  renderUnread();
}

const pinning = setupPinning({ list: $('#chat-list'), onDrop: movePin, onEnd: renderList });

// ---------------------------------------------------------------- unread

// The server decides what's unread (a turn ended while no device had the
// chat open and visible); opening a chat on a visible page marks it read.
const unreadCount = () => state.chats.filter((c) => c.unread).length;

// Count on the floating sidebar toggle (the list is hidden) and on the
// installed app's icon.
function renderUnread() {
  const n = unreadCount();
  const badge = $('#unread-badge');
  badge.hidden = !n;
  badge.textContent = n > 9 ? '9+' : String(n);
  try {
    if (n) navigator.setAppBadge?.(n)?.catch(() => {});
    else navigator.clearAppBadge?.()?.catch(() => {});
  } catch {}
}

// A chat that isn't on screen just replied: a notice with the start of the
// reply that opens it (click, or ⌘J). It stays NOTICE_SECONDS on screen —
// a bar shows the time left, which stops while hovered or while the page is
// in the background (see style.css), so it isn't missed.
const NOTICE_SECONDS = 30;
let noticeChat = null;

function notify(chat) {
  if (chat.id === state.chatId && state.view === 'chat' && !document.hidden) return;
  noticeChat = chat.id;
  const others = state.chats.filter((c) => c.unread && c.id !== chat.id).length;
  const el = $('#notice');
  el.style.setProperty('--item-accent', accentFor(chat.hue));
  el.style.setProperty('--notice-time', `${NOTICE_SECONDS}s`);
  const time = h('span', { class: 'notice-time' });
  time.addEventListener('animationend', hideNotice);
  el.replaceChildren(
    h(
      'div',
      { class: 'notice-head' },
      h('span', { class: 'dot' }),
      h('span', { textContent: 'New reply' }),
      h('span', { class: 'num', textContent: indexLabel(state.chats.indexOf(chat)) }),
      h('button', { type: 'button', class: 'notice-x', 'aria-label': 'Dismiss', textContent: '×', onclick: (e) => (e.stopPropagation(), hideNotice()) }),
    ),
    h('div', { class: 'notice-title', textContent: chat.title || 'New chat' }),
    h('p', { class: 'notice-preview', textContent: chat.preview || 'The turn ended — open the chat to see it.' }),
    h(
      'div',
      { class: 'notice-foot' },
      others ? h('span', { class: 'notice-more', textContent: `+${others} more unread` }) : null,
      h('span', { class: 'notice-open' }, 'Open', touch ? null : h('kbd', { textContent: `${MOD}J` })),
    ),
    time,
  );
  el.onclick = openReply;
  el.hidden = false;
}

function hideNotice() {
  $('#notice').hidden = true;
  noticeChat = null;
}

// The chat in the notice, else the newest unread one. False when there's none.
function openReply() {
  const newest = state.chats.filter((c) => c.unread).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))[0];
  const id = noticeChat || newest?.id;
  if (!id) return false;
  hideNotice();
  go(id);
}

// There's no header: this keeps the tab title, the accent and the status
// line under the composer in sync with the open chat.
function renderHeader() {
  const chat = current();
  const n = unreadCount();
  document.title = `${n ? `(${n}) ` : ''}${state.view === 'shortcuts' ? 'Shortcuts' : chat?.title || 'New chat'}`;
  applyAccent();
  renderDir();
  renderStats();
}

// The status line's left side: the folder the open chat's agent works in (a
// new chat: where it will start). The chat itself is the one lit in the sidebar.
function renderDir() {
  const dir = current()?.cwd || state.newDir || state.agent.cwd;
  const el = $('#chat-dir');
  el.title = dir || '';
  // LRM marks keep the slashes in order inside the rtl box, which trims a long
  // path from the left so its last folders stay visible.
  el.textContent = dir ? `\u200e${shortPath(dir)}\u200e` : '';
}

const shortPath = (dir) => {
  const home = state.agent.home;
  return home && (dir === home || dir.startsWith(`${home}/`)) ? `~${dir.slice(home.length)}` : dir;
};

$('#new-chat').addEventListener('click', newChat);

// Sidebar (ui.js): its own button hides it, a floating one brings it back.
const sidebar = setupSidebar('chatSidebarCollapsed');
const setDrawer = sidebar.setDrawer;
function toggleSidebar() {
  const stick = atBottom; // the reflow would leave the thread mid-way
  sidebar.toggle();
  if (stick && !narrow()) {
    requestAnimationFrame(scrollToBottom);
    setTimeout(scrollToBottom, 300); // after the slide (see base.css)
  }
}
$('#close-sidebar').addEventListener('click', toggleSidebar);
$('#open-sidebar').addEventListener('click', toggleSidebar);

setInterval(() => {
  renderList();
  renderStats();
}, 60_000);

// ------------------------------------------------------------------ usage

function meter({ label, pct, detail, foot }) {
  const bar = h('span');
  bar.style.width = `${Math.min(100, pct)}%`;
  return h(
    'div',
    { class: `meter ${level(pct)}` },
    h('div', { class: 'meter-head' }, h('span', { textContent: label }), h('b', { textContent: detail ?? `${pct}%` })),
    h('div', { class: 'meter-bar' }, bar),
    foot ? h('div', { class: 'meter-foot', textContent: foot }) : null,
  );
}

function stat({ label, pct, title }) {
  const bar = h('span');
  bar.style.width = `${Math.min(100, pct)}%`;
  return h(
    'button',
    { type: 'button', class: `stat ${level(pct)}`, title, 'data-popover-anchor': '', onclick: (e) => openUsage(e.currentTarget) },
    h('span', { textContent: label }),
    h('span', { class: 'stat-bar' }, bar),
    h('b', { textContent: `${pct}%` }),
  );
}

const contextPct = (ctx) => Math.round((ctx.used / ctx.window) * 100);
const windowPct = (w) => Math.round((w.utilization || 0) * 100);

// Top of the chat: model, this chat's context, the account's usage windows.
function renderStats() {
  const chat = current();
  const ctx = chat?.context;
  const parts = [];
  if (state.agent.models.length) parts.push(modelButton(chat));
  else if (chat?.modelLabel || chat?.model) parts.push(h('span', { class: 'model', textContent: chat.modelLabel || chat.model }));
  if (ctx?.window) parts.push(stat({ label: 'ctx', pct: contextPct(ctx), title: `Context: ${tokens(ctx.used)} / ${tokens(ctx.window)} tokens` }));
  for (const w of state.limits?.windows || []) parts.push(stat({ label: w.label, pct: windowPct(w), title: `${w.label} usage — ${resetsIn(w.resetsAt)}` }));
  $('#chat-stats').replaceChildren(...parts);
  if (!$('#usage-panel').hidden) renderUsagePanel();
  if (!$('#model-panel').hidden) renderModelPanel();
}

// ------------------------------------------------------ model and effort

// Per chat; a new chat uses the ones picked for it (kept per device).
const settingsOf = (chat) => (chat ? { model: null, effort: null, ...chat.settings } : state.newSettings);
const modelOption = (id) => state.agent.models.find((m) => m.id === id);

function modelButton(chat) {
  const { model, effort } = settingsOf(chat);
  // The exact model once a process reported it, else the choice.
  const label = (chat ? chat.modelLabel : modelOption(model)?.label) || 'Default model';
  const showEffort = effort && modelOption(model)?.effort !== false;
  return h(
    'button',
    { type: 'button', class: 'model', title: 'Model and effort', 'data-popover-anchor': '', onclick: (e) => openModelPanel(e.currentTarget) },
    h('span', { class: 'model-name', textContent: label }),
    h('span', { class: 'model-short', textContent: label.split(' · ')[0] }), // phones: no "· 1M"
    showEffort ? h('span', { class: 'effort', textContent: effort }) : null,
  );
}

function renderModelPanel() {
  const chat = current();
  const { model, effort } = settingsOf(chat);
  const noEffort = modelOption(model)?.effort === false;
  const models = [{ id: null, label: 'Default', note: 'account setting' }, ...state.agent.models];
  $('#model-panel').replaceChildren(
    h(
      'section',
      { class: 'pick-group' },
      h('h2', { textContent: 'Model' }),
      ...models.map((m) =>
        h(
          'button',
          { type: 'button', class: `pick${m.id === model ? ' on' : ''}`, onclick: () => changeSettings({ model: m.id }) },
          h('span', { class: 'radio' }),
          h('span', { class: 'pick-label', textContent: m.label }),
          m.note ? h('span', { class: 'pick-note', textContent: m.note }) : null,
        ),
      ),
    ),
    state.agent.efforts.length
      ? h(
          'section',
          { class: 'pick-group' },
          h('h2', { textContent: 'Effort' }),
          h(
            'div',
            { class: 'segmented' },
            ...[null, ...state.agent.efforts].map((e) =>
              h('button', { type: 'button', class: !noEffort && e === effort ? 'on' : '', disabled: noEffort, textContent: e ?? 'default', onclick: () => changeSettings({ effort: e }) }),
            ),
          ),
        )
      : null,
    h('div', { class: 'meter-foot', textContent: chat ? 'Applies from the next message.' : 'For this new chat (and the next ones on this device).' }),
  );
}

function openModelPanel(anchor) {
  const panel = $('#model-panel');
  if (!panel.hidden) return hidePopovers();
  hidePopovers();
  renderModelPanel();
  panel.hidden = false;
  place(panel, anchor);
}

async function changeSettings(changes) {
  const chat = current();
  if (!chat) {
    state.newSettings = { ...state.newSettings, ...changes };
    local.set('newSettings', state.newSettings);
    return renderStats();
  }
  // Show it right away; the server's list confirms it.
  chat.settings = { ...settingsOf(chat), ...changes };
  if ('model' in changes) chat.modelLabel = modelOption(changes.model)?.label || '';
  renderStats();
  await api('PATCH', `/api/chats/${chat.id}`, changes).catch(fail);
}

function renderUsagePanel() {
  const ctx = current()?.context;
  const windows = state.limits?.windows || [];
  const updated = state.limits && ago(state.limits.updated);
  $('#usage-panel').replaceChildren(
    ctx?.window
      ? h(
          'section',
          { class: 'meter-group' },
          h('h2', { textContent: 'This chat' }),
          meter({ label: 'Context', pct: contextPct(ctx), detail: `${contextPct(ctx)}% · ${tokens(ctx.used)} / ${tokens(ctx.window)}` }),
        )
      : null,
    windows.length
      ? h(
          'section',
          { class: 'meter-group' },
          h('h2', { textContent: 'Account limits' }),
          ...windows.map((w) => meter({ label: w.label, pct: windowPct(w), foot: resetsIn(w.resetsAt) })),
          h('div', { class: 'meter-foot', textContent: updated === 'now' ? 'updated just now' : `updated ${updated} ago` }),
        )
      : null,
  );
}

function openUsage(anchor) {
  const panel = $('#usage-panel');
  if (!panel.hidden) return hidePopovers();
  hidePopovers();
  renderUsagePanel();
  panel.hidden = false;
  place(panel, anchor);
}

// ------------------------------------------------------------- shortcuts

// One table drives the key handling and the Shortcuts screen. `match` gets
// the keydown event; `run` returns false when it didn't apply. Entries
// without `match` are handled elsewhere (composer, sidebar) and only listed.
const mod = (e) => (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey) && !e.altKey;
const shiftMod = (e) => e.shiftKey && !e.altKey && (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
const SHORTCUTS = [
  {
    id: 'switch',
    keys: [itemKey(1), '…', itemKey(9)],
    label: 'Open chat 1–9',
    note: 'In sidebar order — hold the modifier to see the numbers. The same keys open terminals 1–9',
    match: (e) => itemNumber(e) > 0,
    run: (e) => {
      const chat = state.chats[itemNumber(e) - 1];
      if (!chat) return false;
      go(chat.id);
    },
  },
  {
    id: 'new',
    keys: [appKey('N')],
    label: 'New chat',
    note: isMac && !standalone ? 'Just ⌘N in the macOS app or an installed app window' : null,
    match: (e) => isAppKey(e, 'N'),
    run: () => newChat(),
  },
  {
    id: 'sidebar',
    keys: [`${MOD}B`],
    label: 'Show / hide the sidebar',
    match: (e) => mod(e) && !e.shiftKey && e.code === 'KeyB',
    run: () => toggleSidebar(),
  },
  {
    id: 'reply',
    keys: [`${MOD}J`],
    label: 'Open the latest reply',
    note: 'The chat in the notice, or the newest unread one',
    match: (e) => mod(e) && !e.shiftKey && e.code === 'KeyJ',
    run: () => openReply(),
  },
  {
    id: 'input',
    keys: [`${MOD}K`],
    label: 'Go to the message box',
    match: (e) => mod(e) && !e.shiftKey && e.code === 'KeyK',
    run: () => focusInput(),
  },
  {
    id: 'terminal',
    keys: [appKey('T')],
    label: 'Open the terminal',
    note: 'The same keys bring you back to the chats',
    match: (e) => isAppKey(e, 'T'),
    run: () => (location.href = '/terminal/'),
  },
  {
    id: 'rename',
    keys: [isMac ? '⇧⌘E' : 'Ctrl+Shift+E'],
    label: 'Rename this chat',
    note: 'Or double-click it in the sidebar',
    match: (e) => shiftMod(e) && e.code === 'KeyE',
    run: () => (current() ? renameWithDialog(current()) : false),
  },
  {
    id: 'pin',
    keys: [isMac ? '⇧⌘P' : 'Ctrl+Shift+P'],
    label: 'Pin / unpin this chat',
    note: 'Or drag it to Pinned in the sidebar, and back down to unpin',
    match: (e) => shiftMod(e) && e.code === 'KeyP',
    run: () => (current() ? togglePin(current()) : false),
  },
  {
    id: 'delete',
    keys: [isMac ? '⇧⌘D' : 'Ctrl+Shift+D'],
    label: 'Delete this chat',
    note: 'Asks first',
    match: (e) => shiftMod(e) && e.code === 'KeyD',
    run: () => (current() ? deleteChat(current()) : false),
  },
  {
    id: 'shortcuts',
    keys: [`${MOD}/`],
    label: 'Open this screen',
    match: (e) => mod(e) && (e.key === '/' || e.code === 'Slash'), // ABNT keyboards put / elsewhere
    run: () => (location.hash = 'shortcuts'),
  },
  { id: 'send', keys: ['Enter'], label: 'Send message', note: 'On a phone, use the send button' },
  { id: 'newline', keys: ['⇧Enter'], label: 'New line in the message' },
  { id: 'stop', keys: ['Esc'], label: 'Stop the agent', note: 'While it is working, with the message box focused' },
  { id: 'recall', keys: ['↑', '↓'], label: 'Suggest a recent message', note: "In an empty message box: this chat's last 5, newest first" },
  { id: 'take', keys: ['Tab'], label: 'Use the suggestion', note: 'Puts it in the box, to edit or send' },
];

document.addEventListener(
  'keydown',
  (e) => {
    const s = SHORTCUTS.find((x) => x.match?.(e));
    if (!s || e.isComposing || s.run(e) === false) return;
    e.preventDefault();
  },
  true,
);

$('#new-chat-hint').textContent = appKey('N');
$('#shortcuts-hint').textContent = `${MOD}/`;
$('#terminal-hint').textContent = appKey('T');
$('#input-key').textContent = `${MOD}K`;

// The Shortcuts screen: what each one does and its keys.
$('#shortcut-list').replaceChildren(
  ...SHORTCUTS.map((s) =>
    h(
      'li',
      {},
      h('span', { class: 'what' }, s.label, s.note ? h('small', { textContent: s.note }) : null),
      h('span', { class: 'keys' }, s.keys.map((k) => (k === '…' || k === 'or' ? h('span', { textContent: k }) : h('kbd', { textContent: k })))),
    ),
  ),
);
$('#open-shortcuts').addEventListener('click', () => (location.hash = 'shortcuts'));
$('#back-to-chat').addEventListener('click', () => go(state.chatId));

// ------------------------------------------------------------- on / off

// Off (lib/power.js): every device gets the "Turned off" screen; only a
// browser on this Mac gets the switches (the server checks again).
let thisMac = false;
let offPoll = null;

function checkPower() {
  return api('GET', '/api/config').then((c) => {
    thisMac = c.thisMac;
    $('#turn-off').hidden = !thisMac;
    if (c.on === false) showOff();
    else if (c.on && state.off) location.reload(); // turned back on (from another tab)
  }, () => {}); // unreachable (asleep, restarting): the socket keeps retrying
}

function showOff() {
  $('#turn-on').hidden = !thisMac;
  $('#off-note').textContent = thisMac ? 'The Mac can sleep again.' : 'Turn it back on from the Mac.';
  document.title = 'Turned off';
  if (state.off) return;
  state.off = true;
  native?.({ op: 'power', on: false });
  clearTimeout(retryTimer);
  ws?.close();
  hidePopovers();
  $('#off-screen').hidden = false;
  offPoll = setInterval(() => !document.hidden && checkPower(), 10_000);
}

$('#turn-off').addEventListener('click', async () => {
  const running = state.chats.filter((c) => c.status === 'running').length;
  const stops = running ? `\n\n${running === 1 ? 'A chat is' : `${running} chats are`} still working and will stop.` : '';
  if (!confirm(`Turn off? Every device gets a "Turned off" screen and the Mac can sleep again, until you turn it back on from this Mac.${stops}`)) return;
  try {
    await api('POST', '/api/turn-off');
  } catch (err) {
    return fail(err);
  }
  showOff();
});

$('#turn-on').addEventListener('click', async () => {
  $('#turn-on').disabled = true;
  try {
    await api('POST', '/api/turn-on');
  } catch (err) {
    $('#turn-on').disabled = false;
    return fail(err);
  }
  clearInterval(offPoll);
  native?.({ op: 'power', on: true });
  location.reload();
});

checkPower();

// ---------------------------------------------------------- turn status

function applyStatus(status, queue) {
  state.status = status;
  state.queue = queue || [];
  if (status === 'running' && !loader) {
    loader = createLoader();
    $('#loader-slot').append(loader.el);
    state.phase = {};
    sayPhase('thinking', 'thinking');
  } else if (status !== 'running' && loader) {
    loader.destroy();
    loader = null;
  }
  renderQueue();
  updateSend();
}

// What the indicator says, in the app's theme. Each moment has a few
// phrasings: one is picked when the moment starts and kept while it lasts
// (an agent starts several blocks in a row), so the label doesn't flicker.
const PHRASES = {
  thinking: ['Plotting a course', 'Scanning the horizon', 'Running the numbers', 'Charting the route'],
  writing: ['Transmitting', 'Sending the dispatch', 'Downlinking'],
  reading: ['Reading telemetry', 'Debriefing', 'Checking the instruments'],
};

function setPhase(phase, label) {
  state.phase = { phase, label };
  loader?.update(state.phase);
}

// moment: a PHRASES key; phase: the indicator's animation (loader.js).
function sayPhase(phase, moment) {
  if (state.phase.moment === moment) return;
  const list = PHRASES[moment];
  state.phase = { phase, label: list[Math.floor(Math.random() * list.length)], moment };
  loader?.update(state.phase);
}

function livePhase(ev) {
  if (ev.t !== 'start') return;
  if (ev.kind === 'thinking') sayPhase('thinking', 'thinking');
  else if (ev.kind === 'text') sayPhase('writing', 'writing');
  else if (ev.kind === 'tool_use') setPhase('tool', `Arming ${ev.name}`);
}

function itemPhase(item) {
  if (item.t === 'block' && item.block.type === 'tool_use') setPhase('tool', `Deploying ${item.block.name}`);
  else if (item.t === 'tool_result') sayPhase('thinking', 'reading');
}

function renderQueue() {
  $('#queue').replaceChildren(
    ...state.queue.map((q) =>
      h(
        'div',
        { class: 'queued', title: q.text },
        h('span', { textContent: q.text || q.attachments.map((a) => a.name).join(', ') }),
        h('button', { type: 'button', textContent: '×', 'aria-label': 'Remove from queue', onclick: () => wsSend({ op: 'unqueue', chatId: state.chatId, id: q.id }) }),
      ),
    ),
  );
}

// ------------------------------------------------------------- scrolling

let atBottom = true;
messages.addEventListener('scroll', () => {
  atBottom = messages.scrollTop + messages.clientHeight >= messages.scrollHeight - 80;
  $('#jump').hidden = atBottom;
  holdAnchor();
  loadOlder();
});
function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
  atBottom = true;
  $('#jump').hidden = true;
}

// Off the bottom, what's in the middle of the screen stays there when the
// thread changes size above it: an older page arriving, its images loading
// (browsers' own scroll anchoring does this in Chrome, not always, and not in
// Safari). Its place in the thread (`at`: its top plus the scroll) only
// changes when something above it does.
let anchor = null; // { el, at }

function holdAnchor() {
  followAnchor(); // first undo what moved the last one, if the observer hasn't yet
  const box = messages.getBoundingClientRect();
  const middle = box.top + box.height / 2;
  const list = $('#thread').querySelectorAll(':scope > .note, .turn-head, .user-msg, .assistant > *');
  // In document order, so top to bottom: the first one starting below the middle.
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].getBoundingClientRect().top >= middle) hi = mid;
    else lo = mid + 1;
  }
  const el = list[lo];
  anchor = el ? { el, at: el.getBoundingClientRect().top + messages.scrollTop } : null;
}

function followAnchor() {
  if (atBottom || !anchor?.el.isConnected) return;
  const moved = anchor.el.getBoundingClientRect().top + messages.scrollTop - anchor.at;
  if (Math.abs(moved) < 1) return;
  anchor.at += moved;
  messages.scrollTop += moved;
}

new ResizeObserver(() => (atBottom ? scrollToBottom() : followAnchor())).observe($('#thread'));
new ResizeObserver(() => atBottom && scrollToBottom()).observe($('#loader-slot'));
$('#jump').addEventListener('click', scrollToBottom);

// History pages (lib/chat.js historyPage): the oldest item shown, whether
// there's more above it, and whether it was asked for.
const pages = { oldest: null, more: false, loading: false };

function setPages(oldest, more) {
  Object.assign(pages, { oldest, more: Boolean(more), loading: false });
  $('#older').hidden = !pages.more;
  followAnchor();
  loadOlder(); // a short page doesn't scroll: fill the screen
}

// Asked for a screen ahead, so it's usually there before the top is.
function loadOlder() {
  if (!pages.more || pages.loading || state.opening || messages.scrollTop > messages.clientHeight) return;
  pages.loading = wsSend({ op: 'older', chatId: state.chatId, before: pages.oldest });
}

// -------------------------------------------------------------- composer

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

function updateSend() {
  const empty = !input.value.trim() && !state.attachments.length;
  const stop = state.status === 'running' && empty;
  const send = $('#send');
  send.classList.toggle('stop', stop);
  send.setAttribute('aria-label', stop ? 'Stop' : 'Send');
  send.disabled = !stop && (empty || state.attachments.some((a) => a.uploading));
}

const draftKey = () => `draft:${state.chatId || 'new'}`;
function restoreDraft() {
  input.value = local.get(draftKey(), '');
  autosize();
  updateSend();
}
function moveDraft(from, to) {
  local.set(`draft:${to}`, local.get(`draft:${from}`, ''));
  local.set(`draft:${from}`, null);
}

input.addEventListener('input', () => {
  if (pick >= 0 && input.value) suggest(-1); // typing dismisses a suggestion
  autosize();
  updateSend();
  local.set(draftKey(), input.value);
});
input.addEventListener('blur', () => suggest(-1));
input.addEventListener('keydown', (e) => {
  const plain = !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.isComposing;
  if (plain && e.key === 'ArrowUp' && !input.value && recent.length) {
    e.preventDefault();
    return suggest(Math.min(pick + 1, recent.length - 1));
  }
  if (pick >= 0) {
    if (e.key === 'ArrowDown') suggest(pick - 1);
    else if (e.key === 'Tab') take();
    else if (e.key === 'Escape') suggest(-1);
    else if (e.key !== 'Enter') return; // anything else: type over it (the input event dismisses it)
    // Enter does nothing here: on an empty box it would stop a running agent.
    return e.preventDefault();
  }
  if (e.key === 'Enter' && !e.isComposing) {
    if (e.shiftKey || touch) return;
    e.preventDefault();
    $('#composer').requestSubmit();
  }
  if (e.key === 'Escape' && state.status === 'running') {
    wsSend({ op: 'interrupt', chatId: state.chatId });
  }
});

// ------------------------------------------------------- recent messages

// ↑ on an empty message box suggests this chat's last messages (newest first,
// up to RECENT, repeats once) as a faded placeholder — the box itself stays
// empty — ↓ goes back, Tab takes it into the box to edit or send.
const RECENT = 5;
const PLACEHOLDER = input.placeholder;
let recent = []; // the open chat's, newest first
let pick = -1; // the one suggested, -1 = none

function remember(items) {
  const before = recent.join('\n');
  for (const item of items) {
    const text = item.t === 'user' && item.text?.trim();
    if (text) recent = [text, ...recent.filter((t) => t !== text)].slice(0, RECENT);
  }
  if (pick >= 0 && recent.join('\n') !== before) suggest(-1); // the list moved under it
}

function forgetRecent() {
  recent = [];
  suggest(-1);
}

function suggest(i) {
  pick = i;
  const on = i >= 0;
  input.placeholder = on ? recent[i] : PLACEHOLDER;
  input.classList.toggle('suggesting', on);
  $('#recall').hidden = !on;
  if (on) $('#recall').textContent = `${i + 1}/${recent.length} · Tab`;
  if (!on) return autosize();
  // Size the box to the suggestion: measure it as a value, then empty it again.
  input.value = recent[i];
  input.style.height = 'auto';
  const height = input.scrollHeight;
  input.value = '';
  input.style.height = `${height}px`;
}

function take() {
  const text = recent[pick];
  suggest(-1);
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new Event('input')); // size, send button, draft
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (state.status === 'running' && !text && !state.attachments.length) {
    wsSend({ op: 'interrupt', chatId: state.chatId });
    return;
  }
  if (!text && !state.attachments.length) return;
  if (state.attachments.some((a) => a.uploading)) return toast('Wait for the attachments to upload');
  const ref = randomId();
  const attachments = state.attachments.map((a) => ({ file: a.file, name: a.name }));
  // A new chat starts with these.
  const settings = state.chatId ? undefined : state.newSettings;
  const dir = state.chatId ? undefined : state.newDir || undefined;
  if (!wsSend({ op: 'send', ref, chatId: state.chatId, text, attachments, settings, dir })) return toast('Not connected to the server', true);
  state.sends.set(ref, { text, attachments: state.attachments });
  input.value = '';
  local.set(draftKey(), null);
  state.attachments = [];
  renderAttachments();
  autosize();
  updateSend();
  $('#welcome').hidden = true;
  scrollToBottom();
});

// ----------------------------------------------------------- attachments

const MAX_EDGE = 1568; // larger images get downscaled by the model APIs anyway

// Phone photos are big: resize before uploading (and turn HEIC into JPEG).
async function prepareImage(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type)) return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const convert = /heic|heif/.test(file.type);
  if (scale === 1 && !convert && file.size < 3 * 1024 * 1024) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.88));
  if (!blob) return file;
  const name = `${(file.name || 'image').replace(/\.\w+$/, '')}.${type === 'image/png' ? 'png' : 'jpg'}`;
  return new File([blob], name, { type });
}

async function addFiles(files) {
  for (const original of files) {
    const att = {
      id: randomId(),
      name: original.name || 'image',
      mediaType: original.type,
      preview: original.type.startsWith('image/') ? URL.createObjectURL(original) : null,
      uploading: true,
    };
    state.attachments.push(att);
    renderAttachments();
    updateSend();
    try {
      const file = await prepareImage(original);
      const res = await api('POST', `/api/uploads?name=${encodeURIComponent(file.name || att.name)}`, file, file.type || 'application/octet-stream');
      Object.assign(att, { file: res.file, name: res.name, url: res.url, mediaType: res.mediaType, uploading: false });
    } catch (err) {
      state.attachments = state.attachments.filter((a) => a !== att);
      fail(err);
    }
    renderAttachments();
    updateSend();
  }
}

function renderAttachments() {
  $('#attachments').replaceChildren(
    ...state.attachments.map((a) => {
      // An image opens full size before it's sent: anywhere on the chip but ×.
      const preview = a.preview ? () => showImage(a.preview, a.url) : null;
      return h(
        'div',
        {
          class: `chip${a.uploading ? ' uploading' : ''}${preview ? ' previewable' : ''}`,
          title: preview ? `${a.name} — click to preview` : a.name,
          ...(preview && {
            role: 'button',
            tabindex: '0',
            onclick: preview,
            onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), preview()),
          }),
        },
        a.preview ? h('img', { src: a.preview, alt: '' }) : null,
        h('span', { class: 'name', textContent: a.uploading ? 'uploading…' : a.name }),
        h('button', {
          type: 'button',
          class: 'chip-x',
          textContent: '×',
          'aria-label': 'Remove attachment',
          onclick: (e) => {
            e.stopPropagation(); // not a preview
            state.attachments = state.attachments.filter((x) => x !== a);
            renderAttachments();
            updateSend();
          },
        }),
      );
    }),
  );
}

$('#attach').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
});
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});
$('#main').addEventListener('dragover', (e) => e.preventDefault());
$('#main').addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files.length) addFiles([...e.dataTransfer.files]);
});

// --------------------------------------------------------------- lightbox

const lightbox = $('#lightbox');

// original: what "open original" links to. An attachment not sent yet shows
// its local copy (blob:) and links to the uploaded one, once it's there.
function showImage(src, original = src.startsWith('blob:') ? '' : src) {
  lightbox.querySelector('img').src = src;
  $('#lightbox-open').href = original || '';
  $('#lightbox-open').hidden = !original;
  lightbox.hidden = false;
}

document.addEventListener('click', (e) => {
  const img = e.target.closest('img.zoomable');
  if (img) showImage(img.src);
});
lightbox.addEventListener('click', (e) => {
  if (!e.target.closest('a')) lightbox.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    lightbox.hidden = true;
    hidePopovers();
  }
});

// ------------------------------------------------------------------- boot

// /?dir=<folder> (the terminal page's "New chat in this folder"): a new chat
// that starts there. Otherwise, opening the app without a link resumes the last chat.
const startDir = new URLSearchParams(location.search).get('dir');
if (startDir) {
  state.newDir = startDir;
  history.replaceState(null, '', '/');
} else if (route().view === 'chat' && !hashId() && local.get('last', null)) history.replaceState(null, '', `#${local.get('last')}`);
state.chatId = route().view === 'chat' ? hashId() : local.get('last', null);
$('#welcome').hidden = Boolean(state.chatId);
restoreDraft();
setView(route().view);
connect();
