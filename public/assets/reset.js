/* Password reset: request a link, then set a new password from that link. */
(function () {
  'use strict';

  const { api, toast, setAlert, busy, applyFieldErrors, clearFieldErrors } = window.CC;

  const panels = {
    request: document.getElementById('panelRequest'),
    reset: document.getElementById('panelReset'),
    done: document.getElementById('panelDone'),
  };

  function show(name) {
    Object.entries(panels).forEach(([key, el]) => {
      el.hidden = key !== name;
    });
  }

  const token = new URLSearchParams(location.search).get('token');

  /* ------------------------------ request a link --------------------------- */

  const requestForm = document.getElementById('requestForm');
  requestForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('requestSubmit');
    const alertBox = document.getElementById('requestAlert');
    const info = document.getElementById('requestInfo');
    clearFieldErrors(requestForm);
    setAlert(alertBox, '');
    setAlert(info, '');

    const email = requestForm.elements.email.value.trim();
    if (!email) {
      setAlert(alertBox, 'Enter your university email address.');
      return;
    }

    busy(button, true, 'Sending…');
    try {
      const res = await api('/api/auth/forgot-password', { method: 'POST', body: { email } });
      setAlert(
        info,
        res.message || 'If that address belongs to an account, a reset link is on its way.',
        'success'
      );
      requestForm.reset();
    } catch (err) {
      if (err.fields) applyFieldErrors(requestForm, err.fields);
      setAlert(alertBox, err.message);
    } finally {
      busy(button, false);
    }
  });

  /* ------------------------------ set a new one ---------------------------- */

  const resetForm = document.getElementById('resetForm');
  resetForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('resetSubmit');
    const alertBox = document.getElementById('resetAlert');
    clearFieldErrors(resetForm);
    setAlert(alertBox, '');

    const password = resetForm.elements.password.value;
    const confirm = resetForm.elements.confirm.value;
    if (password.length < 8) {
      setAlert(alertBox, 'Use at least 8 characters, with a letter and a number.');
      return;
    }
    if (password !== confirm) {
      setAlert(alertBox, 'The two passwords do not match.');
      return;
    }

    busy(button, true, 'Updating…');
    try {
      const res = await api('/api/auth/reset-password', {
        method: 'POST',
        body: { token, password },
      });
      document.getElementById('doneMessage').textContent =
        'You can now sign in with your new password.' +
        (res.sessionsRevoked ? ' ' + res.sessionsRevoked + ' other session(s) were signed out.' : '');
      show('done');
      toast('Password updated', 'success');
    } catch (err) {
      if (err.fields) applyFieldErrors(resetForm, err.fields);
      setAlert(alertBox, err.message);
    } finally {
      busy(button, false);
    }
  });

  /* -------------------------------- routing -------------------------------- */

  if (token) {
    show('reset');
    document.getElementById('password').focus();
  } else {
    show('request');
  }
})();
