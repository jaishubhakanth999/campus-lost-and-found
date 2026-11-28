/* Report form: details, image upload, camera capture, preview, submit. */
(function () {
  'use strict';

  const { api, session, toast, applyFieldErrors, clearFieldErrors, setAlert, busy, requireSession, escapeHtml } = window.CC;

  if (!requireSession()) return;

  const form = document.getElementById('reportForm');
  const alertBox = document.getElementById('formAlert');
  const fileInput = document.getElementById('fileInput');
  const mobileCameraInput = document.getElementById('mobileCameraInput');
  const dropzone = document.getElementById('dropzone');
  const previewWrap = document.getElementById('previewWrap');
  const previewImg = document.getElementById('previewImg');
  const fileMeta = document.getElementById('fileMeta');
  const cameraDialog = document.getElementById('cameraDialog');
  const cameraVideo = document.getElementById('cameraVideo');
  const cameraAlert = document.getElementById('cameraAlert');
  const captureBtn = document.getElementById('captureBtn');

  const MAX_BYTES = 5 * 1024 * 1024;
  const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

  let selectedFile = null;
  let previewUrl = null;
  let stream = null;

  /* ------------------------------ file handling ---------------------------- */

  function setFile(file) {
    setAlert(alertBox, '');
    if (!file) return;

    if (!ALLOWED.includes(file.type)) {
      setAlert(alertBox, 'Please choose a JPG, PNG or WEBP image.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setAlert(alertBox, 'That image is larger than 5 MB. Please choose a smaller one.');
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    selectedFile = file;
    previewUrl = URL.createObjectURL(file);
    previewImg.src = previewUrl;
    previewWrap.classList.remove('hidden');
    dropzone.classList.add('hidden');
    fileMeta.textContent = file.name + ' · ' + (file.size / 1024).toFixed(0) + ' KB';
  }

  function clearFile() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    selectedFile = null;
    previewUrl = null;
    previewImg.removeAttribute('src');
    previewWrap.classList.add('hidden');
    dropzone.classList.remove('hidden');
    fileMeta.textContent = '';
    fileInput.value = '';
    mobileCameraInput.value = '';
  }

  document.getElementById('chooseBtn').addEventListener('click', () => fileInput.click());
  document.getElementById('replaceBtn').addEventListener('click', () => fileInput.click());
  document.getElementById('removeBtn').addEventListener('click', clearFile);

  fileInput.addEventListener('change', (event) => setFile(event.target.files[0]));
  mobileCameraInput.addEventListener('change', (event) => setFile(event.target.files[0]));

  ['dragenter', 'dragover'].forEach((name) =>
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((name) =>
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragover');
    })
  );
  dropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) setFile(file);
  });

  /* --------------------------------- camera -------------------------------- */

  function stopStream() {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    cameraVideo.srcObject = null;
  }

  function cameraSupported() {
    return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async function openCamera() {
    setAlert(cameraAlert, '');
    if (!cameraSupported()) {
      // Fall back to the native capture input, which works on mobile browsers.
      setAlert(alertBox, 'Live camera preview is not available in this browser — use the file picker that just opened.', 'info');
      mobileCameraInput.click();
      return;
    }

    cameraDialog.showModal();
    captureBtn.disabled = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      cameraVideo.srcObject = stream;
      await cameraVideo.play();
      captureBtn.disabled = false;
    } catch (err) {
      const reason =
        err && err.name === 'NotAllowedError'
          ? 'Camera permission was denied. You can still upload a photo from your device.'
          : err && err.name === 'NotFoundError'
            ? 'No camera was found on this device. You can still upload a photo.'
            : 'The camera could not be started. You can still upload a photo.';
      setAlert(cameraAlert, reason, 'info');
      captureBtn.disabled = true;
    }
  }

  function capture() {
    if (!stream) return;
    const width = cameraVideo.videoWidth || 1280;
    const height = cameraVideo.videoHeight || 960;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(cameraVideo, 0, 0, width, height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setAlert(cameraAlert, 'The photo could not be captured. Please try again.', 'info');
          return;
        }
        const file = new File([blob], 'camera-' + Date.now() + '.jpg', { type: 'image/jpeg' });
        setFile(file);
        closeCamera();
        toast('Photo captured', 'success');
      },
      'image/jpeg',
      0.9
    );
  }

  function closeCamera() {
    stopStream();
    if (cameraDialog.open) cameraDialog.close();
  }

  document.getElementById('cameraBtn').addEventListener('click', openCamera);
  captureBtn.addEventListener('click', capture);
  cameraDialog.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', closeCamera));
  cameraDialog.addEventListener('close', stopStream);

  /* --------------------------------- submit -------------------------------- */

  // Default the date to today, and never allow a future date.
  const dateInput = document.getElementById('occurredOn');
  // toISOString() is UTC: for IST users that is "yesterday" until 05:30, which
  // pre-filled the wrong date and blocked today via max. Use the local date.
  const now = new Date();
  const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  dateInput.max = today;
  dateInput.value = today;

  form.querySelectorAll('input[name="type"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      document.getElementById('typeLostLabel').classList.toggle('btn-primary', radio.value === 'lost' && radio.checked);
      document.getElementById('typeFoundLabel').classList.toggle('btn-primary', radio.value === 'found' && radio.checked);
    });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = document.getElementById('submitBtn');
    clearFieldErrors(form);
    setAlert(alertBox, '');

    const data = new FormData();
    data.append('type', form.querySelector('input[name="type"]:checked').value);
    ['title', 'category', 'description', 'location', 'occurredOn', 'occurredTime', 'additionalInfo'].forEach((key) => {
      const value = form.elements[key] ? String(form.elements[key].value || '').trim() : '';
      if (value) data.append(key, value);
    });
    if (selectedFile) data.append('images', selectedFile, selectedFile.name);

    // Client-side guard (the server validates again, and is the real gate).
    if (!data.get('title') || !data.get('category') || !data.get('description') || !data.get('location') || !data.get('occurredOn')) {
      setAlert(alertBox, 'Please fill in the item name, category, description, location and date.');
      return;
    }

    busy(button, true, 'Publishing…');
    try {
      const res = await api('/api/items', { method: 'POST', form: data });
      toast('Your report is live', 'success');
      sessionStorage.setItem('campusconnect.flash', 'Your report is live and visible in the gallery.');
      location.href = 'item.html?id=' + encodeURIComponent(res.item.id);
    } catch (err) {
      if (err.fields) applyFieldErrors(form, err.fields);
      setAlert(alertBox, err.message);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      busy(button, false);
    }
  });

  /* ------------------------- location suggestions -------------------------- */

  api('/api/items/stats/public')
    .then((res) => {
      const list = document.getElementById('locationList');
      if (list && res.locations) {
        list.innerHTML = res.locations.map((l) => '<option value="' + escapeHtml(l) + '">').join('');
      }
    })
    .catch(() => {});
})();
