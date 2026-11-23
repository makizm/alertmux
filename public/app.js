// Shared helpers for the admin UI. Plain ES module, no dependencies.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Create an element. Strings/numbers become text nodes (never HTML), so data is always escaped. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replace an element's children; accepts nested arrays and skips null/false. */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    .map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))));
  return el;
}

// ---- API ----
let csrf = null;
async function csrfToken() {
  if (!csrf) {
    const res = await fetch('/api/session');
    if (res.status === 401) { location.href = '/login'; throw new Error('Not signed in'); }
    csrf = (await res.json()).csrf;
  }
  return csrf;
}

export class ApiError extends Error {
  constructor(message, details) { super(message); this.details = details; }
}

export async function api(method, path, body) {
  const headers = { accept: 'application/json' };
  if (method !== 'GET') headers['x-csrf-token'] = await csrfToken();
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401) { location.href = '/login'; throw new ApiError('Not signed in'); }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, data.details);
  return data;
}

// ---- formatting ----
export const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' }) : '—');
export function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
export function ago(ms) {
  if (!ms) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export const badge = (status) => h('span', { class: `badge ${status}` }, status);

// ---- toasts & errors ----
export function toast(msg, kind = '') {
  let box = $('#toasts');
  if (!box) { box = h('div', { id: 'toasts', role: 'status' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}` }, msg);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3500);
}

/** Show an API error inside `container` (a .callout), including field-level details. */
export function showError(container, err) {
  fill(container, h('strong', {}, err.message), Array.isArray(err.details) && err.details.length ? h('ul', { class: 'errors' }, err.details.map((d) => h('li', {}, d))) : null);
  container.className = 'callout err';
  container.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---- forms: inputs named with dotted paths ("smtp.port") map to nested objects ----
// data-type="number" | "list" (newline/comma separated) | "bool" (checkbox)
export function readForm(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    const type = el.dataset.type ?? (el.type === 'checkbox' ? 'bool' : el.type === 'number' ? 'number' : 'string');
    if (el.type === 'radio' && !el.checked) continue;
    let v = el.value;
    if (type === 'bool') v = el.checked;
    else if (type === 'number') v = v === '' ? null : Number(v);
    else if (type === 'list') v = v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
    const keys = el.name.split('.');
    let o = out;
    keys.slice(0, -1).forEach((k) => (o = o[k] ??= {}));
    o[keys.at(-1)] = v;
  }
  return out;
}

export function fillForm(form, data) {
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = el.name.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
    if (v === undefined) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'radio') el.checked = el.value === String(v);
    else if (Array.isArray(v)) el.value = v.join('\n');
    else el.value = v ?? '';
  }
}

// ---- live updates (SSE) ----
let source = null;
const handlers = { message: new Set(), event: new Set(), status: new Set(), open: new Set(), error: new Set() };
let lastEventId = 0;
let hideTimer = null;

// Each open stream holds one of the browser's ~6 connections per host (HTTP/1.1). To keep pages fast with
// several tabs open, a stream is opened only on pages that show live data ('message'/'event' subscribers),
// and closed while the tab is in the background.
const wantsStream = () => handlers.message.size > 0 || handlers.event.size > 0;

/**
 * Subscribe to live updates. 'message' and 'event' open the stream; 'status', 'open' and 'error' only
 * listen to a stream another subscriber opened. Returns an unsubscribe function.
 */
export function live(type, fn) {
  handlers[type].add(fn);
  sync();
  return () => { handlers[type].delete(fn); sync(); };
}

function sync() {
  const want = wantsStream() && document.visibilityState === 'visible';
  if (want && !source) connect();
  if (!want && source) disconnect();
  setLiveDot(source ? 'connecting' : 'off');
}

document.addEventListener('visibilitychange', () => {
  clearTimeout(hideTimer);
  // Short grace period so quickly switching tabs doesn't churn connections.
  if (document.visibilityState === 'hidden') hideTimer = setTimeout(sync, 15_000);
  else sync();
});

function connect() {
  source = new EventSource(lastEventId ? `/api/stream?lastEventId=${lastEventId}` : '/api/stream');
  for (const type of ['message', 'event', 'status']) {
    source.addEventListener(type, (e) => {
      if (e.lastEventId) lastEventId = Number(e.lastEventId) || lastEventId;
      const data = JSON.parse(e.data);
      for (const fn of handlers[type]) fn(data);
    });
  }
  source.addEventListener('open', () => { setLiveDot('on'); handlers.open.forEach((fn) => fn()); });
  source.addEventListener('error', () => { setLiveDot('connecting'); handlers.error.forEach((fn) => fn()); });
}

function disconnect() {
  source.close();
  source = null;
}

function setLiveDot(state) {
  const row = $('#live-row');
  if (!row) return;
  row.classList.toggle('hidden', state === 'off' && !wantsStream());
  const dot = $('#live-dot');
  dot.className = state === 'on' ? 'dot live' : state === 'off' ? 'dot' : 'dot err';
  dot.title = { on: 'Live updates connected', off: 'Paused while this tab is in the background', connecting: 'Live updates reconnecting…' }[state];
}

// ---- layout ----
const NAV = [
  ['/', 'Dashboard'],
  ['/messages', 'Messages'],
  ['/events', 'Events'],
  ['/destinations', 'Destinations & routing'],
  ['/settings', 'Settings'],
  ['/users', 'Relay users'],
  ['/test', 'Test send'],
];

function renderListener(s) {
  const el = $('#listener-status');
  if (!el) return;
  fill(el,
    h('span', { class: `dot ${s.running ? 'ok' : 'err'}` }),
    s.running ? `SMTP listening on :${s.port}` : `SMTP stopped${s.error ? ': ' + s.error : ''}`,
  );
}

export function layout() {
  const path = location.pathname.replace(/\.html$/, '').replace(/\/index$/, '/') || '/';
  const nav = h('nav', { class: 'side', 'aria-label': 'Main' },
    h('div', { class: 'brand' }, h('img', { src: '/logo.svg', alt: '', width: 28, height: 28 }), 'Alertmux'),
    NAV.map(([href, label]) => h('a', { href, class: path === href ? 'active' : '' }, label)),
    h('div', { class: 'foot' },
      h('div', { id: 'listener-status' }, '…'),
      h('div', { id: 'live-row', class: 'hidden' }, h('span', { id: 'live-dot', class: 'dot' }), 'Live updates'),
      h('button', { class: 'small', onclick: async () => { await api('POST', '/api/logout'); location.href = '/login'; } }, 'Sign out'),
    ),
  );
  document.body.prepend(nav);
  api('GET', '/api/status').then((s) => renderListener(s.listener)).catch(() => {});
  // Passive: updates the sidebar only on pages that already have a stream open.
  live('status', renderListener);
  setLiveDot(source ? 'connecting' : 'off');
}
