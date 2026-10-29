(() => {
  const path = location.pathname;
  let header = document.querySelector('header.site');
  if (!header) {
    header = document.createElement('header');
    header.className = 'site';
    header.innerHTML =
      '<nav class="tabs" aria-label="Main navigation"></nav><div class="header-right"></div>';
    document.body.prepend(header);
  }
  const logo = header.querySelector('.logo');
  const logoMarkup =
    '<a class="logo" href="/index.html" aria-label="NexLiga home"><svg class="logo-mark" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.6"/><path d="M12 7l3 2.2-1.1 3.6h-3.8L9 9.2 12 7z" fill="currentColor"/><path d="M12 4.4V7M4.4 12H7M17 12h2.6M12 17v2.6M7.2 7.2l1.6 1.6M15.2 8.8l1.6-1.6M7.2 16.8l1.6-1.6M15.2 15.2l1.6 1.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg><span class="logo-word">NexLiga</span></a>';
  if (logo) logo.outerHTML = logoMarkup;
  else header.insertAdjacentHTML('afterbegin', logoMarkup);
  const nav = header.querySelector('nav.tabs');
  if (nav) {
    const homeActive = path === '/' || path.endsWith('/index.html');
    const leaguesActive = path.startsWith('/leagues');
    const productsActive = [
      '/products/live-draw.html',
      '/products/fixtures.html',
      '/products/verifier.html',
    ].includes(path);
    nav.innerHTML = `<a href="/index.html" class="${homeActive ? 'active' : ''}" ${homeActive ? 'aria-current="page"' : ''}><span class="tab-label">Home</span></a><a href="/leagues.html" class="${leaguesActive ? 'active' : ''}" ${leaguesActive ? 'aria-current="page"' : ''}><span class="tab-label">Leagues</span></a><details class="products-menu ${productsActive ? 'active' : ''}"><summary aria-label="Browse products"><span class="tab-label">Products <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></span></summary><div class="products-popover"><span class="products-popover-title">NexLiga products</span><a href="/products/live-draw.html"><strong>FairDraft</strong><small>Balanced team draws</small></a><a href="/products/fixtures.html"><strong>Fixture Planner</strong><small>Home and away schedules</small></a><a href="/products/verifier.html"><strong>Draw Verifier</strong><small>Check a published draw</small></a></div></details>`;
    nav.setAttribute('aria-label', 'Main navigation');
    const productsMenu = nav.querySelector('.products-menu');
    const positionProductsPopover = () => {
      if (!productsMenu.open) return;
      const popover = productsMenu.querySelector('.products-popover');
      const menuLeft = productsMenu.getBoundingClientRect().left;
      const maxLeft = window.innerWidth - popover.offsetWidth - 18;
      const left = Math.max(18, Math.min(menuLeft, maxLeft));
      popover.style.setProperty('--products-popover-offset', `${left - menuLeft}px`);
    };
    productsMenu.addEventListener('toggle', () => requestAnimationFrame(positionProductsPopover));
    window.addEventListener('resize', positionProductsPopover);
    document.addEventListener('click', (event) => {
      if (productsMenu.open && !productsMenu.contains(event.target)) productsMenu.open = false;
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !productsMenu.open) return;
      productsMenu.open = false;
      productsMenu.querySelector('summary').focus();
    });
  }
  const right = header.querySelector('.header-right');
  if (right && !right.querySelector('#authControl')) {
    right.innerHTML = `${right.querySelector('.secure-badge')?.outerHTML || ''}${right.querySelector('#themeToggle')?.outerHTML || ''}<span class="auth-slot"><button id="authControl" class="account-button" type="button">Sign in</button></span>`;
    const theme = right.querySelector('#themeToggle');
    if (theme)
      theme.addEventListener('click', () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        localStorage.setItem('fairdraft-theme', next);
      });
  }

  document.addEventListener('click', (event) => {
    const jumpTarget = event.target.closest('[data-scroll-top]');
    if (!jumpTarget) return;
    event.preventDefault();
    window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
  });

  function toast(message) {
    let el = document.querySelector('.share-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'share-toast';
      document.body.append(el);
    }
    el.textContent = message;
    el.style.display = 'block';
    clearTimeout(window.__fdToastTimer);
    window.__fdToastTimer = setTimeout(() => {
      el.style.display = 'none';
    }, 2600);
  }
  window.fdToast = toast;
  window.fdApi = async (route, options = {}) => {
    const response = await fetch(route, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error?.message || 'Request failed. Please try again.');
      error.status = response.status;
      error.code = data.error?.code;
      throw error;
    }
    return data;
  };

  if (!document.querySelector('#accountModal')) {
    const modal = document.createElement('div');
    modal.id = 'accountModal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="accountTitle">
      <button class="modal-close" type="button" aria-label="Close">×</button>
      <span class="eyebrow">Your community starts here</span><h2 id="accountTitle">Welcome to NexLiga</h2>
      <p>Own your league, publish the table and keep every matchday accountable.</p>
      <div class="modal-switch" role="tablist"><button type="button" class="active" data-mode="register">Create account</button><button type="button" data-mode="login">Sign in</button></div>
      <div class="form-error" role="alert"></div>
      <div class="form-success" role="status"></div>
      <form id="accountForm"><div class="field" data-name-field><label for="accountName">Your name</label><input id="accountName" autocomplete="name" minlength="2" maxlength="70" placeholder="e.g. Alex Okafor"></div>
      <div class="field"><label for="accountEmail">Email address</label><input id="accountEmail" type="email" autocomplete="email" required maxlength="254" placeholder="you@example.com"></div>
      <div class="field" data-password-field><label for="accountPassword">Password</label><input id="accountPassword" type="password" autocomplete="new-password" minlength="10" required placeholder="At least 10 characters"><button class="auth-forgot-link" type="button" data-forgot-password>Forgot your password?</button></div>
      <button class="btn-primary" type="submit" style="width:100%">Create account</button></form>
      <div class="auth-google" data-google-region><span>or continue with</span><div id="googleSignInButton"></div></div>
      <p class="auth-google-note" data-google-note hidden>Google sign-in is not configured yet.</p>
      <p class="demo-note">Your leagues and account are stored securely by NexLiga. Public league pages are read-only for visitors.</p></section>`;
    document.body.append(modal);
    const form = modal.querySelector('form'),
      errorBox = modal.querySelector('.form-error'),
      successBox = modal.querySelector('.form-success'),
      nameField = modal.querySelector('[data-name-field]'),
      passwordField = modal.querySelector('[data-password-field]'),
      password = modal.querySelector('#accountPassword'),
      submit = form.querySelector('button[type="submit"]'),
      googleRegion = modal.querySelector('[data-google-region]'),
      googleNote = modal.querySelector('[data-google-note]');
    let googleConfigured = false;
    let googleInitialized = false;
    let mode = 'register';
    const showError = (message) => {
      errorBox.textContent = message;
      errorBox.style.display = 'block';
      successBox.style.display = 'none';
    };
    const showSuccess = (message) => {
      successBox.textContent = message;
      successBox.style.display = 'block';
      errorBox.style.display = 'none';
    };
    const setMode = (next) => {
      mode = next;
      modal
        .querySelectorAll('[data-mode]')
        .forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
      nameField.hidden = mode !== 'register';
      passwordField.hidden = mode === 'forgot';
      password.required = mode !== 'forgot';
      password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
      password.minLength = mode === 'register' ? 10 : 1;
      googleRegion.hidden = mode === 'forgot';
      googleNote.hidden = googleConfigured || mode === 'forgot';
      modal.querySelector('[data-forgot-password]').hidden = mode !== 'login';
      submit.textContent =
        mode === 'login' ? 'Sign in' : mode === 'forgot' ? 'Send reset link' : 'Create account';
      errorBox.style.display = 'none';
      successBox.style.display = 'none';
    };
    modal
      .querySelectorAll('[data-mode]')
      .forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
    modal
      .querySelector('[data-forgot-password]')
      .addEventListener('click', () => setMode('forgot'));
    modal.addEventListener('click', (event) => {
      if (event.target === modal || event.target.closest('.modal-close'))
        modal.classList.remove('open');
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorBox.style.display = 'none';
      submit.disabled = true;
      submit.textContent = 'Working…';
      const payload = { email: form.querySelector('#accountEmail').value };
      if (mode !== 'forgot') payload.password = password.value;
      if (mode === 'register') payload.name = form.querySelector('#accountName').value;
      try {
        if (mode === 'forgot') {
          const result = await window.fdApi('/api/auth/forgot-password', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
          showSuccess(result.message || 'If an account exists, a reset link has been sent.');
          submit.disabled = false;
          submit.textContent = 'Send reset link';
          return;
        }
        await window.fdApi(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify(payload) });
        modal.classList.remove('open');
        await refreshAccount();
        toast(mode === 'login' ? 'Signed in successfully.' : 'Your NexLiga account is ready.');
        if (window.fdOnLogin) await window.fdOnLogin();
      } catch (error) {
        showError(error.message);
      } finally {
        submit.disabled = false;
        submit.textContent = mode === 'login' ? 'Sign in' : 'Create account';
      }
    });
    const initializeGoogle = async () => {
      if (googleInitialized) return;
      googleInitialized = true;
      try {
        const { googleClientId } = await window.fdApi('/api/auth/config');
        if (!googleClientId) {
          googleRegion.hidden = true;
          googleNote.hidden = false;
          return;
        }
        googleConfigured = true;
        googleNote.hidden = true;
        let script = document.querySelector('script[data-google-identity]');
        if (!script) {
          script = document.createElement('script');
          script.src = 'https://accounts.google.com/gsi/client';
          script.async = true;
          script.defer = true;
          script.dataset.googleIdentity = 'true';
          document.head.append(script);
        }
        if (!window.google?.accounts?.id)
          await new Promise((resolve, reject) => {
            script.addEventListener('load', resolve, { once: true });
            script.addEventListener(
              'error',
              () => reject(new Error('Google sign-in could not be loaded. Please try again.')),
              { once: true }
            );
          });
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: async (response) => {
            try {
              await window.fdApi('/api/auth/google', {
                method: 'POST',
                body: JSON.stringify({ credential: response.credential }),
              });
              modal.classList.remove('open');
              await refreshAccount();
              toast('Signed in successfully with Google.');
              if (window.fdOnLogin) await window.fdOnLogin();
            } catch (error) {
              showError(error.message);
            }
          },
        });
        window.google.accounts.id.renderButton(modal.querySelector('#googleSignInButton'), {
          theme: 'outline',
          size: 'large',
          shape: 'rectangular',
          text: 'continue_with',
          width: 360,
        });
      } catch (error) {
        googleInitialized = false;
        googleRegion.hidden = true;
        showError(error.message);
      }
    };
    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-auth-open]')) {
        initializeGoogle();
        return;
      }
      const control = event.target.closest('#authControl');
      if (!control) return;
      if (control.dataset.signedIn === 'true') {
        document.querySelector('#userMenu')?.toggleAttribute('open');
        return;
      }
      setMode(control.dataset.mode || 'register');
      modal.classList.add('open');
      initializeGoogle();
      setTimeout(
        () =>
          (control.dataset.mode === 'login'
            ? form.querySelector('#accountEmail')
            : form.querySelector('#accountName')
          ).focus(),
        50
      );
    });
  }

  async function refreshAccount() {
    const control = document.querySelector('#authControl');
    if (!control) return;
    try {
      const { user } = await window.fdApi('/api/auth/me');
      if (!user) {
        control.textContent = 'Sign in';
        control.dataset.signedIn = 'false';
        control.dataset.mode = 'login';
        return;
      }
      const initial = user.name
        .trim()
        .split(/\s+/)
        .map((s) => s[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();
      const holder = document.createElement('div');
      holder.innerHTML = `<details id="userMenu" class="user-menu auth-enter"><summary><span class="user-avatar"></span><span class="menu-name"></span></summary><div class="user-popover"><button type="button" class="manage-leagues">My leagues</button><button type="button" class="sign-out">Sign out</button></div></details>`;
      control.replaceWith(holder.firstElementChild);
      const menu = document.querySelector('#userMenu');
      menu.querySelector('.user-avatar').textContent = initial;
      menu.querySelector('.menu-name').textContent = user.name.split(/\s+/)[0];
      menu.querySelector('.manage-leagues').onclick = () => {
        location.href = '/leagues.html?mine=1';
      };
      menu.querySelector('.sign-out').onclick = async () => {
        try {
          await window.fdApi('/api/auth/logout', { method: 'POST', body: '{}' });
          location.reload();
        } catch (error) {
          toast(error.message);
        }
      };
    } catch {
      control.textContent = 'Sign in';
      control.dataset.signedIn = 'false';
      control.dataset.mode = 'login';
    } finally {
      document.documentElement.classList.remove('auth-pending');
    }
  }
  window.fdRefreshAccount = refreshAccount;
  refreshAccount();
})();
