import { $, fill, api, fmtTime, h, layout, readForm, showError, toast } from './app.js';

layout();

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

function render(users) {
  fill($('#rows'), ...users.map((u) => h('tr', {},
    h('td', { class: 'mono' }, u.username),
    h('td', {}, u.note),
    h('td', { class: 'nowrap' }, fmtTime(u.createdAt)),
    h('td', { class: 'nowrap' }, fmtTime(u.lastUsedAt)),
    h('td', { class: 'nowrap' },
      h('button', { class: 'small', onclick: () => resetPassword(u) }, 'New password'), ' ',
      h('button', { class: 'small danger', onclick: () => remove(u) }, 'Delete')),
  )));
  $('#empty').classList.toggle('hidden', users.length > 0);
}

async function resetPassword(u) {
  const password = generatePassword();
  if (!confirm(`Set a new password for ${u.username}?\n\nNew password: ${password}\n\nCopy it before pressing OK.`)) return;
  try {
    await api('PUT', `/api/users/${u.id}/password`, { password });
    toast(`Password changed for ${u.username}`);
  } catch (e) { toast(e.message, 'err'); }
}

async function remove(u) {
  if (!confirm(`Delete relay user ${u.username}? Devices using it will fail to authenticate.`)) return;
  try {
    await api('DELETE', `/api/users/${u.id}`);
    render(await api('GET', '/api/users'));
  } catch (e) { toast(e.message, 'err'); }
}

$('#gen').addEventListener('click', () => { $('#u-pass').value = generatePassword(); });
$('#add').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#error').className = 'hidden';
  try {
    render(await api('POST', '/api/users', readForm(e.target)));
    toast('User added');
    e.target.reset();
  } catch (err) { showError($('#error'), err); }
});

render(await api('GET', '/api/users'));
