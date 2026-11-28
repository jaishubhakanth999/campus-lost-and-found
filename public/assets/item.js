/* Item detail: public view, claim submission, and owner controls. */
(function () {
  'use strict';

  const { api, session, toast, escapeHtml, formatDate, formatDateTime, pill, setAlert, busy, applyFieldErrors } = window.CC;

  const root = document.getElementById('itemRoot');
  const claimDialog = document.getElementById('claimDialog');
  const claimForm = document.getElementById('claimForm');
  const claimAlert = document.getElementById('claimAlert');
  const editDialog = document.getElementById('editDialog');
  const editForm = document.getElementById('editForm');
  const editAlert = document.getElementById('editAlert');

  const itemId = new URLSearchParams(location.search).get('id');
  let item = null;

  const flash = sessionStorage.getItem('campusconnect.flash');
  if (flash) {
    toast(flash, 'success');
    sessionStorage.removeItem('campusconnect.flash');
  }

  function galleryHtml(images) {
    if (!images || !images.length) {
      return '<div class="item-media" style="aspect-ratio:16/9;border-radius:var(--radius);"><span class="placeholder" aria-hidden="true">◈</span></div>';
    }
    const main = '<img src="' + escapeHtml(images[0].url) + '" alt="' + escapeHtml(item.title) + '" style="width:100%;max-height:520px;object-fit:contain;background:#0f1a15;border-radius:var(--radius);">';
    const thumbs = images.length > 1
      ? '<div class="row" style="margin-top:.5rem;">' + images.slice(1).map((img) =>
          '<img src="' + escapeHtml(img.url) + '" alt="Another photo of the item" style="width:96px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--line);">'
        ).join('') + '</div>'
      : '';
    return main + thumbs;
  }

  function claimRow(claim) {
    return (
      '<div class="row-card">' +
        '<div class="row-main">' +
          '<h4>' + escapeHtml(claim.claimantName) + ' ' + pill(claim.status) + '</h4>' +
          '<p style="margin:.35rem 0;font-size:.92rem;">“' + escapeHtml(claim.message) + '”</p>' +
          '<small class="muted">' + formatDateTime(claim.createdAt) + '</small>' +
        '</div>' +
        (claim.status === 'pending'
          ? '<div class="row-actions">' +
              '<button class="btn btn-primary btn-sm" data-decide="approved" data-claim="' + claim.id + '">Approve</button>' +
              '<button class="btn btn-ghost btn-sm" data-decide="rejected" data-claim="' + claim.id + '">Reject</button>' +
            '</div>'
          : '') +
      '</div>'
    );
  }

  function ownerControls() {
    const statusButtons = [];
    if (item.status === 'open') {
      statusButtons.push('<button class="btn btn-ghost btn-sm" data-status="closed">Close listing</button>');
      statusButtons.push('<button class="btn btn-ghost btn-sm" data-status="returned">Mark returned</button>');
    }
    if (item.status === 'claimed') {
      statusButtons.push('<button class="btn btn-primary btn-sm" data-complete>Confirm handover complete</button>');
    }
    if (item.status === 'returned') {
      statusButtons.push('<button class="btn btn-ghost btn-sm" data-status="closed">Archive listing</button>');
    }

    return (
      '<section class="card" style="margin-top:1.5rem;">' +
        '<div class="spread"><h2 style="font-size:1.15rem;margin:0;">Manage this listing</h2>' +
        '<div class="row">' +
          '<button class="btn btn-ghost btn-sm" id="editOpen">Edit details</button>' +
          statusButtons.join('') +
          '<button class="btn btn-danger btn-sm" id="deleteBtn">Delete</button>' +
        '</div></div>' +
        '<p class="muted" style="margin:.75rem 0 0;font-size:.88rem;">You can only change the status of your own listings; claim approvals are what move an item to “claimed”.</p>' +
      '</section>' +
      '<section class="card" style="margin-top:1rem;">' +
        '<h2 style="font-size:1.15rem;">Claims on this listing</h2>' +
        (item.claims && item.claims.length
          ? item.claims.map(claimRow).join('')
          : '<div class="empty-state" style="padding:1.5rem;"><p style="margin:0;">No claims yet. When someone claims it, you will see their message here and receive an email.</p></div>') +
      '</section>'
    );
  }

  function claimCta() {
    if (!session.token) {
      return '<a class="btn btn-primary btn-lg" href="auth.html?next=' + encodeURIComponent('item.html?id=' + item.id) + '">Sign in to claim</a>';
    }
    if (item.isOwner) return '';
    if (item.myClaim) {
      return '<div class="form-alert info" style="margin:0;">You already have a <strong>' + escapeHtml(item.myClaim.status) + '</strong> claim on this item. Track it in your dashboard.</div>';
    }
    if (item.type !== 'found') {
      return '<p class="muted" style="margin:0;">This is a lost report. If you found this item, reply by reporting it as found so the owner is notified.</p>';
    }
    if (item.status !== 'open') {
      return '<p class="muted" style="margin:0;">This item is no longer open for claims.</p>';
    }
    return '<button class="btn btn-primary btn-lg" id="claimOpen">Claim this item</button>';
  }

  function render() {
    document.title = item.title + ' | CampusConnect';
    root.setAttribute('aria-busy', 'false');
    root.innerHTML =
      '<div style="display:grid;grid-template-columns:1.1fr .9fr;gap:1.5rem;align-items:start;" class="item-layout">' +
        '<div>' + galleryHtml(item.images) + '</div>' +
        '<div class="card">' +
          '<div class="row" style="gap:.4rem;margin-bottom:.6rem;">' +
            '<span class="pill ' + escapeHtml(item.type) + '">' + escapeHtml(item.type) + '</span>' +
            pill(item.status) +
            (item.claimCount ? '<span class="pill">' + item.claimCount + ' claim' + (item.claimCount === 1 ? '' : 's') + '</span>' : '') +
          '</div>' +
          '<h1 style="font-size:1.6rem;">' + escapeHtml(item.title) + '</h1>' +
          '<dl class="kv" style="margin:1rem 0;">' +
            '<dt>Category</dt><dd>' + escapeHtml(item.category) + '</dd>' +
            '<dt>Location</dt><dd>' + escapeHtml(item.location) + '</dd>' +
            '<dt>Date</dt><dd>' + formatDate(item.occurredOn) + (item.occurredTime ? ' · ' + escapeHtml(item.occurredTime) : '') + '</dd>' +
            '<dt>Reported by</dt><dd>' + escapeHtml(item.owner.name) + '</dd>' +
            '<dt>Reported</dt><dd>' + formatDateTime(item.createdAt) + '</dd>' +
            '<dt>Views</dt><dd>' + (item.viewCount || 0) + '</dd>' +
          '</dl>' +
          '<h2 style="font-size:1rem;">Description</h2>' +
          '<p style="white-space:pre-wrap;">' + escapeHtml(item.description) + '</p>' +
          (item.additionalInfo ? '<h2 style="font-size:1rem;">Additional information</h2><p style="white-space:pre-wrap;">' + escapeHtml(item.additionalInfo) + '</p>' : '') +
          '<div style="margin-top:1.25rem;">' + claimCta() + '</div>' +
        '</div>' +
      '</div>' +
      (item.isOwner ? ownerControls() : '') +
      '<style>@media (max-width:820px){ .item-layout{ grid-template-columns:1fr !important; } }</style>';

    const claimOpen = document.getElementById('claimOpen');
    if (claimOpen) {
      claimOpen.addEventListener('click', () => {
        document.getElementById('claimItemName').textContent = item.title + ' · ' + item.location;
        setAlert(claimAlert, '');
        claimForm.reset();
        claimDialog.showModal();
      });
    }

    const editOpen = document.getElementById('editOpen');
    if (editOpen) {
      editOpen.addEventListener('click', () => {
        editForm.elements.title.value = item.title;
        editForm.elements.category.value = item.category;
        editForm.elements.location.value = item.location;
        editForm.elements.occurredOn.value = String(item.occurredOn).slice(0, 10);
        editForm.elements.occurredTime.value = item.occurredTime || '';
        editForm.elements.description.value = item.description;
        setAlert(editAlert, '');
        editDialog.showModal();
      });
    }

    const deleteBtn = document.getElementById('deleteBtn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        if (!confirm('Delete this listing? It will disappear from the gallery. This cannot be undone from the app.')) return;
        try {
          await api('/api/items/' + item.id, { method: 'DELETE' });
          toast('Listing deleted', 'success');
          setTimeout(() => (location.href = 'dashboard.html'), 600);
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }

    root.querySelectorAll('[data-status]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api('/api/items/' + item.id + '/status', {
            method: 'PATCH',
            body: { status: btn.dataset.status },
          });
          toast('Listing updated', 'success');
          load();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });

    const completeBtn = root.querySelector('[data-complete]');
    if (completeBtn) {
      completeBtn.addEventListener('click', async () => {
        const approved = (item.claims || []).find((c) => c.status === 'approved');
        if (!approved) {
          toast('There is no approved claim to complete yet.', 'error');
          return;
        }
        if (!confirm('Confirm the item has been handed to its owner?')) return;
        try {
          await api('/api/claims/' + approved.id + '/complete', { method: 'PATCH' });
          toast('Item marked as returned', 'success');
          load();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }

    root.querySelectorAll('[data-decide]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const decision = btn.dataset.decide;
        let note = '';
        if (decision === 'rejected') {
          const answer = prompt('Optional: tell the claimant why (they will see this).');
          if (answer === null) return; // cancelled — do not reject
          note = answer;
        }
        if (decision === 'approved' && !confirm('Approve this claim? Other pending claims will be rejected and the item will be marked as claimed.')) return;
        try {
          await api('/api/claims/' + btn.dataset.claim + '/decision', {
            method: 'PATCH',
            body: { decision, note: note || undefined },
          });
          toast('Claim ' + decision, 'success');
          load();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  async function load() {
    root.setAttribute('aria-busy', 'true');
    try {
      const data = await api('/api/items/' + encodeURIComponent(itemId));
      item = data.item;
      render();
    } catch (err) {
      root.setAttribute('aria-busy', 'false');
      root.innerHTML =
        '<div class="empty-state"><div class="icon" aria-hidden="true">🔎</div>' +
        '<h2>That listing is not available</h2><p>' + escapeHtml(err.message) + '</p>' +
        '<a class="btn btn-primary" href="index.html">Back to the gallery</a></div>';
    }
  }

  claimForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('claimSubmit');
    setAlert(claimAlert, '');
    const message = claimForm.elements.message.value.trim();
    if (message.length < 10) {
      setAlert(claimAlert, 'Please describe the item in at least 10 characters.');
      return;
    }

    const data = new FormData();
    data.append('itemId', item.id);
    data.append('message', message);
    const evidence = document.getElementById('claimEvidence').files[0];
    if (evidence) data.append('evidence', evidence, evidence.name);

    busy(button, true, 'Sending…');
    try {
      await api('/api/claims', { method: 'POST', form: data });
      claimDialog.close();
      toast('Claim sent — the finder has been emailed', 'success');
      load();
    } catch (err) {
      if (err.fields) applyFieldErrors(claimForm, err.fields);
      setAlert(claimAlert, err.message);
    } finally {
      busy(button, false);
    }
  });

  editForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('editSubmit');
    setAlert(editAlert, '');
    const body = {
      title: editForm.elements.title.value.trim(),
      category: editForm.elements.category.value,
      location: editForm.elements.location.value.trim(),
      occurredOn: editForm.elements.occurredOn.value,
      description: editForm.elements.description.value.trim(),
    };
    if (editForm.elements.occurredTime.value) body.occurredTime = editForm.elements.occurredTime.value;

    busy(button, true, 'Saving…');
    try {
      await api('/api/items/' + item.id, { method: 'PATCH', body });
      editDialog.close();
      toast('Report updated', 'success');
      load();
    } catch (err) {
      if (err.fields) applyFieldErrors(editForm, err.fields);
      setAlert(editAlert, err.message);
    } finally {
      busy(button, false);
    }
  });

  document.querySelectorAll('dialog [data-close]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('dialog').close());
  });

  if (!itemId) {
    root.innerHTML = '<div class="empty-state"><h2>No item selected</h2><a class="btn btn-primary" href="index.html">Browse the gallery</a></div>';
  } else {
    load();
  }
})();
