import { $, fill, api, badge, h, layout, live, readForm, showError } from './app.js';

layout();

const result = $('#result');
let watching = null;

function show(m) {
  result.className = 'callout';
  fill(result, 
    h('div', {}, 'Message ', h('a', { href: `/messages?id=${encodeURIComponent(m.id)}` }, m.id), ': ', badge(m.status)),
    m.lastError ? h('div', {}, m.lastError) : null,
  );
}

live('message', (m) => { if (m.id === watching) show(m); });

$('#send').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('POST', '/api/test-send', readForm(e.target));
    watching = r.id;
    if (!r.ok) {
      result.className = 'callout err';
      fill(result, h('div', {}, `Rejected (${r.code}): ${r.message}`), r.id ? h('a', { href: `/messages?id=${encodeURIComponent(r.id)}` }, 'View in log') : null);
      return;
    }
    show(await api('GET', `/api/messages/${encodeURIComponent(r.id)}`).then((d) => d.message));
  } catch (err) {
    showError(result, err);
  }
});
