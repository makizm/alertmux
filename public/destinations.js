import { $, fill, $$, ago, api, fillForm, h, layout, readForm, showError, toast } from './app.js';

layout();

// Start every request at once; the page renders when they're all back.
const fetchLists = () => Promise.all([api('GET', '/api/destinations'), api('GET', '/api/routes'), api('GET', '/api/status')]);
const firstLists = fetchLists();
const meta = await api('GET', '/api/meta');
let destinations = [];
let editing = null; // destination being edited, or null for new
let testingId = null;

const editDialog = $('#edit');
const form = $('#dest-form');
const testDialog = $('#test');

// Remember each secret field's own placeholder: editing a destination swaps in "stored", and a new
// destination form must not inherit that.
for (const el of $$('[data-secret]', form)) el.dataset.placeholder = el.placeholder;
for (const [value, label] of Object.entries(meta.slackApiBases)) form.elements['config.apiBaseUrl'].append(h('option', { value }, label));
for (const [value, c] of Object.entries(meta.microsoftClouds)) form.elements['config.cloud'].append(h('option', { value }, c.label));

// ---- conditional fields: data-when="field=value field2=value2" ----
function fieldValue(name) {
  const el = form.elements[name];
  if (!el) return '';
  if (el instanceof RadioNodeList) return el.value;
  return el.value;
}
function applyWhen() {
  for (const box of $$('[data-when]', form)) {
    // "a=x b=y|z": every condition must hold; "|" lists alternative values.
    const show = box.dataset.when.split(' ').every((cond) => { const [k, v] = cond.split('='); return v.split('|').includes(fieldValue(k)); });
    box.classList.toggle('hidden', !show);
  }
  // Disable inputs in hidden sections so they are not submitted.
  for (const el of form.elements) {
    if (!el.name) continue;
    el.disabled = !!el.closest('[data-when].hidden');
  }
  const cloud = meta.microsoftClouds[fieldValue('config.cloud')];
  $('#cloud-endpoints').textContent = cloud && cloud.authority ? `Sign-in: ${cloud.authority} · Graph: ${cloud.graph}` : '';
}
form.addEventListener('change', (e) => {
  if (e.target.name === 'config.mode') {
    // Switching Google mode: suggest that mode's default host.
    const d = meta.googleDefaults[e.target.value];
    form.elements['config.host'].value = d.host;
    form.elements['config.port'].value = d.port;
  }
  applyWhen();
});

function openEditor(dest, kind) {
  editing = dest;
  form.reset();
  $('#dest-error').className = 'hidden';
  const DEFAULTS = {
    'microsoft-graph': { name: 'Microsoft 365', config: { cloud: 'global', authMethod: 'secret', tenantId: '', clientId: '' } },
    'google-smtp': { name: 'Google Workspace', config: { mode: 'relay', host: 'smtp-relay.gmail.com', port: 587, security: 'starttls', relayAuth: 'password', username: '', ehloName: '' } },
    'teams-webhook': { name: 'Teams alerts channel', config: { includeBody: true, maxBodyChars: 4000 } },
    slack: { name: 'Slack alerts channel', config: { method: 'webhook', channel: '', apiBaseUrl: 'https://slack.com/api', includeBody: true, maxBodyChars: 4000 } },
  };
  const d = DEFAULTS[kind] ?? { name: meta.destinationKinds[kind], config: {} };
  fillForm(form, dest ?? { kind, enabled: true, ...d });
  for (const el of $$('[data-secret]', form)) {
    const key = el.name.split('.')[1];
    const set = dest?.secretsSet?.[key];
    el.value = '';
    el.placeholder = set ? '•••••••• stored — leave blank to keep' : el.dataset.placeholder;
  }
  $('#edit-title').textContent = dest ? `Edit ${dest.name}` : `New ${meta.destinationKinds[kind]} destination`;
  applyWhen();
  editDialog.showModal();
}

$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
// "Add destination" menu: one entry per provider the server supports, so new kinds show up automatically.
const addMenu = $('#add-menu');
const GROUPS = { mail: 'Email', chat: 'Chat channel' };
fill($('#add-list'), Object.entries(GROUPS).map(([cat, title]) => {
  const kinds = Object.entries(meta.destinationKinds).filter(([k]) => meta.destinationCategories[k] === cat);
  return kinds.length ? [
    h('div', { class: 'menu-group', role: 'presentation' }, title),
    kinds.map(([kind, label]) => h('button', { type: 'button', role: 'menuitem', onclick: () => { addMenu.open = false; openEditor(null, kind); } }, label)),
  ] : null;
}));
document.addEventListener('click', (e) => { if (!addMenu.contains(e.target)) addMenu.open = false; });
addMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { addMenu.open = false; addMenu.querySelector('summary').focus(); } });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = readForm(form);
  // Empty secret fields mean "keep the stored value", so drop them.
  for (const k of Object.keys(data.secrets ?? {})) if (!data.secrets[k]) delete data.secrets[k];
  try {
    const saved = editing
      ? await api('PUT', `/api/destinations/${editing.id}`, data)
      : await api('POST', '/api/destinations', data);
    editDialog.close();
    toast(`Saved ${saved.name}`);
    await loadAll();
  } catch (err) {
    showError($('#dest-error'), err);
  }
});

function describe(d) {
  const c = d.config;
  if (d.kind === 'microsoft-graph') return `${meta.microsoftClouds[c.cloud]?.label ?? c.cloud} · tenant ${c.tenantId} · ${c.authMethod}`;
  const body = c.includeBody ? `body up to ${c.maxBodyChars} chars` : 'no body';
  if (d.kind === 'teams-webhook') return `Workflows webhook · ${body}`;
  if (d.kind === 'slack') return `${c.method === 'bot' ? `Bot → ${c.channel}${c.apiBaseUrl.includes('slack-gov') ? ' (GovSlack)' : ''}` : 'Incoming webhook'} · ${body}`;
  return c.mode === 'xoauth2' ? `XOAUTH2 via ${c.host}:${c.port}` : `Relay ${c.host}:${c.port} · ${c.relayAuth === 'ip' ? 'IP allowlist' : `AUTH as ${c.username}`}`;
}

function renderDestinations(status) {
  const last = Object.fromEntries(status.destinations.map((d) => [d.id, d.last]));
  fill($('#dest-rows'), ...destinations.map((d) => {
    const l = last[d.id];
    return h('tr', {},
      h('td', {}, h('strong', {}, d.name), d.enabled ? '' : h('span', { class: 'badge' }, 'disabled')),
      h('td', {}, meta.destinationKinds[d.kind]),
      h('td', { class: 'muted' }, describe(d)),
      h('td', {}, l ? [h('span', { class: `dot ${l.ok ? 'ok' : 'err'}` }), `${l.ok ? 'OK' : l.code} ${ago(l.at)}`] : h('span', { class: 'muted' }, 'no deliveries yet')),
      h('td', { class: 'nowrap' },
        h('button', { class: 'small', onclick: () => openEditor(d, d.kind) }, 'Edit'), ' ',
        h('button', { class: 'small', onclick: () => openTest(d) }, 'Test'), ' ',
        h('button', { class: 'small danger', onclick: () => remove(d) }, 'Delete')),
    );
  }));
  $('#dest-empty').classList.toggle('hidden', destinations.length > 0);
}

async function remove(d) {
  if (!confirm(`Delete destination "${d.name}"? Routing rules that point to it lose it. Queued messages for it will fail.`)) return;
  try {
    await api('DELETE', `/api/destinations/${d.id}`);
    toast(`Deleted ${d.name}`);
    await loadAll();
  } catch (e) { toast(e.message, 'err'); }
}

function openTest(d) {
  testingId = d.id;
  $('#test-title').textContent = `Test ${d.name}`;
  $('#test-result').className = 'hidden';
  const chat = meta.destinationCategories[d.kind] === 'chat';
  $('#test-addr-box').classList.toggle('hidden', chat);
  $('#test-chat-note').classList.toggle('hidden', !chat);
  testDialog.showModal();
}
$('#test-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const box = $('#test-result');
  box.className = 'callout';
  box.textContent = 'Testing…';
  try {
    const r = await api('POST', `/api/destinations/${testingId}/test`, { address: e.target.address.value });
    box.className = r.ok ? 'callout' : 'callout err';
    box.textContent = (r.ok ? '✓ ' : '✗ ') + r.detail;
  } catch (err) { showError(box, err); }
});

// ---- routing ----
const rulesBox = $('#rules');

function ruleEditor(rule = { name: '', enabled: true, stop: false, destinationIds: [], match: { senders: [], senderDomains: [], recipientDomains: [] } }) {
  const el = h('div', { class: 'rule' },
    h('div', { class: 'row' },
      h('input', { type: 'text', name: 'name', value: rule.name, placeholder: 'Rule name', 'aria-label': 'Rule name' }),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'enabled', checked: rule.enabled }), 'Enabled'),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'stop', checked: rule.stop }), 'Stop here'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'small', title: 'Move up', onclick: () => el.previousElementSibling?.before(el) }, '↑'),
      h('button', { type: 'button', class: 'small', title: 'Move down', onclick: () => el.nextElementSibling?.after(el) }, '↓'),
      h('button', { type: 'button', class: 'small danger', onclick: () => el.remove() }, 'Remove')),
    h('div', { class: 'cols' },
      h('div', {}, h('label', {}, 'Sender domains'), h('input', { type: 'text', name: 'senderDomains', value: rule.match.senderDomains.join(', '), placeholder: 'example.com, other.org' })),
      h('div', {}, h('label', {}, 'Senders'), h('input', { type: 'text', name: 'senders', value: rule.match.senders.join(', '), placeholder: 'scanner@example.com' })),
      h('div', {}, h('label', {}, 'Recipient domains'), h('input', { type: 'text', name: 'recipientDomains', value: rule.match.recipientDomains.join(', '), placeholder: 'any recipient in…' }))),
    h('label', {}, 'Deliver to'),
    h('div', { class: 'checks' }, destinations.map((d) => h('label', { class: 'inline' },
      h('input', { type: 'checkbox', name: 'dest', value: d.id, checked: rule.destinationIds.includes(d.id) }), d.name))),
  );
  return el;
}

function readRules() {
  const list = (v) => v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  return $$('.rule', rulesBox).map((el) => {
    const q = (n) => el.querySelector(`[name="${n}"]`);
    return {
      name: q('name').value, enabled: q('enabled').checked, stop: q('stop').checked,
      destinationIds: $$('[name="dest"]:checked', el).map((c) => c.value),
      match: { senderDomains: list(q('senderDomains').value), senders: list(q('senders').value), recipientDomains: list(q('recipientDomains').value) },
    };
  });
}

$('#add-rule').addEventListener('click', () => {
  if (!destinations.length) return toast('Add a destination first', 'err');
  rulesBox.append(ruleEditor());
});

$('#routing').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#routing-error');
  err.className = 'hidden';
  try {
    await api('PUT', '/api/routes', { defaultDestinationId: $('#default-dest').value || null, rules: readRules() });
    toast('Routing saved');
    await loadAll(fetchLists(), { keepEdits: false });
  } catch (x) { showError(err, x); }
});

// Unsaved routing edits survive a destination being added, edited or deleted (which re-renders the rules
// so their "Deliver to" checkboxes list the current destinations).
let routingDirty = false;
$('#routing').addEventListener('input', () => { routingDirty = true; });
rulesBox.addEventListener('click', (e) => { if (e.target.closest('button')) routingDirty = true; });
$('#add-rule').addEventListener('click', () => { routingDirty = true; });

async function loadAll(lists = fetchLists(), { keepEdits = routingDirty } = {}) {
  const [list, routes, status] = await lists;
  const pendingRules = keepEdits ? readRules() : null;
  const pendingDefault = keepEdits ? $('#default-dest').value : null;
  destinations = list;
  renderDestinations(status);
  const ids = new Set(destinations.map((d) => d.id));
  const def = pendingDefault !== null && (pendingDefault === '' || ids.has(pendingDefault)) ? pendingDefault : routes.defaultDestinationId;
  fill($('#default-dest'), h('option', { value: '' }, '— none (reject with temporary error) —'),
    ...destinations.map((d) => h('option', { value: d.id, selected: d.id === def }, d.name)));
  const rules = pendingRules ? pendingRules.map((r) => ({ ...r, destinationIds: r.destinationIds.filter((id) => ids.has(id)) })) : routes.rules;
  fill(rulesBox, ...rules.map(ruleEditor));
  if (!keepEdits) routingDirty = false;
}

loadAll(firstLists, { keepEdits: false });
