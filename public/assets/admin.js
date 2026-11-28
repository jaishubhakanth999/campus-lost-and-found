/* Administrator console: OTP login + overview, users, items, claims,
   login history, security events and the audit log. */
(function () {
  'use strict';

  const { api, session, toast, escapeHtml, formatDate, formatDateTime, timeAgo, pill, setAlert, busy } = window.CC;

  const authScreen = document.getElementById('authScreen');
  const consoleScreen = document.getElementById('consoleScreen');
  const panel = document.getElementById('adminPanel');
  const sectionTitle = document.getElementById('sectionTitle');
  const sectionSub = document.getElementById('sectionSub');

  const otpInputs = Array.from(document.querySelectorAll('[data-admin-otp]'));
  const otpAlert = document.getElementById('adminOtpAlert');
  const otpInfo = document.getElementById('adminOtpInfo');
  const resendBtn = document.getElementById('adminResend');
  const state = { email: '', resendIn: 0, timer: null, section: 'overview', page: 1, query: {} };

  /* ---------------------------------- login -------------------------------- */

  document.getElementById('adminLoginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('adminLoginSubmit');
    const alertBox = document.getElementById('adminLoginAlert');
    setAlert(alertBox, '');

    const email = document.getElementById('adminEmail').value.trim();
    const password = document.getElementById('adminPassword').value;
    if (!email || !password) {
      setAlert(alertBox, 'Enter your administrator email and password.');
      return;
    }

    busy(button, true, 'Checking…');
    try {
      const data = await api('/api/auth/admin/login', { method: 'POST', body: { email, password } });
      state.email = data.email;
      document.getElementById('adminOtpEmail').textContent = data.email;
      const minutes = Math.max(1, Math.round((data.expiresInSeconds || 300) / 60));
      document.getElementById('adminOtpExpiry').textContent = minutes + ' minutes';
      setAlert(otpInfo, data.emailSent === false ? 'Code created, but the email could not be sent. Check the server mail settings.' : 'Code sent to your inbox.', data.emailSent === false ? 'info' : 'success');
      document.getElementById('adminLoginPanel').hidden = true;
      document.getElementById('adminOtpPanel').hidden = false;
      otpInputs.forEach((i) => (i.value = ''));
      otpInputs[0].focus();
      startCountdown(data.resendInSeconds || 60);
    } catch (err) {
      setAlert(alertBox, err.message);
    } finally {
      busy(button, false);
    }
  });

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

  otpInputs.forEach((input, index) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 1);
      if (input.value && index < otpInputs.length - 1) otpInputs[index + 1].focus();
      if (otpInputs.every((el) => el.value)) document.getElementById('adminOtpForm').requestSubmit();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace' && !input.value && index > 0) otpInputs[index - 1].focus();
    });
    input.addEventListener('paste', (event) => {
      const text = (event.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
      if (!text) return;
      event.preventDefault();
      text.slice(0, 6).split('').forEach((d, i) => { if (otpInputs[i]) otpInputs[i].value = d; });
      if (otpInputs.every((el) => el.value)) document.getElementById('adminOtpForm').requestSubmit();
    });
  });

  document.getElementById('adminOtpForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('adminOtpSubmit');
    const code = otpInputs.map((i) => i.value).join('');
    setAlert(otpAlert, '');
    if (!/^\d{6}$/.test(code)) {
      setAlert(otpAlert, 'Enter all six digits.');
      return;
    }
    busy(button, true, 'Verifying…');
    try {
      const data = await api('/api/auth/verify-otp', {
        method: 'POST',
        body: { email: state.email, code, purpose: 'admin_login' },
        allowUnauthorized: true,
      });
      if (data.user.role !== 'admin') {
        session.clear();
        setAlert(otpAlert, 'This account does not have administrator access.');
        return;
      }
      session.set(data.token, data.user);
      toast('Welcome, ' + data.user.name, 'success');
      openConsole();
    } catch (err) {
      setAlert(otpAlert, err.message);
      otpInputs.forEach((i) => (i.value = ''));
      otpInputs[0].focus();
    } finally {
      busy(button, false);
    }
  });

  resendBtn.addEventListener('click', async () => {
    try {
      const data = await api('/api/auth/resend-otp', {
        method: 'POST',
        body: { email: state.email, purpose: 'admin_login' },
      });
      setAlert(otpInfo, 'A new code is on its way.', 'success');
      startCountdown(data.resendInSeconds || 60);
    } catch (err) {
      setAlert(otpAlert, err.message);
    }
  });

  document.getElementById('adminBack').addEventListener('click', () => {
    document.getElementById('adminLoginPanel').hidden = false;
    document.getElementById('adminOtpPanel').hidden = true;
    if (state.timer) clearInterval(state.timer);
  });

  document.querySelector('[data-admin-logout]').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', allowUnauthorized: true });
    } catch (err) { /* ignore */ }
    session.clear();
    location.reload();
  });

  /* -------------------------------- sections -------------------------------- */

  function openConsole() {
    authScreen.hidden = true;
    consoleScreen.hidden = false;
    document.getElementById('adminWho').textContent = session.user.email;
    show('overview');
  }

  const sections = {
    overview: { title: 'Overview', sub: 'Platform health at a glance', render: renderOverview },
    users: { title: 'Users', sub: 'Every registered account', render: renderUsers },
    items: { title: 'Lost & found', sub: 'All reports, including moderated ones', render: renderItems },
    claims: { title: 'Claims', sub: 'Monitor and resolve claim disputes', render: renderClaims },
    sessions: { title: 'Login history', sub: 'Sign-ins, sign-outs and session status', render: renderSessions },
    events: { title: 'Security events', sub: 'Failed logins, OTP outcomes, suspensions', render: renderEvents },
    audit: { title: 'Audit log', sub: 'Every privileged action, with actor and time', render: renderAudit },
    security: { title: 'Security', sub: 'Your administrator password and active sessions', render: renderSecurity },
  };

  async function show(section, page) {
    state.section = section;
    state.page = page || 1;
    document.querySelectorAll('.admin-side [data-section]').forEach((btn) =>
      btn.setAttribute('aria-current', String(btn.dataset.section === section))
    );
    sectionTitle.textContent = sections[section].title;
    sectionSub.textContent = sections[section].sub;
    panel.innerHTML = '<div class="skeleton" style="height:180px;"></div>';
    try {
      await sections[section].render(state.page);

      // Pager buttons exist only after the render above, so bind them here.
      panel.querySelectorAll('.pager [data-page]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!btn.disabled) show(section, Number(btn.dataset.page));
        });
      });
    } catch (err) {
      panel.innerHTML =
        '<div class="empty-state"><div class="icon">⚠️</div><h3>Could not load this section</h3>' +
        '<p>' + escapeHtml(err.message) + '</p><button class="btn btn-primary" data-retry>Try again</button></div>';
      const retry = panel.querySelector('[data-retry]');
      if (retry) retry.addEventListener('click', () => show(section, state.page));
    }
  }

  document.querySelectorAll('.admin-side [data-section]').forEach((btn) =>
    btn.addEventListener('click', () => show(btn.dataset.section))
  );

  /**
   * Pagination markup only. The click handlers are attached by show() *after*
   * the markup is inserted — building a detached node, adding listeners and
   * then serialising it with outerHTML silently threw the listeners away.
   */
  function pager(data) {
    if (!data || data.pages <= 1) return '';
    return (
      '<div class="pager">' +
        '<button class="btn btn-ghost btn-sm" data-page="' + (data.page - 1) + '"' + (data.page > 1 ? '' : ' disabled') + '>← Previous</button>' +
        '<span class="muted">Page ' + data.page + ' of ' + data.pages + ' · ' + data.total + ' total</span>' +
        '<button class="btn btn-ghost btn-sm" data-page="' + (data.page + 1) + '"' + (data.page < data.pages ? '' : ' disabled') + '>Next →</button>' +
      '</div>'
    );
  }

  /* -------------------------------- overview -------------------------------- */

  async function renderOverview() {
    const { overview } = await api('/api/admin/overview');
    const metric = (label, value) => '<div class="metric"><strong>' + value + '</strong><span>' + label + '</span></div>';
    panel.innerHTML =
      '<div class="metric-grid">' +
        metric('Total users', overview.total_users) +
        metric('Verified', overview.verified_users) +
        metric('Unverified', overview.unverified_users) +
        metric('New (7 days)', overview.new_users_7d) +
        metric('Lost reports', overview.lost_items) +
        metric('Found reports', overview.found_items) +
        metric('Returned items', overview.returned_items) +
        metric('Total claims', overview.total_claims) +
        metric('Pending claims', overview.pending_claims) +
        metric('Active sessions', overview.active_sessions) +
        metric('Suspended', overview.suspended_users) +
        metric('Failed logins (24h)', overview.failed_logins_24h) +
      '</div>' +
      '<div class="card" style="margin-top:1.25rem;">' +
        '<h2 style="font-size:1.05rem;">Needs attention</h2>' +
        '<ul style="margin:.5rem 0 0;padding-left:1.1rem;line-height:1.9;">' +
          '<li>' + overview.pending_claims + ' pending claim(s) awaiting a decision</li>' +
          '<li>' + overview.pending_moderation + ' listing(s) awaiting moderation</li>' +
          '<li>' + overview.unverified_users + ' account(s) never completed email verification</li>' +
          '<li>' + overview.failed_logins_24h + ' failed sign-in attempt(s) in the last 24 hours</li>' +
        '</ul>' +
      '</div>';
  }

  /* ---------------------------------- users --------------------------------- */

  async function renderUsers(page) {
    const search = state.query.userSearch || '';
    const { users, total, pages, page: current } = await api(
      '/api/admin/users?page=' + page + '&limit=20&search=' + encodeURIComponent(search)
    );

    panel.innerHTML =
      '<div class="row" style="margin-bottom:1rem;">' +
        '<input id="userSearch" type="search" placeholder="Search name or email" value="' + escapeHtml(search) + '" style="max-width:320px;">' +
        '<button class="btn btn-dark btn-sm" id="userSearchBtn">Search</button>' +
      '</div>' +
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>Name</th><th>Email</th><th>Role</th><th>Verified</th><th>Status</th><th>Registered</th><th>Last login</th><th></th>' +
      '</tr></thead><tbody>' +
      (users.length
        ? users.map((u) =>
            '<tr>' +
              '<td>' + escapeHtml(u.name) + (u.report_count ? '<br><small class="muted">' + u.report_count + ' report(s)</small>' : '') + '</td>' +
              '<td>' + escapeHtml(u.email) + '</td>' +
              '<td>' + pill(u.role === 'admin' ? 'role-admin' : 'role-student', u.role) + '</td>' +
              '<td>' + (u.is_email_verified ? pill('success', 'verified') : pill('failure', 'unverified')) + '</td>' +
              '<td>' + pill(u.status) + '</td>' +
              '<td><small>' + formatDate(u.created_at) + '</small></td>' +
              '<td><small>' + (u.last_login_at ? timeAgo(u.last_login_at) : 'never') + '</small></td>' +
              '<td class="row-actions">' +
                (u.status === 'active'
                  ? '<button class="btn btn-ghost btn-sm" data-suspend="' + u.id + '">Suspend</button>'
                  : '<button class="btn btn-ghost btn-sm" data-activate="' + u.id + '">Reactivate</button>') +
                (u.role === 'student' ? '<button class="btn btn-ghost btn-sm" data-promote="' + u.id + '">Make admin</button>' : '') +
              '</td>' +
            '</tr>'
          ).join('')
        : '<tr><td colspan="8" class="center muted">No accounts match that search.</td></tr>') +
      '</tbody></table></div>' +
      pager({ page: current, pages, total });

    const doSearch = () => {
      state.query.userSearch = document.getElementById('userSearch').value.trim();
      show('users', 1);
    };
    document.getElementById('userSearchBtn').addEventListener('click', doSearch);
    document.getElementById('userSearch').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSearch();
    });

    const patchUser = async (id, body, label) => {
      if (!confirm(label)) return;
      try {
        await api('/api/admin/users/' + id, { method: 'PATCH', body });
        toast('User updated', 'success');
        show('users', page);
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    panel.querySelectorAll('[data-suspend]').forEach((b) =>
      b.addEventListener('click', () => patchUser(b.dataset.suspend, { status: 'suspended' }, 'Suspend this account and sign out all its sessions?'))
    );
    panel.querySelectorAll('[data-activate]').forEach((b) =>
      b.addEventListener('click', () => patchUser(b.dataset.activate, { status: 'active' }, 'Reactivate this account?'))
    );
    panel.querySelectorAll('[data-promote]').forEach((b) =>
      b.addEventListener('click', () => patchUser(b.dataset.promote, { role: 'admin' }, 'Give this account administrator access?'))
    );
  }

  /* ---------------------------------- items --------------------------------- */

  async function renderItems(page) {
    const { items, total, pages, page: current } = await api('/api/admin/items?page=' + page + '&limit=20');
    panel.innerHTML =
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>Item</th><th>Type</th><th>Owner</th><th>Status</th><th>Moderation</th><th>Claims</th><th>Reported</th><th></th>' +
      '</tr></thead><tbody>' +
      (items.length
        ? items.map((i) =>
            '<tr>' +
              '<td><a href="../item.html?id=' + encodeURIComponent(i.id) + '">' + escapeHtml(i.title) + '</a><br><small class="muted">' + escapeHtml(i.location) + ' · ' + escapeHtml(i.category) + '</small></td>' +
              '<td>' + pill(i.type) + '</td>' +
              '<td><small>' + escapeHtml(i.owner_name) + '<br>' + escapeHtml(i.owner_email) + '</small></td>' +
              '<td>' + pill(i.status) + '</td>' +
              '<td>' + pill(i.moderation_status) + '</td>' +
              '<td>' + i.claim_count + '</td>' +
              '<td><small>' + formatDate(i.created_at) + '</small></td>' +
              '<td class="row-actions">' +
                (i.moderation_status !== 'approved'
                  ? '<button class="btn btn-ghost btn-sm" data-moderate="restore" data-id="' + i.id + '">Restore</button>'
                  : '<button class="btn btn-danger btn-sm" data-moderate="remove" data-id="' + i.id + '">Remove</button>') +
              '</td>' +
            '</tr>'
          ).join('')
        : '<tr><td colspan="8" class="center muted">No listings yet.</td></tr>') +
      '</tbody></table></div>' +
      pager({ page: current, pages, total });

    panel.querySelectorAll('[data-moderate]').forEach((b) =>
      b.addEventListener('click', async () => {
        const action = b.dataset.moderate;
        const note = action === 'remove' ? prompt('Reason for removal (recorded in the audit log):') || '' : '';
        if (action === 'remove' && !confirm('Remove this listing from the public gallery?')) return;
        try {
          await api('/api/admin/items/' + b.dataset.id + '/moderate', {
            method: 'PATCH',
            body: { action, note: note || undefined },
          });
          toast('Listing ' + action + 'd', 'success');
          show('items', page);
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );
  }

  /* --------------------------------- claims --------------------------------- */

  async function renderClaims(page) {
    const { claims, total, pages, page: current } = await api('/api/admin/claims?page=' + page + '&limit=20');
    panel.innerHTML =
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>Item</th><th>Claimant</th><th>Message</th><th>Status</th><th>Created</th><th></th>' +
      '</tr></thead><tbody>' +
      (claims.length
        ? claims.map((c) =>
            '<tr>' +
              '<td><a href="../item.html?id=' + encodeURIComponent(c.item_id) + '">' + escapeHtml(c.item_title) + '</a><br><small class="muted">' + escapeHtml(c.item_type) + ' · owner ' + escapeHtml(c.owner_name) + '</small></td>' +
              '<td><small>' + escapeHtml(c.claimant_name) + '<br>' + escapeHtml(c.claimant_email) + '</small></td>' +
              '<td><small>' + escapeHtml(String(c.message).slice(0, 160)) + '</small></td>' +
              '<td>' + pill(c.status) + '</td>' +
              '<td><small>' + formatDate(c.created_at) + '</small></td>' +
              '<td class="row-actions">' +
                (c.status === 'pending'
                  ? '<button class="btn btn-primary btn-sm" data-decide="approved" data-id="' + c.id + '">Approve</button>' +
                    '<button class="btn btn-ghost btn-sm" data-decide="rejected" data-id="' + c.id + '">Reject</button>'
                  : '') +
              '</td>' +
            '</tr>'
          ).join('')
        : '<tr><td colspan="6" class="center muted">No claims yet.</td></tr>') +
      '</tbody></table></div>' +
      pager({ page: current, pages, total });

    panel.querySelectorAll('[data-decide]').forEach((b) =>
      b.addEventListener('click', async () => {
        const decision = b.dataset.decide;
        const note = prompt('Note for the record (visible to the claimant):') || '';
        if (!confirm('Record this decision as an administrator?')) return;
        try {
          await api('/api/admin/claims/' + b.dataset.id + '/decision', {
            method: 'PATCH',
            body: { decision, note: note || undefined },
          });
          toast('Claim ' + decision, 'success');
          show('claims', page);
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );
  }

  /* -------------------------------- sessions -------------------------------- */

  async function renderSessions(page) {
    const { sessions, total, pages, page: current } = await api('/api/admin/sessions?page=' + page + '&limit=25');
    panel.innerHTML =
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>User</th><th>Email</th><th>Signed in</th><th>Signed out</th><th>Status</th><th>Last active</th><th>IP</th><th></th>' +
      '</tr></thead><tbody>' +
      (sessions.length
        ? sessions.map((s) =>
            '<tr>' +
              '<td>' + escapeHtml(s.user_name) + '</td>' +
              '<td><small>' + escapeHtml(s.email) + '</small></td>' +
              '<td><small>' + formatDateTime(s.login_at) + '</small></td>' +
              '<td><small>' + (s.logout_at ? formatDateTime(s.logout_at) : '—') + '</small></td>' +
              '<td>' + pill(s.status) + '</td>' +
              '<td><small>' + timeAgo(s.last_activity_at) + '</small></td>' +
              '<td><small>' + escapeHtml(s.ip || '—') + '</small></td>' +
              '<td>' + (s.status === 'active' ? '<button class="btn btn-ghost btn-sm" data-revoke="' + s.id + '">Revoke</button>' : '') + '</td>' +
            '</tr>'
          ).join('')
        : '<tr><td colspan="8" class="center muted">No sessions recorded.</td></tr>') +
      '</tbody></table></div>' +
      pager({ page: current, pages, total });

    panel.querySelectorAll('[data-revoke]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Revoke this session? The device will be signed out immediately.')) return;
        try {
          await api('/api/admin/sessions/' + b.dataset.revoke + '/revoke', { method: 'PATCH' });
          toast('Session revoked', 'success');
          show('sessions', page);
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );
  }

  /* --------------------------------- events --------------------------------- */

  async function renderEvents(page) {
    const { events, total, pages, page: current } = await api('/api/admin/auth-events?page=' + page + '&limit=25');
    panel.innerHTML =
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>When</th><th>Event</th><th>Outcome</th><th>Email</th><th>Reason</th><th>IP</th>' +
      '</tr></thead><tbody>' +
      (events.length
        ? events.map((e) =>
            '<tr>' +
              '<td><small>' + formatDateTime(e.created_at) + '</small></td>' +
              '<td><code style="font-size:.8rem;">' + escapeHtml(e.event) + '</code></td>' +
              '<td>' + pill(e.outcome, e.outcome) + '</td>' +
              '<td><small>' + escapeHtml(e.email || '—') + '</small></td>' +
              '<td><small>' + escapeHtml(e.reason || '—') + '</small></td>' +
              '<td><small>' + escapeHtml(e.ip || '—') + '</small></td>' +
            '</tr>'
          ).join('')
        : '<tr><td colspan="6" class="center muted">No events recorded.</td></tr>') +
      '</tbody></table></div>' +
      pager({ page: current, pages, total });
  }

  /* ---------------------------------- audit --------------------------------- */

  async function renderAudit(page) {
    const { logs, total, pages, page: current } = await api('/api/admin/audit-logs?page=' + page + '&limit=25');
    panel.innerHTML =
      '<div class="table-wrap"><table><thead><tr>' +
        '<th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Details</th>' +
      '</tr></thead><tbody>' +
      (logs.length
        ? logs.map((l) =>
            '<tr>' +
              '<td><small>' + formatDateTime(l.created_at) + '</small></td>' +
              '<td><small>' + escapeHtml(l.actor_email || 'system') + '</small></td>' +
              '<td><code style="font-size:.8rem;">' + escapeHtml(l.action) + '</code></td>' +
              '<td><small>' + escapeHtml(l.target_type || '—') + (l.target_id ? '<br>' + escapeHtml(String(l.target_id).slice(0, 8)) : '') + '</small></td>' +
              '<td><small>' + escapeHtml(JSON.stringify(l.details || {}).slice(0, 120)) + '</small></td>' +
            '</tr>'
          ).join('')
        : '<tr><td colspan="5" class="center muted">No privileged actions recorded yet.</td></tr>') +
      '</tbody></table></div>' +
      pager({ page: current, pages, total });
  }

  /* -------------------------------- security ------------------------------- */

  async function renderSecurity() {
    panel.innerHTML =
      '<div class="card" style="max-width:560px;">' +
        '<h2 style="font-size:1.05rem;">Change your password</h2>' +
        '<p class="muted" style="font-size:.9rem;">Use at least 12 characters with a letter and a number. Every other session is signed out when you change it.</p>' +
        '<div class="form-alert error" id="secAlert" hidden></div>' +
        '<div class="form-alert success" id="secInfo" hidden></div>' +
        '<form id="secForm">' +
          '<div class="field"><label for="secCurrent">Current password</label>' +
            '<input id="secCurrent" name="currentPassword" type="password" required autocomplete="current-password"></div>' +
          '<div class="field"><label for="secNew">New password</label>' +
            '<input id="secNew" name="newPassword" type="password" required minlength="12" autocomplete="new-password">' +
            '<span class="hint">Administrator passwords must be strong.</span></div>' +
          '<button class="btn btn-primary" type="submit" id="secSubmit">Update password</button>' +
        '</form>' +
      '</div>' +
      '<div class="card" style="max-width:560px;margin-top:1rem;">' +
        '<h2 style="font-size:1.05rem;">Your sessions</h2>' +
        '<p class="muted" style="font-size:.9rem;">Sign-ins for your own account. Revoke anything you do not recognise.</p>' +
        '<div id="secSessions"><div class="skeleton" style="height:80px;"></div></div>' +
      '</div>';

    window.CC.attachPasswordMeter(document.getElementById('secNew'), { role: 'admin' });

    const form = document.getElementById('secForm');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = document.getElementById('secSubmit');
      const alertBox = document.getElementById('secAlert');
      const info = document.getElementById('secInfo');
      setAlert(alertBox, '');
      setAlert(info, '');

      const currentPassword = form.elements.currentPassword.value;
      const newPassword = form.elements.newPassword.value;
      if (newPassword.length < 12) {
        setAlert(alertBox, 'Use at least 12 characters.');
        return;
      }

      busy(button, true, 'Updating…');
      try {
        const res = await api('/api/auth/change-password', {
          method: 'POST',
          body: { currentPassword, newPassword },
        });
        setAlert(
          info,
          'Password updated. ' + res.otherSessionsRevoked + ' other session(s) were signed out.',
          'success'
        );
        form.reset();
      } catch (err) {
        setAlert(alertBox, err.message);
      } finally {
        busy(button, false);
      }
    });

    try {
      const { sessions, currentSessionId } = await api('/api/auth/sessions');
      document.getElementById('secSessions').innerHTML =
        '<div class="table-wrap"><table><thead><tr><th>Signed in</th><th>Status</th><th>Last active</th></tr></thead><tbody>' +
        sessions
          .slice(0, 10)
          .map(
            (s) =>
              '<tr><td><small>' + formatDateTime(s.login_at) + '</small></td>' +
              '<td>' + pill(s.status) + (s.session_id === currentSessionId ? ' <small class="muted">this device</small>' : '') + '</td>' +
              '<td><small>' + timeAgo(s.last_activity_at) + '</small></td></tr>'
          )
          .join('') +
        '</tbody></table></div>';
    } catch (err) {
      document.getElementById('secSessions').textContent = 'Could not load sessions: ' + err.message;
    }
  }

  /* --------------------------------- boot ---------------------------------- */

  if (session.token && session.isAdmin) {
    api('/api/auth/me', { allowUnauthorized: true })
      .then((res) => {
        if (res.user.role !== 'admin') {
          session.clear();
          return;
        }
        session.set(null, res.user);
        openConsole();
      })
      .catch(() => session.clear());
  }
})();
