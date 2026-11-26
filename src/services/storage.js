'use strict';

/**
 * Image storage.
 *
 * local    — files land in ./uploads and are served by this app (development,
 *            or a host with a persistent disk)
 * supabase — files land in Supabase Storage: public gallery images in the
 *            public bucket, private claim evidence in a private bucket that is
 *            only reachable through short-lived signed URLs
 *
 * Only a small JSON reference ({key, url, width, height, bytes}) is stored in
 * Postgres — never the bytes themselves.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { getConfig } = require('../config/env');
const { AppError } = require('../lib/errors');

const PUBLIC_PREFIX = 'public';
const PRIVATE_PREFIX = 'private';

function monthPath() {
  const d = new Date();
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function makeKey({ visibility, ext }) {
  const id = crypto.randomUUID();
  return `${visibility}/${monthPath()}/${id}.${ext}`;
}

/* ------------------------------- local driver ------------------------------ */

function localRoot() {
  return path.resolve(getConfig().LOCAL_UPLOAD_DIR);
}

function resolveLocal(key) {
  const root = localRoot();
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) {
    // Defensive: a key must never escape the upload directory.
    throw new AppError(400, 'Invalid file reference', { code: 'invalid_key' });
  }
  return full;
}

async function localPut(key, buffer) {
  const full = resolveLocal(key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer);
}

/* ----------------------------- supabase driver ----------------------------- */

function supabaseConfig() {
  const cfg = getConfig();
  return {
    url: String(cfg.SUPABASE_URL || '').replace(/\/+$/, ''),
    key: cfg.SUPABASE_SERVICE_ROLE_KEY,
    bucket: cfg.SUPABASE_BUCKET_PUBLIC,
    privateBucket: cfg.SUPABASE_BUCKET_PRIVATE,
  };
}

async function supabasePut(key, buffer, mime, bucket) {
  const { url, key: serviceKey } = supabaseConfig();
  const res = await fetch(`${url}/storage/v1/object/${bucket}/${key}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': mime,
      'x-upsert': 'false',
    },
    body: buffer,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AppError(502, 'Image storage is unavailable, please try again', {
      code: 'storage_failed',
      details: { status: res.status, detail: detail.slice(0, 200) },
    });
  }
}

function publicUrlFor(key) {
  const cfg = getConfig();
  if (cfg.STORAGE_DRIVER === 'supabase') {
    const { url, bucket } = supabaseConfig();
    return `${url}/storage/v1/object/public/${bucket}/${key}`;
  }
  return `/uploads/${key}`;
}

/* --------------------------------- public API ------------------------------ */

/** Stores one processed image and returns the JSON reference kept in Postgres. */
async function saveImage({ buffer, mime, ext, width, height, bytes, visibility = PUBLIC_PREFIX }) {
  const cfg = getConfig();
  const key = makeKey({ visibility, ext });

  if (cfg.STORAGE_DRIVER === 'supabase') {
    const bucket =
      visibility === PRIVATE_PREFIX ? supabaseConfig().privateBucket : supabaseConfig().bucket;
    await supabasePut(key, buffer, mime, bucket);
  } else {
    await localPut(key, buffer);
  }

  return {
    key,
    url: visibility === PUBLIC_PREFIX ? publicUrlFor(key) : null,
    width,
    height,
    bytes,
    visibility,
    mime,
  };
}

async function saveImages(processed, visibility = PUBLIC_PREFIX) {
  const out = [];
  for (const img of processed) {
    out.push(await saveImage({ ...img, visibility }));
  }
  return out;
}

async function deleteImage(key) {
  if (!key) return;
  const cfg = getConfig();
  if (cfg.STORAGE_DRIVER === 'supabase') {
    const { url, key: serviceKey } = supabaseConfig();
    const bucket = key.startsWith(PRIVATE_PREFIX) ? supabaseConfig().privateBucket : supabaseConfig().bucket;
    await fetch(`${url}/storage/v1/object/${bucket}/${key}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${serviceKey}` },
    }).catch(() => {});
    return;
  }
  await fs.unlink(resolveLocal(key)).catch(() => {});
}

/** Short-lived URL for private evidence (Supabase) or a guarded app route (local). */
async function signedUrl(key, expiresIn = 300) {
  const cfg = getConfig();
  if (cfg.STORAGE_DRIVER === 'supabase') {
    const { url, key: serviceKey, privateBucket } = supabaseConfig();
    const res = await fetch(`${url}/storage/v1/object/sign/${privateBucket}/${key}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn }),
    });
    if (!res.ok) throw new AppError(502, 'Could not prepare the file', { code: 'storage_failed' });
    const data = await res.json();
    return `${url}/storage/v1${data.signedURL}`;
  }
  return `/api/files/private/${key}`;
}

module.exports = {
  saveImage,
  saveImages,
  deleteImage,
  signedUrl,
  publicUrlFor,
  resolveLocal,
  localRoot,
  PUBLIC_PREFIX,
  PRIVATE_PREFIX,
};
