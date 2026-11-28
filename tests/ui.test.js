'use strict';

/**
 * Front-end tests.
 *
 * Each page is loaded into a real DOM (jsdom), its scripts are executed, the
 * network is stubbed, and the forms are actually filled in and submitted. This
 * catches the class of bug that no API test can see — a selector that no longer
 * exists, a form field read the wrong way, a button that calls nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', 'public');

const ITEM = {
  id: '11111111-1111-1111-1111-111111111111',
  type: 'found',
  title: 'Black wallet',
  category: 'Accessories',
  description: 'Black leather wallet with a blue sticker.',
  location: 'Central Library',
  occurredOn: '2026-11-20',
  occurredTime: '14:30',
  additionalInfo: null,
  status: 'open',
  images: [{ url: '/uploads/public/a.webp', width: 800, height: 600 }],
  viewCount: 3,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  owner: { id: '22222222-2222-2222-2222-222222222222', name: 'Finder Fatima' },
  claimCount: 0,
  myClaim: null,
  isOwner: false,
};

const USER = {
  id: '33333333-3333-3333-3333-333333333333',
  name: 'Asha Rao',
  email: 'asha@saiuniversity.edu.in',
  role: 'student',
  is_email_verified: true,
  status: 'active',
  student_id: null,
  department: null,
  phone: null,
  last_login_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  stats: { reports: 2, lost_reports: 1, found_reports: 1, returned: 0, claims_submitted: 1, claims_pending: 0 },
};

const ADMIN = { ...USER, role: 'admin', name: 'Portal Admin', email: 'admin@saiuniversity.edu.in' };

function stubTable(role) {
  return {
    '/api/items/stats/public': { ok: true, stats: { total: 12, lost: 7, found: 5, returned: 3 }, locations: ['Central Library'] },
    '/api/items': { ok: true, items: [ITEM], page: 1, limit: 12, total: 1, pages: 1 },
    '/api/items/mine': { ok: true, items: [ITEM] },
    '/api/claims/mine': { ok: true, claims: [] },
    '/api/claims/received': { ok: true, claims: [] },
    '/api/auth/me': { ok: true, user: role === 'admin' ? ADMIN : USER },
    '/api/auth/sessions': {
      ok: true,
      sessions: [
        { id: 's1', session_id: 'x', login_at: new Date().toISOString(), logout_at: null, last_activity_at: new Date().toISOString(), status: 'active', user_agent: 'jsdom' },
      ],
      currentSessionId: 'x',
    },
    '/api/admin/overview': {
      ok: true,
      overview: { total_users: 4, verified_users: 3, unverified_users: 1, new_users_7d: 2, lost_items: 7, found_items: 5, returned_items: 3, pending_moderation: 0, total_claims: 6, pending_claims: 2, active_sessions: 2, suspended_users: 0, failed_logins_24h: 1 },
    },
    '/api/admin/users': { ok: true, users: [{ id: 'u1', name: 'Asha Rao', email: 'asha@saiuniversity.edu.in', role: 'student', status: 'active', is_email_verified: true, created_at: new Date().toISOString(), last_login_at: new Date().toISOString(), report_count: 2 }], page: 1, limit: 20, total: 1, pages: 1 },
    '/api/admin/items': { ok: true, items: [], page: 1, limit: 20, total: 0, pages: 1 },
    '/api/admin/claims': { ok: true, claims: [], page: 1, limit: 20, total: 0, pages: 1 },
    '/api/admin/sessions': { ok: true, sessions: [], page: 1, limit: 25, total: 0, pages: 1 },
    '/api/admin/auth-events': { ok: true, events: [], page: 1, limit: 25, total: 0, pages: 1 },
    '/api/admin/audit-logs': { ok: true, logs: [], page: 1, limit: 25, total: 0, pages: 1 },
  };
}

/**
 * Loads a page, runs its scripts, and records every request the page makes.
 * Returns { window, calls, errors }.
 */
function loadPage(file, { role = null, table = {}, search = '' } = {}) {
  const errors = [];
  const calls = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => errors.push('jsdomError: ' + err.message));
  virtualConsole.on('error', (msg) => errors.push('console.error: ' + msg));

  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/' + file + search,
    runScripts: 'outside-only',
    virtualConsole,
    pretendToBeVisual: true,
  });
  const w = dom.window;

  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  w.URL.createObjectURL = () => 'blob:mock';
  w.URL.revokeObjectURL = () => {};
  w.scrollTo = () => {};
  w.confirm = () => true;
  w.prompt = () => 'note';

  if (role) {
    w.localStorage.setItem('campusconnect.token', 'mock-token');
    w.localStorage.setItem('campusconnect.user', JSON.stringify(role === 'admin' ? ADMIN : USER));
  }

  const responses = { ...stubTable(role), ...table };
  w.fetch = async (url, options = {}) => {
    const full = String(url);
    const pathOnly = full.replace('http://localhost:3000', '').split('?')[0];
    calls.push({ url: pathOnly, method: options.method || 'GET', body: options.body });

    let payload = responses[pathOnly];
    if (!payload && /^\/api\/items\/[0-9a-f-]{36}$/.test(pathOnly)) payload = { ok: true, item: ITEM };
    if (!payload) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => 'application/json' },
        json: async () => ({ error: { code: 'not_found', message: 'not stubbed: ' + pathOnly } }),
      };
    }
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => payload };
  };
  w.addEventListener('error', (event) => errors.push('window.error: ' + event.message));

  for (const script of ['assets/config.js', 'assets/api.js', ...scriptsFor(file)]) {
    try {
      w.eval(fs.readFileSync(path.join(ROOT, script), 'utf8'));
    } catch (err) {
      errors.push(`${script} threw: ${err.message}`);
    }
  }
  return { window: w, calls, errors, dom };
}

function scriptsFor(file) {
  const map = {
    'index.html': ['assets/gallery.js'],
    'auth.html': ['assets/auth.js'],
    'report.html': ['assets/report.js'],
    'item.html': ['assets/item.js'],
    'dashboard.html': ['assets/dashboard.js'],
    'reset.html': ['assets/reset.js'],
    'admin/index.html': ['assets/admin.js'],
  };
  return map[file] || [];
}

const tick = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */

test('every page loads, runs its scripts and renders without errors', async () => {
  const cases = [
    ['index.html', null, '#gallery', '.item-card'],
    ['auth.html', null, '#loginForm', '#loginEmail'],
    ['report.html', 'student', '#reportForm', '#title'],
    ['item.html', 'student', '#itemRoot', '#itemRoot h1', '?id=' + ITEM.id],
    ['dashboard.html', 'student', '#panel', '.row-card'],
    ['reset.html', null, '#panelRequest', '#requestForm'],
    ['admin/index.html', 'admin', '#consoleScreen', '.metric'],
  ];

  for (const [file, role, container, inner, search] of cases) {
    const { window, errors } = loadPage(file, { role, search: search || '' });
    await tick();
    assert.deepEqual(errors, [], `${file} produced console/window errors`);
    assert.ok(window.document.querySelector(container), `${file} missing ${container}`);
    assert.ok(window.document.querySelector(inner), `${file} did not render ${inner}`);
  }
});

test('the gallery inputs are capped at the limits the API accepts', async () => {
  const { window } = loadPage('index.html');
  await tick();
  // The API rejects a search longer than 80 characters and a location longer
  // than 60; without maxlength the user gets a bare 400 with no explanation.
  assert.equal(window.document.getElementById('search').getAttribute('maxlength'), '80');
  assert.equal(window.document.getElementById('location').getAttribute('maxlength'), '60');
});

test('the gallery renders a card with the item data and no owner email', async () => {
  const { window } = loadPage('index.html');
  await tick();
  const card = window.document.querySelector('.item-card');
  assert.match(card.textContent, /Black wallet/);
  assert.match(card.textContent, /Central Library/);
  assert.ok(card.querySelector('img'), 'the photo is rendered');
  assert.doesNotMatch(window.document.body.innerHTML, /@saiuniversity\.edu\.in/);
});

test('registration submits the form values as JSON', async () => {
  const { window, calls } = loadPage('auth.html', {
    table: {
      '/api/auth/register': { ok: true, otpRequired: true, purpose: 'signup', email: 'asha@saiuniversity.edu.in', expiresInSeconds: 300, resendInSeconds: 0 },
    },
  });
  await tick();

  window.document.querySelector('[data-goto="register"]').click();
  const form = window.document.getElementById('registerForm');
  form.elements.name.value = 'Asha Rao';
  form.elements.email.value = 'asha@saiuniversity.edu.in';
  form.elements.password.value = 'CampusLife#2026';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  const call = calls.find((c) => c.url === '/api/auth/register');
  assert.ok(call, 'the register endpoint was called');
  assert.equal(call.method, 'POST');
  const body = JSON.parse(call.body);
  assert.deepEqual(body, { name: 'Asha Rao', email: 'asha@saiuniversity.edu.in', password: 'CampusLife#2026' });
  assert.equal(window.document.getElementById('panelOtp').hidden, false, 'the OTP panel is shown');
});

test('login submits credentials and switches to the OTP step', async () => {
  const { window, calls } = loadPage('auth.html', {
    table: { '/api/auth/login': { ok: true, otpRequired: true, purpose: 'login', email: 'asha@saiuniversity.edu.in', expiresInSeconds: 300, resendInSeconds: 0 } },
  });
  await tick();

  const form = window.document.getElementById('loginForm');
  form.elements.email.value = 'asha@saiuniversity.edu.in';
  form.elements.password.value = 'CampusLife#2026';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  const call = calls.find((c) => c.url === '/api/auth/login');
  assert.ok(call, 'login endpoint called');
  assert.equal(JSON.parse(call.body).email, 'asha@saiuniversity.edu.in');
  assert.equal(window.document.getElementById('panelOtp').hidden, false);
  assert.match(window.document.getElementById('otpEmail').textContent, /asha@/);
});

test('entering six digits submits the OTP and stores the session', async () => {
  const { window, calls } = loadPage('auth.html', {
    table: {
      '/api/auth/login': { ok: true, otpRequired: true, purpose: 'login', email: 'asha@saiuniversity.edu.in', expiresInSeconds: 300, resendInSeconds: 0 },
      '/api/auth/verify-otp': { ok: true, token: 'jwt-token', user: USER, session: { sessionId: 'x' } },
    },
  });
  await tick();

  const loginForm = window.document.getElementById('loginForm');
  loginForm.elements.email.value = 'asha@saiuniversity.edu.in';
  loginForm.elements.password.value = 'CampusLife#2026';
  loginForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  const digits = window.document.querySelectorAll('[data-otp]');
  assert.equal(digits.length, 6);
  '482913'.split('').forEach((d, i) => {
    digits[i].value = d;
  });
  window.document.getElementById('otpForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  const call = calls.find((c) => c.url === '/api/auth/verify-otp');
  assert.ok(call, 'verify endpoint called');
  const body = JSON.parse(call.body);
  assert.equal(body.code, '482913');
  assert.equal(body.purpose, 'login');
  assert.equal(window.localStorage.getItem('campusconnect.token'), 'jwt-token');
});

test('the report form submits multipart data including the photo', async () => {
  const { window, calls } = loadPage('report.html', { role: 'student' });
  await tick();

  const form = window.document.getElementById('reportForm');
  form.elements.title.value = 'Black wallet';
  form.elements.category.value = 'Accessories';
  form.elements.location.value = 'Central Library';
  form.elements.description.value = 'Black leather wallet with a blue sticker on the back.';
  form.elements.occurredOn.value = '2026-11-20';

  // Simulate choosing a file through the real input handler.
  const fileInput = window.document.getElementById('fileInput');
  const file = new window.File([Buffer.from('x')], 'photo.png', { type: 'image/png' });
  Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));

  assert.equal(window.document.getElementById('previewWrap').classList.contains('hidden'), false, 'preview is shown');

  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  const call = calls.find((c) => c.url === '/api/items');
  assert.ok(call, 'item create called');
  assert.equal(call.method, 'POST');
  assert.ok(call.body instanceof window.FormData, 'sent as multipart FormData');
  assert.equal(call.body.get('title'), 'Black wallet');
  assert.equal(call.body.get('type'), 'lost');
  assert.ok(call.body.get('images'), 'the image is attached');
});

test('the report form refuses an oversized file before uploading', async () => {
  const { window, calls } = loadPage('report.html', { role: 'student' });
  await tick();

  const fileInput = window.document.getElementById('fileInput');
  const big = new window.File([Buffer.alloc(6 * 1024 * 1024)], 'big.png', { type: 'image/png' });
  Object.defineProperty(fileInput, 'files', { value: [big], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));

  const alertBox = window.document.getElementById('formAlert');
  assert.equal(alertBox.hidden, false);
  assert.match(alertBox.textContent, /5 MB/);
  assert.equal(window.document.getElementById('previewWrap').classList.contains('hidden'), true);
  assert.equal(calls.filter((c) => c.url === '/api/items').length, 0);
});

test('the claim dialog submits the message and the item id', async () => {
  const { window, calls } = loadPage('item.html', { role: 'student', search: '?id=' + ITEM.id });
  await tick();

  const claimButton = window.document.getElementById('claimOpen');
  assert.ok(claimButton, 'the claim button is rendered for a found item');
  claimButton.click();

  const form = window.document.getElementById('claimForm');
  form.elements.message.value = 'It has a blue sticker and my library card inside.';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  const call = calls.find((c) => c.url === '/api/claims');
  assert.ok(call, 'claim endpoint called');
  assert.ok(call.body instanceof window.FormData);
  assert.equal(call.body.get('itemId'), ITEM.id);
  assert.match(call.body.get('message'), /blue sticker/);
});

test('the dashboard profile form saves through PATCH /api/auth/me', async () => {
  const { window, calls } = loadPage('dashboard.html', { role: 'student' });
  await tick();

  window.document.querySelector('.side-nav [data-tab="profile"]').click();
  await tick();

  const form = window.document.getElementById('profileForm');
  assert.ok(form, 'the profile form rendered');
  form.elements.name.value = 'Asha R Rao';
  form.elements.department.value = 'Computer Science';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  const call = calls.find((c) => c.url === '/api/auth/me' && c.method === 'PATCH');
  assert.ok(call, 'profile PATCH called');
  const body = JSON.parse(call.body);
  assert.equal(body.name, 'Asha R Rao');
  assert.equal(body.department, 'Computer Science');
});

test('the reset page requests a link, then sets a new password from the token', async () => {
  const token = 'a'.repeat(64);
  const { window, calls } = loadPage('reset.html', {
    search: '?token=' + token,
    table: {
      '/api/auth/reset-password': { ok: true, sessionsRevoked: 2 },
    },
  });
  await tick();

  // With a token in the URL the page opens on the "choose a password" step.
  assert.equal(window.document.getElementById('panelReset').hidden, false);
  assert.equal(window.document.getElementById('panelRequest').hidden, true);

  const form = window.document.getElementById('resetForm');
  form.elements.password.value = 'FreshStart123';
  form.elements.confirm.value = 'FreshStart123';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  const call = calls.find((c) => c.url === '/api/auth/reset-password');
  assert.ok(call, 'the reset endpoint was called');
  const body = JSON.parse(call.body);
  assert.equal(body.token, token, 'the token from the URL is sent');
  assert.equal(body.password, 'FreshStart123');
  assert.equal(window.document.getElementById('panelDone').hidden, false);
  assert.match(window.document.getElementById('doneMessage').textContent, /2 other session/);
});

test('the reset page refuses mismatched passwords before calling the API', async () => {
  const { window, calls } = loadPage('reset.html', { search: '?token=' + 'b'.repeat(64) });
  await tick();

  const form = window.document.getElementById('resetForm');
  form.elements.password.value = 'FreshStart123';
  form.elements.confirm.value = 'Different123';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  assert.equal(window.document.getElementById('resetAlert').hidden, false);
  assert.match(window.document.getElementById('resetAlert').textContent, /do not match/i);
  assert.equal(calls.filter((c) => c.url === '/api/auth/reset-password').length, 0);
});

test('the reset page requests a link when there is no token', async () => {
  const { window, calls } = loadPage('reset.html', {
    table: { '/api/auth/forgot-password': { ok: true, message: 'If that address belongs to an account, a reset link is on its way.' } },
  });
  await tick();

  const form = window.document.getElementById('requestForm');
  form.elements.email.value = 'asha@saiuniversity.edu.in';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  const call = calls.find((c) => c.url === '/api/auth/forgot-password');
  assert.ok(call);
  assert.equal(JSON.parse(call.body).email, 'asha@saiuniversity.edu.in');
  assert.equal(window.document.getElementById('requestInfo').hidden, false);
});

test('the admin console blocks a student and never renders admin data', async () => {
  const { window, calls } = loadPage('admin/index.html', { role: 'student' });
  await tick();
  assert.equal(window.document.getElementById('consoleScreen').hidden, true);
  assert.equal(window.document.getElementById('authScreen').hidden, false);
  assert.equal(calls.filter((c) => c.url.startsWith('/api/admin')).length, 0);
});

test('the admin users table labels roles and verification, not CSS class names', async () => {
  const { window } = loadPage('admin/index.html', { role: 'admin' });
  await tick();

  window.document.querySelector('.admin-side [data-section="users"]').click();
  await tick(400);

  const table = window.document.getElementById('adminPanel').textContent;
  assert.match(table, /student/i, 'the role is shown as a word');
  assert.match(table, /verified/i);
  // The bug this locks down: pill() used to rewrite the CSS class instead of the
  // label, so the table read "CLOSED"/"APPROVED" instead of the role.
  assert.doesNotMatch(table, /closed/i);
  assert.doesNotMatch(table, /approved/i);
});

test('the admin console can change the administrator password', async () => {
  const { window, calls } = loadPage('admin/index.html', {
    role: 'admin',
    table: {
      '/api/auth/change-password': { ok: true, updated: true, otherSessionsRevoked: 1 },
    },
  });
  await tick();

  window.document.querySelector('.admin-side [data-section="security"]').click();
  await tick();

  const form = window.document.getElementById('secForm');
  assert.ok(form, 'the security section rendered');

  form.elements.currentPassword.value = 'OldPassword123';
  form.elements.newPassword.value = 'NewPassword12345';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  const call = calls.find((c) => c.url === '/api/auth/change-password');
  assert.ok(call, 'change-password was called');
  assert.equal(JSON.parse(call.body).newPassword, 'NewPassword12345');
  assert.equal(window.document.getElementById('secInfo').hidden, false);
});

test('the admin console refuses a short new password before calling the API', async () => {
  const { window, calls } = loadPage('admin/index.html', { role: 'admin' });
  await tick();

  window.document.querySelector('.admin-side [data-section="security"]').click();
  await tick();

  const form = window.document.getElementById('secForm');
  form.elements.currentPassword.value = 'OldPassword123';
  form.elements.newPassword.value = 'short';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  assert.equal(window.document.getElementById('secAlert').hidden, false);
  assert.equal(calls.filter((c) => c.url === '/api/auth/change-password').length, 0);
});

test('the admin console signs an administrator in through the OTP step', async () => {
  const { window, calls } = loadPage('admin/index.html', {
    table: {
      '/api/auth/admin/login': { ok: true, otpRequired: true, purpose: 'admin_login', email: 'admin@saiuniversity.edu.in', expiresInSeconds: 300, resendInSeconds: 0 },
      '/api/auth/verify-otp': { ok: true, token: 'admin-token', user: ADMIN, session: { sessionId: 'a' } },
    },
  });
  await tick();

  const form = window.document.getElementById('adminLoginForm');
  form.elements.email.value = 'admin@saiuniversity.edu.in';
  form.elements.password.value = 'AdminPass123';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(window.document.getElementById('adminOtpPanel').hidden, false);

  const digits = window.document.querySelectorAll('[data-admin-otp]');
  '135790'.split('').forEach((d, i) => {
    digits[i].value = d;
  });
  window.document.getElementById('adminOtpForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();

  assert.equal(window.document.getElementById('consoleScreen').hidden, false, 'console opened');
  assert.ok(calls.some((c) => c.url === '/api/admin/overview'), 'overview was loaded');
  assert.match(window.document.getElementById('adminPanel').textContent, /Total users/);
});

test('the password meter follows what the user types and warns when it is too weak', async () => {
  const { window } = loadPage('auth.html');
  await tick();

  const input = window.document.getElementById('regPassword');
  const meter = window.document.querySelector('.pw-meter');
  assert.ok(meter, 'a meter is attached to the registration password field');

  input.value = 'password123';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(meter.dataset.score, '0');
  assert.match(meter.textContent, /Very weak/i);
  assert.match(meter.textContent, /Too weak to use/i);
  assert.ok(meter.querySelectorAll('.pw-meter-hints li').length > 0, 'it explains what to fix');

  input.value = 'vzpzh5g3?+8s66L*b&bd';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick();
  assert.equal(meter.dataset.score, '4');
  assert.match(meter.textContent, /Very strong/i);
  assert.match(meter.textContent, /Good to go/i);
});

test('the admin console meter uses the administrator floor', async () => {
  const { window } = loadPage('admin/index.html', { role: 'admin' });
  await tick();
  window.document.querySelector('.admin-side [data-section="security"]').click();
  await tick(400);

  const input = window.document.getElementById('secNew');
  const meter = window.document.querySelector('.pw-meter');
  assert.ok(meter, 'the admin password field has a meter');

  input.value = 'Kanth@123';   // clears the student floor, not the admin one
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick();
  assert.match(meter.textContent, /Too weak to use/i, 'admins are held to a higher floor');

  input.value = 'vzpzh5g3?+8s66L*b&bd';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick();
  assert.match(meter.textContent, /Good to go/i);
});
