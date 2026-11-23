const form = document.getElementById('login');
const error = document.getElementById('error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.classList.add('hidden');
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: form.password.value }),
  });
  if (res.ok) {
    location.href = '/';
    return;
  }
  const data = await res.json().catch(() => ({}));
  error.textContent = data.error || 'Sign-in failed';
  error.classList.remove('hidden');
  form.password.select();
});
