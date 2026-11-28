/* ==========================================================================
   CampusConnect — shared browser client
   Loaded by every page. Provides: API access, session handling, toasts,
   escaping, formatting, navigation state and small UI helpers.
   No inline scripts anywhere (the CSP forbids them).
   ========================================================================== */

(function () {
  'use strict';

  const cfg = window.CAMPUS_CONFIG || {};
  const API_BASE = String(cfg.apiBase || '').replace(/\/+$/, '');
  const TOKEN_KEY = 'campusconnect.token';
  const USER_KEY = 'campusconnect.user';

  /* ------------------------------- session -------------------------------- */

  const session = {
    get token() {
      return localStorage.getItem(TOKEN_KEY) || '';
    },
    get user() {
      try {
        return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
      } catch {
        return null;
      }
    },
    set(token, user) {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    },
    clear() {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    },
    get isAdmin() {
      return this.user && this.user.role === 'admin';
    },
  };

  class ApiError extends Error {
    constructor(status, payload) {
      super((payload && payload.message) || 'Something went wrong');
      this.status = status;
      this.code = payload && payload.code;
      this.fields = (payload && payload.fields) || {};
      this.details = (payload && payload.details) || {};
    }
  }

  /**
   * Calls the API. Adds the bearer token, parses the standard error envelope
   * ({ error: { code, message, fields } }) and signs the user out on 401.
   */
  async function api(path, options) {
    const opts = options || {};
    const headers = {};
    const token = session.token;
    if (token) headers.Authorization = 'Bearer ' + token;

    let body;
    if (opts.form) {
      body = opts.form; // FormData: let the browser set the boundary
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    let response;
    try {
      response = await fetch(API_BASE + path, {
        method: opts.method || 'GET',
        headers,
        body,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (err) {
      throw new ApiError(0, { message: 'Cannot reach the server. Check your connection.' });
    }

    const isJson = (response.headers.get('content-type') || '').includes('application/json');
    const payload = isJson ? await response.json().catch(() => ({})) : {};

    // A 401 from a sign-in endpoint means "wrong credentials", not "your session
    // ended": reloading the page there would throw the error message away.
    const isCredentialCall = /^\/api\/auth\/(login|register|verify-otp|admin\/login|reset-password|forgot-password)/.test(
      String(path)
    );

    if (response.status === 401 && !opts.allowUnauthorized && !isCredentialCall) {
      session.clear();
      const inAdmin = location.pathname.indexOf('/admin/') !== -1;
      const next = encodeURIComponent(location.pathname + location.search);
      // Each portal returns to its own sign-in screen.
      if (inAdmin && !/\/admin\/?$/.test(location.pathname)) {
        location.href = './';
        throw new ApiError(401, { message: 'Please sign in again' });
      }
      if (!inAdmin && !location.pathname.endsWith('/auth.html')) {
        location.href = 'auth.html?next=' + next;
        throw new ApiError(401, { message: 'Please sign in again' });
      }
    }

    if (!response.ok) {
      const error = payload.error || payload;
      if (response.status === 503) {
        error.message =
          error.message || 'The service is busy right now. Please try again in a moment.';
      }
      throw new ApiError(response.status, error);
    }
    return payload;
  }

  /* --------------------------------- utils -------------------------------- */

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  const IST = { timeZone: 'Asia/Kolkata' };

  function formatDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-IN', { ...IST, day: '2-digit', month: 'short', year: 'numeric' });
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-IN', {
      ...IST,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function timeAgo(value) {
    if (!value) return '—';
    const diff = Date.now() - new Date(value).getTime();
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const hours = Math.round(mins / 60);
    if (hours < 24) return hours + ' h ago';
    const days = Math.round(hours / 24);
    if (days < 30) return days + ' d ago';
    return formatDate(value);
  }

  function initials(name) {
    return String(name || '?')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0] || '')
      .join('')
      .toUpperCase();
  }

  /**
   * Badge. `status` picks the colour (a CSS class); `label` is what the reader
   * sees, so a role or an outcome can be shown without inventing CSS classes.
   */
  function pill(status, label) {
    const text = label || String(status || '').replace(/_/g, ' ');
    return '<span class="pill ' + escapeHtml(status) + '">' + escapeHtml(text) + '</span>';
  }

  /* --------------------------------- toast -------------------------------- */

  let toastHost;
  function toast(message, kind) {
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.className = 'toast-host';
      toastHost.setAttribute('aria-live', 'polite');
      toastHost.setAttribute('aria-atomic', 'false');
      document.body.appendChild(toastHost);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = message;
    toastHost.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    }, 4200);
  }

  /* ------------------------------ form helpers ----------------------------- */

  /** Renders field-level validation errors returned by the API. */
  function applyFieldErrors(form, fields) {
    form.querySelectorAll('[aria-invalid="true"]').forEach((el) => {
      el.removeAttribute('aria-invalid');
    });
    form.querySelectorAll('.error').forEach((el) => el.remove());
    let first = null;
    Object.entries(fields || {}).forEach(([name, message]) => {
      const input = form.querySelector('[name="' + name + '"]');
      if (!input) return;
      input.setAttribute('aria-invalid', 'true');
      const hint = document.createElement('span');
      hint.className = 'error';
      hint.textContent = message;
      (input.parentElement || input).appendChild(hint);
      if (!first) first = input;
    });
    if (first) first.focus();
  }

  function clearFieldErrors(form) {
    form.querySelectorAll('[aria-invalid="true"]').forEach((el) => el.removeAttribute('aria-invalid'));
    form.querySelectorAll('.error').forEach((el) => el.remove());
  }

  function setAlert(el, message, kind) {
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.className = 'form-alert ' + (kind || 'error');
    el.textContent = message;
  }

  function busy(button, isBusy, busyLabel) {
    if (!button) return;
    if (isBusy) {
      button.dataset.label = button.innerHTML;
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> ' + escapeHtml(busyLabel || 'Working…');
    } else {
      button.disabled = false;
      if (button.dataset.label) button.innerHTML = button.dataset.label;
    }
  }

  /* ---------------------------------- nav --------------------------------- */

  function renderNav() {
    const host = document.querySelector('[data-nav-links]');
    if (!host) return;
    const user = session.user;
    const page = location.pathname.split('/').pop() || 'index.html';

    const link = (href, label) =>
      '<a href="' + href + '"' + (page === href ? ' aria-current="page"' : '') + '>' + label + '</a>';

    let html = link('index.html', 'Browse') + link('index.html#lost', 'Lost') + link('index.html#found', 'Found');
    if (user) {
      html += link('dashboard.html', 'Dashboard');
      html += '<a class="btn btn-outline btn-sm" href="report.html">+ Report item</a>';
      html +=
        '<button class="btn btn-ghost btn-sm" data-logout>Log out (' +
        escapeHtml(initials(user.name)) +
        ')</button>';
    } else {
      html += '<a class="btn btn-outline btn-sm" href="auth.html">Sign in</a>';
      html += '<a class="btn btn-primary btn-sm" href="auth.html#register">Create account</a>';
    }
    host.innerHTML = html;

    host.querySelectorAll('[data-logout]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api('/api/auth/logout', { method: 'POST', allowUnauthorized: true });
        } catch (err) {
          /* even if the call fails, clear the local session */
        }
        session.clear();
        toast('You have been signed out', 'success');
        setTimeout(() => (location.href = 'index.html'), 500);
      });
    });
  }

  function initNavToggle() {
    const toggle = document.querySelector('[data-nav-toggle]');
    const links = document.querySelector('[data-nav-links]');
    if (!toggle || !links) return;
    toggle.addEventListener('click', () => {
      const open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
  }

  /** Sends the visitor to sign in, remembering where they wanted to go. */
  function requireSession() {
    if (!session.token) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = 'auth.html?next=' + next;
      return false;
    }
    return true;
  }

  /** Mirrors the server check — the server is still the real gate. */
  function requireAdminPage() {
    if (!session.token || !session.isAdmin) {
      location.href = 'index.html';
      return false;
    }
    return true;
  }

  function queryParam(name) {
    return new URLSearchParams(location.search).get(name);
  }

  /**
   * Resolves ?next= against the current origin and refuses anything that leaves
   * it. URL() normalises the backslash and protocol-relative tricks that a
   * simple string check misses.
   */
  function safeNext(fallback) {
    const next = queryParam('next');
    if (!next) return fallback;
    try {
      const target = new URL(next, location.origin);
      if (target.origin !== location.origin) return fallback;
      return target.pathname.replace(/^\/+/, '') + target.search + target.hash;
    } catch (err) {
      return fallback;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    renderNav();
    initNavToggle();
  });


  /* --------------------------- password strength --------------------------- */

  /**
   * Mirrors src/lib/passwordStrength.js. tests/password.test.js loads both and
   * fails if they ever disagree, so this copy cannot drift silently.
   */
  const COMMON_PASSWORDS = [
    'password', 'passw0rd', 'qwerty', 'qwertyuiop', 'azerty', 'letmein', 'welcome',
    'iloveyou', 'admin', 'administrator', 'root', 'toor', 'abc123', 'abcd1234',
    '123456', '1234567', '12345678', '123456789', '1234567890', '111111', '000000',
    'monkey', 'dragon', 'sunshine', 'princess', 'football', 'cricket', 'india123',
    'campus', 'campusconnect', 'student', 'college', 'university', 'saiuniversity',
    'changeme', 'secret', 'master', 'superman', 'batman', 'trustno1', 'whatever',
  ];
  const RUNS = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

  function passwordStrength(value) {
    const pw = String(value == null ? '' : value);
    const hints = [];
    const lower = pw.toLowerCase();
    const has = {
      lower: /[a-z]/.test(pw), upper: /[A-Z]/.test(pw),
      digit: /[0-9]/.test(pw), symbol: /[^A-Za-z0-9]/.test(pw),
    };
    const variety = Object.keys(has).filter((k) => has[k]).length;

    if (!pw) return { score: 0, label: 'Very weak', hints: ['Enter a password'] };

    let run = /(.)\1\1/.test(pw);
    if (!run) {
      for (const seq of RUNS) {
        for (let i = 0; i + 4 <= seq.length; i += 1) {
          const chunk = seq.slice(i, i + 4);
          if (lower.includes(chunk) || lower.includes(chunk.split('').reverse().join(''))) { run = true; break; }
        }
        if (run) break;
      }
    }
    const lettersOnly = lower.replace(/[^a-z]/g, '');
    const common = COMMON_PASSWORDS.some((w) => lower === w || lettersOnly === w);
    const containsCommon = COMMON_PASSWORDS.some((w) => w.length >= 5 && lower.includes(w));
    const digitsOnly = /^[0-9]+$/.test(pw);

    let score;
    if (pw.length < 8) score = 0;
    else if (pw.length < 12) score = 1;
    else if (pw.length < 16) score = 2;
    else score = 3;

    if (variety >= 3) score += 1;
    if (variety === 4) score += 1;
    if (common) score = Math.min(score, 0);
    else if (containsCommon && pw.length < 16) score = Math.min(score, pw.length < 12 ? 1 : 2);
    if (digitsOnly) score = Math.min(score, 0);
    if (run) score -= 1;
    if (pw.length >= 20) score += 1;
    score = Math.max(0, Math.min(4, score));

    if (pw.length < 8) hints.push('Use at least 8 characters');
    else if (pw.length < 12) hints.push('Longer is stronger — 12 or more characters');
    if (variety < 3) hints.push('Mix upper case, lower case and numbers');
    if (!has.symbol) hints.push('A symbol makes it much harder to guess');
    if (common || containsCommon) hints.push('Avoid common words like “password”, “campus” or your name');
    if (digitsOnly) hints.push('Digits alone are guessed almost instantly');
    if (run) hints.push('Avoid repeated characters and sequences like “abc” or “1234”');

    const labels = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
    return { score, label: labels[score], hints: hints.slice(0, 3) };
  }

  const MIN_SCORE = { student: 2, admin: 3 };
  const MIN_LENGTH = { student: 8, admin: 12 };

  /** Mirrors meetsPolicy() in src/lib/passwordStrength.js, length floor included. */
  function passwordPolicy(value, role) {
    const who = role === 'admin' ? 'admin' : 'student';
    const result = passwordStrength(value);
    const length = String(value == null ? '' : value).length;
    return { ...result, ok: length >= MIN_LENGTH[who] && result.score >= MIN_SCORE[who] };
  }

  /**
   * Attaches a live strength meter under a password input.
   * Injects its own markup so every page gets the same component.
   */
  function attachPasswordMeter(input, options) {
    const opts = options || {};
    const role = opts.role === 'admin' ? 'admin' : 'student';
    if (!input || !input.parentNode) return null;

    const wrap = document.createElement('div');
    wrap.className = 'pw-meter';
    wrap.innerHTML =
      '<div class="pw-meter-track" role="progressbar" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0" aria-label="Password strength">' +
        '<span class="pw-meter-fill"></span>' +
      '</div>' +
      '<div class="pw-meter-line"><span class="pw-meter-label" aria-live="polite"></span>' +
      '<span class="pw-meter-need"></span></div>' +
      '<ul class="pw-meter-hints"></ul>';
    input.parentNode.appendChild(wrap);

    const fill = wrap.querySelector('.pw-meter-fill');
    const label = wrap.querySelector('.pw-meter-label');
    const need = wrap.querySelector('.pw-meter-need');
    const hints = wrap.querySelector('.pw-meter-hints');
    const track = wrap.querySelector('.pw-meter-track');

    const render = () => {
      const value = input.value || '';
      const policy = passwordPolicy(value, role);
      wrap.dataset.score = String(policy.score);
      fill.style.width = ((policy.score + 1) / 5) * 100 + '%';
      track.setAttribute('aria-valuenow', String(policy.score));
      label.textContent = value ? policy.label : '';
      need.textContent = value ? (policy.ok ? 'Good to go' : 'Too weak to use') : '';
      need.className = 'pw-meter-need ' + (value && !policy.ok ? 'bad' : 'good');
      hints.innerHTML = value && !policy.ok
        ? policy.hints.map((h) => '<li>' + escapeHtml(h) + '</li>').join('')
        : '';
      wrap.classList.toggle('is-weak', Boolean(value) && !policy.ok);
    };

    input.addEventListener('input', render);
    input.addEventListener('blur', render);
    render();
    return { refresh: render, strength: () => passwordStrength(input.value), policy: () => passwordPolicy(input.value, role) };
  }

  window.CC = {
    api,
    session,
    toast,
    escapeHtml,
    passwordStrength,
    passwordPolicy,
    attachPasswordMeter,
    formatDate,
    formatDateTime,
    timeAgo,
    initials,
    pill,
    applyFieldErrors,
    clearFieldErrors,
    setAlert,
    busy,
    renderNav,
    requireSession,
    requireAdminPage,
    queryParam,
    safeNext,
    ApiError,
    API_BASE,
  };
})();
