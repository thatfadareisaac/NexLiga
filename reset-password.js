(() => {
  const form = document.getElementById('resetForm');
  const password = document.getElementById('newPassword');
  const confirmation = document.getElementById('confirmPassword');
  const message = document.getElementById('resetMessage');
  const submit = form.querySelector('button[type="submit"]');
  const token = new URLSearchParams(location.search).get('token') || '';

  history.replaceState(null, '', location.pathname);

  function showMessage(text, kind) {
    message.textContent = text;
    message.className = `reset-message ${kind}`;
  }

  if (!/^[a-f0-9]{48}$/i.test(token)) {
    form.hidden = true;
    showMessage(
      'This reset link is invalid or has expired. Request a new one from the sign-in window.',
      'error'
    );
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.className = 'reset-message';
    if (password.value.length < 10 || password.value.length > 200) {
      showMessage('Choose a password between 10 and 200 characters.', 'error');
      return;
    }
    if (password.value !== confirmation.value) {
      showMessage('The passwords do not match.', 'error');
      confirmation.focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Updating password…';
    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: password.value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(data.error?.message || 'Could not update your password. Please try again.');
      form.hidden = true;
      showMessage('Your password has been updated. You can now sign in.', 'success');
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Update password';
    }
  });
})();
