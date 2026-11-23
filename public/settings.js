import { $, api, fillForm, layout, readForm, showError, toast } from './app.js';

layout();

const form = $('#settings');

function updateHints() {
  const v = readForm(form);
  $('#fixed-box').classList.toggle('hidden', v.sender.mode !== 'fixed');
  $('#auth-warn').classList.toggle('hidden', !v.smtp.requireAuth);
  $('#open-warn').classList.toggle('hidden', v.smtp.allowedNetworks.length > 0 || v.smtp.requireAuth);
}

form.addEventListener('input', updateHints);
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#error').className = 'hidden';
  try {
    const saved = await api('PUT', '/api/settings', readForm(form));
    fillForm(form, saved);
    updateHints();
    toast('Settings saved');
  } catch (err) {
    showError($('#error'), err);
  }
});

fillForm(form, await api('GET', '/api/settings'));
updateHints();
