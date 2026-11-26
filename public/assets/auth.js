/* Student authentication: register → verify → session, or login → verify → session. */
(function () {
  'use strict';

  const { api, session, toast, applyFieldErrors, clearFieldErrors, setAlert, busy, safeNext, escapeHtml } = window.CC;

  const panels = {
    login: document.getElementById('panelLogin'),
    register: document.getElementById('panelRegister'),
    otp: document.getElementById('panelOtp'),
  };
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const otpForm = document.getElementById('otpForm');
  const otpAlert = document.getElementById('otpAlert');
  const otpInfo = document.getElementById('otpInfo');
  const otpInputs = Array.from(document.querySelectorAll('[data-otp]'));
  const resendBtn = document.getElementById('resendBtn');
  const otpEmailEl = document.getElementById('otpEmail');
  const otpExpiryEl = document.getElementById('otpExpiry');

  const state = { email: '', purpose: 'login', resendIn: 0, timer: null };

  function show(name) {
    Object.entries(panels).forEach(([key, el]) => {
      el.hidden = key !== name;
    });
    const firstInput = panels[name].querySelector('input:not([type="hidden"])');
    if (firstInput) firstInput.focus();
    if (name === 'otp') {
      window.history.replaceState(null, '', 'auth.html#verify');
    }
  }

  function startCountdown(seconds) {
    state.resendIn = Number(seconds) || 0;
    if (state.timer) clearInterval(state.timer);
    const paint = () => {
      if (state.resendIn <= 0) {
        resendBtn.disabled = false;
        resendBtn.textContent = 'Resend code';
        clearInterval(state.timer);
        return;
      }
      resendBtn.disabled = true;
      resendBtn.textContent = 'Resend code in ' + state.resendIn + 's';
      state.resendIn -= 1;
    };
    paint();
    state.timer = setInterval(paint, 1000);
  }

  function goToOtp(data) {
    state.email = data.email;
    state.purpose = data.purpose || 'login';
    otpEmailEl.textContent = data.email;
    const minutes = Math.max(1, Math.round((data.expiresInSeconds || 300) / 60));
    otpExpiryEl.textContent = minutes + (minutes === 1 ? ' minute' : ' minutes');
    setAlert(otpAlert, '');
    setAlert(
      otpInfo,
      data.emailSent === false
        ? 'The code was created but the email could not be sent. Check the server mail settings or use “Resend code”.'
        : 'A 6-digit code is on its way to ' + data.email + '.',
      data.emailSent === false ? 'info' : 'success'
    );
    otpInputs.forEach((input) => (input.value = ''));
    show('otp');
    otpInputs[0].focus();
    startCountdown(data.resendInSeconds || 60);
  }

  /* ------------------------------- login form ------------------------------ */

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('loginSubmit');
    const alertBox = document.getElementById('loginAlert');
    clearFieldErrors(loginForm);
    setAlert(alertBox, '');

    const payload = {
      email: loginForm.elements.email.value.trim(),
      password: loginForm.elements.password.value,
    };
    if (!payload.email || !payload.password) {
      setAlert(alertBox, 'Enter your email and password.');
      return;
    }

    busy(button, true, 'Checking…');
    try {
      const data = await api('/api/auth/login', { method: 'POST', body: payload });
      goToOtp(data);
      toast('Code sent — check your university inbox', 'success');
    } catch (err) {
      if (err.fields) applyFieldErrors(loginForm, err.fields);
      setAlert(alertBox, err.message);
    } finally {
      busy(button, false);
    }
  });

  /* ------------------------------ register form ---------------------------- */

  registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('registerSubmit');
    const alertBox = document.getElementById('registerAlert');
    clearFieldErrors(registerForm);
    setAlert(alertBox, '');

    const payload = {
      name: registerForm.elements.name.value.trim(),
      email: registerForm.elements.email.value.trim(),
      password: registerForm.elements.password.value,
    };
    if (!payload.name || payload.name.length < 2) {
      setAlert(alertBox, 'Enter your full name.');
      return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.email)) {
      setAlert(alertBox, 'Enter a valid email address.');
      return;
    }
    if (payload.password.length < 8) {
      setAlert(alertBox, 'Your password must be at least 8 characters.');
      return;
    }

    busy(button, true, 'Creating…');
    try {
      const data = await api('/api/auth/register', { method: 'POST', body: payload });
      goToOtp(data);
      toast('Account created — verify your email to finish', 'success');
    } catch (err) {
      if (err.fields) applyFieldErrors(registerForm, err.fields);
      setAlert(alertBox, err.message);
    } finally {
      busy(button, false);
    }
  });

  /* -------------------------------- OTP form ------------------------------- */

  otpInputs.forEach((input, index) => {
    input.addEventListener('input', (event) => {
      const value = event.target.value.replace(/\D/g, '');
      event.target.value = value.slice(0, 1);
      if (value && index < otpInputs.length - 1) otpInputs[index + 1].focus();
      if (otpInputs.every((el) => el.value)) otpForm.requestSubmit();
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace' && !input.value && index > 0) {
        otpInputs[index - 1].focus();
      }
      if (event.key === 'ArrowLeft' && index > 0) otpInputs[index - 1].focus();
      if (event.key === 'ArrowRight' && index < otpInputs.length - 1) otpInputs[index + 1].focus();
    });

    input.addEventListener('paste', (event) => {
      const text = (event.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
      if (!text) return;
      event.preventDefault();
      text
        .slice(0, otpInputs.length)
        .split('')
        .forEach((digit, i) => {
          if (otpInputs[i]) otpInputs[i].value = digit;
        });
      const nextEmpty = otpInputs.find((el) => !el.value);
      (nextEmpty || otpInputs[otpInputs.length - 1]).focus();
      if (otpInputs.every((el) => el.value)) otpForm.requestSubmit();
    });
  });

  otpForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('otpSubmit');
    const code = otpInputs.map((el) => el.value).join('');
    setAlert(otpAlert, '');

    if (!/^\d{6}$/.test(code)) {
      setAlert(otpAlert, 'Enter all six digits of the code.');
      otpInputs[0].focus();
      return;
    }

    busy(button, true, 'Verifying…');
    try {
      const data = await api('/api/auth/verify-otp', {
        method: 'POST',
        body: { email: state.email, code, purpose: state.purpose },
        allowUnauthorized: true,
      });
      session.set(data.token, data.user);
      toast('Verified — welcome to CampusConnect', 'success');
      const fallback = data.user.role === 'admin' ? 'admin/' : 'dashboard.html';
      setTimeout(() => (location.href = safeNext(fallback)), 400);
    } catch (err) {
      setAlert(otpAlert, err.message);
      otpInputs.forEach((input) => (input.value = ''));
      otpInputs[0].focus();
    } finally {
      busy(button, false);
    }
  });

  resendBtn.addEventListener('click', async () => {
    setAlert(otpAlert, '');
    resendBtn.disabled = true;
    try {
      const data = await api('/api/auth/resend-otp', {
        method: 'POST',
        body: { email: state.email, purpose: state.purpose },
      });
      setAlert(otpInfo, 'A new code is on its way. The previous code no longer works.', 'success');
      startCountdown(data.resendInSeconds || 60);
      otpInputs.forEach((input) => (input.value = ''));
      otpInputs[0].focus();
    } catch (err) {
      setAlert(otpAlert, err.message);
      startCountdown(err.details && err.details.retryAfter ? err.details.retryAfter : 30);
    }
  });

  document.getElementById('backBtn').addEventListener('click', () => {
    if (state.timer) clearInterval(state.timer);
    show('login');
    window.history.replaceState(null, '', 'auth.html');
  });

  document.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.goto;
      show(target);
      window.history.replaceState(null, '', target === 'register' ? 'auth.html#register' : 'auth.html');
    });
  });

  /* ------------------------------ initial state ---------------------------- */

  if (location.hash === '#register') show('register');
  else show('login');

  // If the visitor already has a session, offer the dashboard instead.
  if (session.token) {
    api('/api/auth/me', { allowUnauthorized: true })
      .then(() => {
        location.href = safeNext('dashboard.html');
      })
      .catch(() => session.clear());
  }

  const domainHint = document.getElementById('domainHint');
  if (domainHint) {
    domainHint.textContent =
      'Only approved university addresses are accepted. Sub-domains such as department subdomains also work.';
  }
})();
