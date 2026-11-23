import { $, fill, api, badge, fmtSize, fmtTime, h, layout, live, toast } from './app.js';

layout();

const rows = $('#rows');
const filters = $('#filters');
const older = $('#older');
const liveBox = $('#live');
const pauseBtn = $('#pause');
const pendingBadge = $('#pending');
const dialog = $('#detail');
const PAGE = 50;

let paused = false;
/** Updates received while paused, keyed by message id (latest wins). */
const pending = new Map();
let openId = null;

function filterValues() {
  return Object.fromEntries(new FormData(filters).entries());
}

/** Does a message (from the live stream) belong in the current filtered view? */
function matchesFilters(m) {
  const f = filterValues();
  if (f.status && m.status !== f.status) return false;
  if (f.from && m.createdAt < Date.parse(f.from + 'T00:00:00')) return false;
  if (f.to && m.createdAt > Date.parse(f.to + 'T23:59:59.999')) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = [m.id, m.mailFrom, m.rcptTo.join(' '), m.subject, m.clientIp, m.messageId].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function row(m) {
  const to = m.rcptTo.join(', ');
  return h('tr', { class: 'click', dataset: { id: m.id }, tabindex: '0', onclick: () => openDetail(m.id), onkeydown: (e) => e.key === 'Enter' && openDetail(m.id) },
    h('td', { class: 'nowrap' }, fmtTime(m.createdAt)),
    h('td', {}, badge(m.status)),
    h('td', { class: 'trunc', title: m.mailFrom }, m.mailFrom || '<>'),
    h('td', { class: 'trunc', title: to }, to),
    h('td', { class: 'trunc', title: m.lastError || m.subject }, m.subject || h('span', { class: 'muted' }, '(no subject)')),
    h('td', { class: 'nowrap' }, fmtSize(m.size)),
    h('td', { class: 'nowrap mono' }, m.clientIp),
    h('td', {}, String(m.attempts)),
  );
}

async function load({ append = false } = {}) {
  const params = new URLSearchParams({ ...filterValues(), limit: String(PAGE) });
  for (const [k, v] of [...params]) if (!v) params.delete(k);
  if (append) {
    const last = rows.lastElementChild;
    if (last) params.set('before', last.dataset.id);
  }
  const list = await api('GET', '/api/messages?' + params);
  if (!append) fill(rows);
  rows.append(...list.map(row));
  older.classList.toggle('hidden', list.length < PAGE);
  $('#empty').classList.toggle('hidden', rows.children.length > 0);
}

/** Insert or patch one message row in place. */
function upsert(m) {
  const existing = rows.querySelector(`tr[data-id="${CSS.escape(m.id)}"]`);
  if (!matchesFilters(m)) { existing?.remove(); return; }
  const tr = row(m);
  tr.classList.add('flash');
  if (existing) existing.replaceWith(tr);
  else {
    // Only new messages go on top; ids are time-ordered.
    const first = rows.firstElementChild;
    if (!first || m.id > first.dataset.id) rows.prepend(tr);
    else return;
  }
  $('#empty').classList.add('hidden');
  if (openId === m.id) openDetail(m.id, true);
}

live('message', (m) => {
  if (!liveBox.checked) return;
  if (paused) {
    pending.set(m.id, m);
    pendingBadge.textContent = `${pending.size} new`;
    pendingBadge.classList.remove('hidden');
    return;
  }
  upsert(m);
});
// After a reconnect, reload so updates missed while disconnected show up.
let firstOpen = true;
live('open', () => { if (!firstOpen && liveBox.checked) load(); firstOpen = false; });

pauseBtn.addEventListener('click', () => {
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  if (!paused) {
    [...pending.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).forEach(upsert);
    pending.clear();
    pendingBadge.classList.add('hidden');
  }
});

let debounce;
filters.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(load, 250); });
filters.addEventListener('reset', () => setTimeout(load));
filters.addEventListener('submit', (e) => { e.preventDefault(); load(); });
older.addEventListener('click', () => load({ append: true }));

// ---- detail dialog ----
async function openDetail(id, refresh = false) {
  openId = id;
  const d = await api('GET', `/api/messages/${encodeURIComponent(id)}`);
  const m = d.message;
  $('#detail-title').textContent = m.subject || '(no subject)';
  $('#download').href = `/api/messages/${encodeURIComponent(id)}/raw`;
  $('#download').classList.toggle('hidden', !d.bodyStored);
  $('#retry').disabled = !d.bodyStored || !['failed', 'partial', 'retrying'].includes(m.status);
  const headerText = d.headers ? d.headers.map((x) => `${x.name}: ${x.value}`).join('\n') : null;

  fill($('#detail-body'), 
    h('dl', { class: 'kv' },
      h('dt', {}, 'Status'), h('dd', {}, badge(m.status)),
      h('dt', {}, 'ID'), h('dd', { class: 'mono' }, m.id),
      h('dt', {}, 'Received'), h('dd', {}, fmtTime(m.createdAt)),
      h('dt', {}, 'Client'), h('dd', {}, `${m.clientIp} (HELO ${m.helo || '—'})${m.authUser ? `, AUTH as ${m.authUser}` : ''}`),
      h('dt', {}, 'MAIL FROM'), h('dd', {}, m.mailFrom || '<>'),
      h('dt', {}, 'Sent as'), h('dd', {}, m.sendAs || '—'),
      h('dt', {}, 'RCPT TO'), h('dd', {}, m.rcptTo.join(', ')),
      h('dt', {}, 'From header'), h('dd', {}, m.headerFrom || '—'),
      h('dt', {}, 'Message-ID'), h('dd', { class: 'mono' }, m.messageId || '—'),
      h('dt', {}, 'Size'), h('dd', {}, fmtSize(m.size)),
      m.lastError ? [h('dt', {}, 'Last error'), h('dd', {}, m.lastError)] : null,
    ),
    d.deliveries.length ? [
      h('h3', {}, 'Destinations'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Destination'), h('th', {}, 'Status'), h('th', {}, 'Tries'), h('th', {}, 'Next try'), h('th', {}, 'Upstream ID'))),
        h('tbody', {}, d.deliveries.map((x) => h('tr', {},
          h('td', {}, x.destinationName), h('td', {}, badge(x.status)), h('td', {}, String(x.attempts)),
          h('td', {}, x.status === 'retrying' ? fmtTime(x.nextAttemptAt) : '—'), h('td', { class: 'mono' }, x.upstreamId || '—'))),
        ))),
    ] : null,
    d.attempts.length ? [
      h('h3', {}, 'Attempts'),
      h('ol', { class: 'timeline' }, d.attempts.map((a) => h('li', { class: a.ok ? 'ok' : 'bad' },
        h('div', {}, h('strong', {}, `${fmtTime(a.at)} · ${a.destinationName} · ${a.code}`), h('span', { class: 'muted' }, ` (${a.durationMs} ms)`)),
        h('div', { class: a.ok ? 'muted' : '' }, a.detail)))),
    ] : null,
    h('h3', {}, 'Headers'),
    headerText ? h('pre', { class: 'headers' }, headerText) : h('p', { class: 'muted' }, 'The message body is not stored (rejected, or deleted after successful delivery).'),
  );
  if (!refresh && !dialog.open) dialog.showModal();
}

$('#close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { openId = null; });
$('#retry').addEventListener('click', async () => {
  try {
    await api('POST', `/api/messages/${encodeURIComponent(openId)}/retry`);
    toast('Queued for retry');
    openDetail(openId, true);
  } catch (e) { toast(e.message, 'err'); }
});
$('#delete').addEventListener('click', async () => {
  if (!confirm('Delete this message and its log entries? This cannot be undone.')) return;
  try {
    const id = openId;
    await api('DELETE', `/api/messages/${encodeURIComponent(id)}`);
    rows.querySelector(`tr[data-id="${CSS.escape(id)}"]`)?.remove();
    dialog.close();
    toast('Message deleted');
  } catch (e) { toast(e.message, 'err'); }
});

// Deep links: /messages?status=failed pre-filters, /messages?id=<id> opens that message.
const qs = new URLSearchParams(location.search);
for (const k of ['status', 'q', 'from', 'to']) if (qs.get(k)) filters.elements[k].value = qs.get(k);
const deep = qs.get('id');
load().then(() => deep && openDetail(deep));
