/* Student dashboard: reports, claims, received claims, login history, profile. */
(function () {
  'use strict';

  const { api, session, toast, escapeHtml, formatDate, formatDateTime, timeAgo, pill, requireSession, setAlert, busy, applyFieldErrors } = window.CC;

  if (!requireSession()) return;

  const panel = document.getElementById('panel');
  const overviewEl = document.getElementById('overview');
  const greeting = document.getElementById('greeting');
  let currentTab = 'reports';

  const empty = (title, body, cta) =>
    '<div class="empty-state"><div class="icon" aria-hidden="true">🗂</div><h3>' + escapeHtml(title) + '</h3>' +
    '<p>' + escapeHtml(body) + '</p>' + (cta || '') + '</div>';

  async function loadOverview() {
    try {
      const { user } = await api('/api/auth/me');
      session.set(null, user);
      greeting.textContent = 'Signed in as ' + user.email + ' · member since ' + formatDate(user.created_at);
      const s = user.stats;
      overviewEl.innerHTML = [
        ['My reports', s.reports],
        ['Lost reports', s.lost_reports],
        ['Found reports', s.found_reports],
        ['Reunited', s.returned],
        ['Claims I sent', s.claims_submitted],
        ['Claims to review', s.claims_pending],
      ]
        .map(([label, value]) => '<div class="metric"><strong>' + value + '</strong><span>' + label + '</span></div>')
        .join('');
    } catch (err) {
      greeting.textContent = 'We could not load your profile: ' + err.message;
    }
  }

  /* ------------------------------- my reports ------------------------------ */

  async function renderReports() {
    panel.innerHTML = '<div class="skeleton" style="height:140px;"></div>';
    const { items } = await api('/api/items/mine');
    if (!items.length) {
      panel.innerHTML =
        '<h2 style="font-size:1.2rem;">My reports</h2>' +
        empty('You have not reported anything yet', 'Report a lost or found item and it will appear here.',
          '<a class="btn btn-primary" href="report.html">Report an item</a>');
      return;
    }
    panel.innerHTML =
      '<h2 style="font-size:1.2rem;">My reports (' + items.length + ')</h2>' +
      items.map((item) =>
        '<div class="row-card">' +
          '<div class="row-main">' +
            '<h4><a href="item.html?id=' + encodeURIComponent(item.id) + '">' + escapeHtml(item.title) + '</a></h4>' +
            '<small class="muted">' + escapeHtml(item.type) + ' · ' + escapeHtml(item.category) + ' · ' + escapeHtml(item.location) + ' · ' + formatDate(item.occurredOn) + '</small>' +
            (item.claimCount ? '<div style="margin-top:.35rem;"><span class="pill pending">' + item.claimCount + ' pending claim' + (item.claimCount === 1 ? '' : 's') + '</span></div>' : '') +
          '</div>' +
          '<div class="row-actions">' + pill(item.status) +
            '<a class="btn btn-ghost btn-sm" href="item.html?id=' + encodeURIComponent(item.id) + '">Manage</a>' +
          '</div>' +
        '</div>'
      ).join('');
  }

  /* -------------------------------- my claims ------------------------------ */

  async function renderClaims() {
    panel.innerHTML = '<div class="skeleton" style="height:140px;"></div>';
    const { claims } = await api('/api/claims/mine');
    if (!claims.length) {
      panel.innerHTML =
        '<h2 style="font-size:1.2rem;">My claims</h2>' +
        empty('No claims yet', 'Found something that belongs to you? Open the listing and describe a detail only the owner would know.',
          '<a class="btn btn-primary" href="index.html#found">Browse found items</a>');
      return;
    }
    panel.innerHTML =
      '<h2 style="font-size:1.2rem;">Claims I submitted</h2>' +
      claims.map((claim) =>
        '<div class="row-card">' +
          '<div class="row-main">' +
            '<h4><a href="item.html?id=' + encodeURIComponent(claim.itemId) + '">' + escapeHtml(claim.itemTitle) + '</a> ' + pill(claim.status) + '</h4>' +
            '<p style="margin:.35rem 0;font-size:.92rem;">“' + escapeHtml(claim.message) + '”</p>' +
            (claim.decisionNote ? '<small class="muted">Owner note: ' + escapeHtml(claim.decisionNote) + '</small><br>' : '') +
            '<small class="muted">Submitted ' + formatDateTime(claim.createdAt) + '</small>' +
            (claim.status === 'approved'
              ? '<div class="form-alert success" style="margin:.6rem 0 0;font-size:.85rem;">Approved — arrange the handover with ' + escapeHtml(claim.owner.name) + ' and confirm once you have the item.</div>'
              : '') +
          '</div>' +
          '<div class="row-actions">' +
            (claim.status === 'pending' ? '<button class="btn btn-ghost btn-sm" data-withdraw="' + claim.id + '">Withdraw</button>' : '') +
            (claim.status === 'approved' ? '<button class="btn btn-primary btn-sm" data-complete="' + claim.id + '">I have the item</button>' : '') +
          '</div>' +
        '</div>'
      ).join('');

    panel.querySelectorAll('[data-withdraw]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!confirm('Withdraw this claim?')) return;
        try {
          await api('/api/claims/' + btn.dataset.withdraw + '/withdraw', { method: 'PATCH' });
          toast('Claim withdrawn', 'success');
          renderClaims();
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );

    panel.querySelectorAll('[data-complete]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!confirm('Confirm you have received the item? This marks it returned.')) return;
        try {
          await api('/api/claims/' + btn.dataset.complete + '/complete', { method: 'PATCH' });
          toast('Item confirmed — thank you', 'success');
          renderClaims();
          loadOverview();
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );
  }

  /* ------------------------------ claims received -------------------------- */

  async function renderReceived() {
    panel.innerHTML = '<div class="skeleton" style="height:140px;"></div>';
    const { claims } = await api('/api/claims/received');
    if (!claims.length) {
      panel.innerHTML =
        '<h2 style="font-size:1.2rem;">Claims received</h2>' +
        empty('Nobody has claimed your listings yet', 'When someone claims an item you reported, their message and identity appear here.');
      return;
    }
    panel.innerHTML =
      '<h2 style="font-size:1.2rem;">Claims on my listings</h2>' +
      claims.map((claim) =>
        '<div class="row-card" style="flex-direction:column;align-items:stretch;">' +
          '<div class="spread">' +
            '<h4 style="margin:0;"><a href="item.html?id=' + encodeURIComponent(claim.itemId) + '">' + escapeHtml(claim.itemTitle) + '</a> ' + pill(claim.status) + '</h4>' +
            '<small class="muted">' + formatDateTime(claim.createdAt) + '</small>' +
          '</div>' +
          '<div style="background:var(--cream);border-left:3px solid var(--green);border-radius:8px;padding:.7rem .9rem;margin:.6rem 0;">' +
            '<strong style="font-size:.85rem;">' + escapeHtml(claim.claimant.name) + '</strong>' +
            (claim.claimant.email ? ' <small class="muted">' + escapeHtml(claim.claimant.email) + '</small>' : '') +
            '<p style="margin:.35rem 0 0;font-size:.92rem;">“' + escapeHtml(claim.message) + '”</p>' +
            (claim.evidence && claim.evidence.length
              ? '<div class="row" style="gap:.4rem;margin-top:.5rem;" data-evidence="' + claim.id + '"><small class="muted">Loading evidence…</small></div>'
              : '') +
          '</div>' +
          (claim.status === 'pending'
            ? '<div class="row" style="justify-content:flex-end;">' +
                '<button class="btn btn-primary btn-sm" data-decide="approved" data-claim="' + claim.id + '">Approve claim</button>' +
                '<button class="btn btn-ghost btn-sm" data-decide="rejected" data-claim="' + claim.id + '">Reject</button>' +
              '</div>'
            : '') +
          (claim.status === 'approved'
            ? '<div class="row" style="justify-content:flex-end;">' +
                '<button class="btn btn-ghost btn-sm" data-handover="' + claim.id + '">Arrange handover</button>' +
                '<button class="btn btn-primary btn-sm" data-complete="' + claim.id + '">Confirm returned</button>' +
              '</div>'
            : '') +
        '</div>'
      ).join('');

    // Evidence thumbnails (private, fetched through short-lived links).
    panel.querySelectorAll('[data-evidence]').forEach(async (host) => {
      try {
        const { links } = await api('/api/claims/' + host.dataset.evidence + '/evidence');
        host.innerHTML = links
          .map((l) => '<a href="' + escapeHtml(l.url) + '" target="_blank" rel="noopener"><img src="' + escapeHtml(l.url) + '" alt="Claim evidence" style="width:72px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--line);"></a>')
          .join('');
      } catch (err) {
        host.textContent = '';
      }
    });

    panel.querySelectorAll('[data-decide]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const decision = btn.dataset.decide;
        const note = decision === 'rejected'
          ? prompt('Optional note for the claimant (they will see this):') || ''
          : '';
        if (decision === 'approved' && !confirm('Approve this claim? Other pending claims will be rejected and the item becomes “claimed”.')) return;
        try {
          await api('/api/claims/' + btn.dataset.claim + '/decision', {
            method: 'PATCH',
            body: { decision, note: note || undefined },
          });
          toast('Claim ' + decision, 'success');
          renderReceived();
          loadOverview();
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );

    panel.querySelectorAll('[data-handover]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const place = prompt('Where will you hand it over? (e.g. Library front desk)');
        if (!place) return;
        try {
          await api('/api/claims/' + btn.dataset.handover + '/handover', {
            method: 'PATCH',
            body: { place },
          });
          toast('Handover details sent to the claimant', 'success');
          renderReceived();
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );

    panel.querySelectorAll('[data-complete]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!confirm('Confirm the item has been returned?')) return;
        try {
          await api('/api/claims/' + btn.dataset.complete + '/complete', { method: 'PATCH' });
          toast('Marked as returned', 'success');
          renderReceived();
          loadOverview();
        } catch (err) {
          toast(err.message, 'error');
        }
      })
    );
  }

  /* ------------------------------ login activity --------------------------- */

  async function renderSessions() {
    panel.innerHTML = '<div class="skeleton" style="height:140px;"></div>';
    const { sessions, currentSessionId } = await api('/api/auth/sessions');
    panel.innerHTML =
      '<h2 style="font-size:1.2rem;">Login activity</h2>' +
      '<p class="muted" style="font-size:.9rem;">Every sign-in is recorded with a timestamp. Closing a tab does not sign you out — sessions expire automatically after the configured lifetime.</p>' +
      '<div class="table-wrap"><table><thead><tr><th>Signed in</th><th>Signed out</th><th>Status</th><th>Last active</th><th>Device</th></tr></thead><tbody>' +
      sessions.map((s) =>
        '<tr>' +
          '<td>' + formatDateTime(s.login_at) + '</td>' +
          '<td>' + (s.logout_at ? formatDateTime(s.logout_at) : '—') + '</td>' +
          '<td>' + pill(s.status) + (s.session_id === currentSessionId ? ' <small class="muted">this device</small>' : '') + '</td>' +
          '<td>' + timeAgo(s.last_activity_at) + '</td>' +
          '<td><small class="muted">' + escapeHtml(String(s.user_agent || '').slice(0, 48) || '—') + '</small></td>' +
        '</tr>'
      ).join('') +
      '</tbody></table></div>';
  }

  /* --------------------------------- profile ------------------------------- */

  async function renderProfile() {
    const { user } = await api('/api/auth/me');
    panel.innerHTML =
      '<h2 style="font-size:1.2rem;">Profile settings</h2>' +
      '<p class="muted" style="font-size:.9rem;">Your university email cannot be changed here — it is the identity your account was verified with.</p>' +
      '<div class="form-alert error" id="profileAlert" hidden></div>' +
      '<div class="form-alert success" id="profileInfo" hidden></div>' +
      '<form id="profileForm" style="max-width:460px;">' +
        '<div class="field"><label for="pName">Full name</label><input id="pName" name="name" type="text" value="' + escapeHtml(user.name) + '" maxlength="80" required></div>' +
        '<div class="field"><label for="pEmail">University email</label><input id="pEmail" type="email" value="' + escapeHtml(user.email) + '" disabled></div>' +
        '<div class="field"><label for="pStudentId">Student ID <span class="hint" style="display:inline;">(optional)</span></label><input id="pStudentId" name="studentId" type="text" value="' + escapeHtml(user.student_id || '') + '" maxlength="40"></div>' +
        '<div class="field"><label for="pDept">Department <span class="hint" style="display:inline;">(optional)</span></label><input id="pDept" name="department" type="text" value="' + escapeHtml(user.department || '') + '" maxlength="80"></div>' +
        '<div class="field"><label for="pPhone">Phone <span class="hint" style="display:inline;">(optional, shown only to people you approve)</span></label><input id="pPhone" name="phone" type="tel" value="' + escapeHtml(user.phone || '') + '" maxlength="20"></div>' +
        '<button class="btn btn-primary" type="submit" id="profileSubmit">Save profile</button>' +
      '</form>' +
      '<hr style="border:0;border-top:1px solid var(--line);margin:1.5rem 0;">' +
      '<h3 style="font-size:1.05rem;">Change password</h3>' +
      '<div class="form-alert error" id="pwAlert" hidden></div>' +
      '<form id="pwForm" style="max-width:460px;">' +
        '<div class="field"><label for="curPw">Current password</label><input id="curPw" name="currentPassword" type="password" required autocomplete="current-password"></div>' +
        '<div class="field"><label for="newPw">New password</label><input id="newPw" name="newPassword" type="password" required minlength="8" autocomplete="new-password"><span class="hint">At least 8 characters with a letter and a number. Other devices will be signed out.</span></div>' +
        '<button class="btn btn-dark" type="submit" id="pwSubmit">Update password</button>' +
      '</form>';

    const profileForm = document.getElementById('profileForm');
    profileForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const btn = document.getElementById('profileSubmit');
      const alertBox = document.getElementById('profileAlert');
      const info = document.getElementById('profileInfo');
      setAlert(alertBox, '');
      setAlert(info, '');
      busy(btn, true, 'Saving…');
      try {
        const res = await api('/api/auth/me', {
          method: 'PATCH',
          body: {
            name: profileForm.elements.name.value.trim(),
            studentId: profileForm.elements.studentId.value.trim(),
            department: profileForm.elements.department.value.trim(),
            phone: profileForm.elements.phone.value.trim(),
          },
        });
        session.set(null, { ...session.user, ...res.user });
        setAlert(info, 'Profile saved.', 'success');
        window.CC.renderNav();
      } catch (err) {
        if (err.fields) applyFieldErrors(profileForm, err.fields);
        setAlert(alertBox, err.message);
      } finally {
        busy(btn, false);
      }
    });

    const pwForm = document.getElementById('pwForm');
    pwForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const btn = document.getElementById('pwSubmit');
      const alertBox = document.getElementById('pwAlert');
      setAlert(alertBox, '');
      busy(btn, true, 'Updating…');
      try {
        const res = await api('/api/auth/change-password', {
          method: 'POST',
          body: {
            currentPassword: pwForm.elements.currentPassword.value,
            newPassword: pwForm.elements.newPassword.value,
          },
        });
        toast('Password updated. ' + res.otherSessionsRevoked + ' other session(s) signed out.', 'success');
        pwForm.reset();
      } catch (err) {
        if (err.fields) applyFieldErrors(pwForm, err.fields);
        setAlert(alertBox, err.message);
      } finally {
        busy(btn, false);
      }
    });
  }

  /* --------------------------------- router -------------------------------- */

  const renderers = {
    reports: renderReports,
    claims: renderClaims,
    received: renderReceived,
    sessions: renderSessions,
    profile: renderProfile,
  };

  async function show(tab) {
    currentTab = tab;
    document.querySelectorAll('.side-nav [data-tab]').forEach((btn) =>
      btn.setAttribute('aria-current', String(btn.dataset.tab === tab))
    );
    try {
      await renderers[tab]();
    } catch (err) {
      panel.innerHTML =
        '<div class="empty-state"><div class="icon" aria-hidden="true">⚠️</div>' +
        '<h3>Something went wrong</h3><p>' + escapeHtml(err.message) + '</p>' +
        '<button class="btn btn-primary" data-retry>Try again</button></div>';
      const retry = panel.querySelector('[data-retry]');
      if (retry) retry.addEventListener('click', () => show(currentTab));
    }
  }

  document.querySelectorAll('.side-nav [data-tab]').forEach((btn) =>
    btn.addEventListener('click', () => show(btn.dataset.tab))
  );

  loadOverview();
  show('reports');
})();
