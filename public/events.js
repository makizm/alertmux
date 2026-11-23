import { $, fill, api, badge, fmtTime, h, layout, live } from './app.js';

layout();

const rows = $('#rows');
const filters = $('#filters');
const older = $('#older');
const PAGE = 100;

function row(e) {
  const id = e.data && typeof e.data === 'object' && e.data.id;
  return h('tr', { dataset: { id: String(e.id) } },
    h('td', { class: 'nowrap' }, fmtTime(e.at)),
    h('td', {}, badge(e.level)),
    h('td', { class: 'mono nowrap' }, e.type),
    h('td', {}, e.message, typeof id === 'string' && /^(message|delivery)\./.test(e.type) ? [' ', h('a', { href: `/messages?id=${encodeURIComponent(id)}` }, 'view')] : null),
  );
}

function matches(e) {
  const f = Object.fromEntries(new FormData(filters));
  if (f.level && e.level !== f.level) return false;
  if (f.q && !`${e.message} ${e.type}`.toLowerCase().includes(f.q.toLowerCase())) return false;
  return true;
}

async function load(append = false) {
  const p = new URLSearchParams({ ...Object.fromEntries(new FormData(filters)), limit: String(PAGE) });
  for (const [k, v] of [...p]) if (!v) p.delete(k);
  if (append && rows.lastElementChild) p.set('before', rows.lastElementChild.dataset.id);
  const list = await api('GET', '/api/events?' + p);
  if (!append) fill(rows);
  rows.append(...list.map(row));
  older.classList.toggle('hidden', list.length < PAGE);
  $('#empty').classList.toggle('hidden', rows.children.length > 0);
}

live('event', (e) => {
  if (!$('#live').checked || !matches(e)) return;
  if (rows.querySelector(`tr[data-id="${e.id}"]`)) return; // replayed after reconnect
  const tr = row(e);
  tr.classList.add('flash');
  rows.prepend(tr);
  $('#empty').classList.add('hidden');
});

let t;
filters.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
filters.addEventListener('reset', () => setTimeout(load));
filters.addEventListener('submit', (e) => { e.preventDefault(); load(); });
older.addEventListener('click', () => load(true));
load();
