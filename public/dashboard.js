import { $, fill, ago, api, badge, fmtTime, h, layout, live } from './app.js';

layout();

const STATS = [
  ['sent', 'Sent'], ['queued', 'Queued'], ['retrying', 'Retrying'], ['failed', 'Failed'], ['rejected', 'Rejected'],
];

function statCards(counts) {
  return STATS.map(([k, label]) => h('a', { class: 'card stat', href: `/messages?status=${k}` },
    h('div', { class: 'n' }, String(counts[k] ?? 0)), h('div', { class: 'l' }, label)));
}

async function refresh() {
  const s = await api('GET', '/api/status');
  fill($('#stats24'), ...statCards(s.stats.last24h));
  fill($('#stats7'), ...statCards(s.stats.last7d));
  $('#setup').classList.toggle('hidden', s.destinations.some((d) => d.enabled));

  const l = s.listener;
  fill($('#listener'), h('dl', { class: 'kv' },
    h('dt', {}, 'State'), h('dd', {}, h('span', { class: `dot ${l.running ? 'ok' : 'err'}` }), l.running ? 'Running' : 'Stopped'),
    h('dt', {}, 'Port'), h('dd', {}, l.port ?? '—'),
    h('dt', {}, 'Since'), h('dd', {}, fmtTime(l.since)),
    h('dt', {}, 'Connections'), h('dd', {}, String(l.connections)),
    h('dt', {}, 'Queue'), h('dd', {}, `${s.queue.pending} pending deliveries`),
    l.error ? [h('dt', {}, 'Error'), h('dd', { class: 'callout err' }, l.error)] : null,
  ));

  fill($('#dests'), s.destinations.length
    ? h('ul', { class: 'plain' }, s.destinations.map((d) => h('li', {},
      h('span', { class: `dot ${!d.last ? '' : d.last.ok ? 'ok' : 'err'}` }),
      h('a', { href: '/destinations' }, d.name), d.enabled ? '' : ' (disabled)',
      h('div', { class: 'muted' }, d.last ? `Last attempt ${ago(d.last.at)}: ${d.last.ok ? 'OK' : `${d.last.code} ${d.last.detail}`}` : 'No deliveries yet'))))
    : h('p', { class: 'muted' }, 'None configured.'));

  const problems = await api('GET', '/api/events?level=error&limit=8');
  const warns = await api('GET', '/api/events?level=warn&limit=8');
  const list = [...problems, ...warns].sort((a, b) => b.id - a.id).slice(0, 8);
  fill($('#problems'), list.length
    ? h('ul', { class: 'plain' }, list.map((e) => h('li', {}, badge(e.level), ' ', h('span', { class: 'muted' }, fmtTime(e.at)), ' ', e.message)))
    : h('p', { class: 'muted' }, 'Nothing to report.'));
}

let pending;
const soon = () => { clearTimeout(pending); pending = setTimeout(refresh, 500); };
live('message', soon);
live('status', soon);
live('event', (e) => e.level !== 'info' && soon());
refresh();
