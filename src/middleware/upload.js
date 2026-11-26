'use strict';

/**
 * Image intake.
 *
 * Three layers of defence, in order:
 *  1. multer caps the number of files and the byte size.
 *  2. the declared MIME type is checked (cheap, rejects obvious mistakes).
 *  3. sharp decodes the actual bytes — this is the real check. A .txt renamed
 *     to .jpg fails here. Re-encoding to WebP also strips EXIF (so no GPS
 *     coordinates leak) and normalises dimensions.
 */

const multer = require('multer');
const sharp = require('sharp');
const { getConfig } = require('../config/env');
const { AppError } = require('../lib/errors');

const DECLARED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DECODABLE_FORMATS = new Set(['jpeg', 'png', 'webp']);

function imageUploader({ maxFiles = 3 } = {}) {
  const cfg = getConfig();
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: Math.round(cfg.MAX_UPLOAD_MB * 1024 * 1024),
      files: maxFiles,
      fields: 30,
      fieldSize: 64 * 1024,
    },
    fileFilter: (req, file, cb) => {
      if (DECLARED_TYPES.has(file.mimetype)) return cb(null, true);
      const err = new AppError(400, 'Only JPG, PNG or WEBP images are allowed', {
        code: 'unsupported_file_type',
      });
      return cb(err);
    },
  });
}

/** Decodes and re-encodes one image buffer. Throws a 400 on anything else. */
async function processImageBuffer(buffer) {
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: 50_000_000 }).metadata();
  } catch {
    throw new AppError(400, 'That file is not a readable image', { code: 'invalid_image' });
  }
  if (!DECODABLE_FORMATS.has(meta.format)) {
    throw new AppError(400, 'Only JPG, PNG or WEBP images are allowed', {
      code: 'unsupported_file_type',
    });
  }

  const output = await sharp(buffer, { limitInputPixels: 50_000_000 })
    .rotate() // apply EXIF orientation before the metadata is stripped
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: output.data,
    mime: 'image/webp',
    ext: 'webp',
    width: output.info.width,
    height: output.info.height,
    bytes: output.data.length,
  };
}

/** Middleware: converts req.files into req.processedImages. */
async function processUploads(req, res, next) {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    const processed = [];
    for (const file of files) {
      processed.push(await processImageBuffer(file.buffer));
    }
    req.processedImages = processed;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { imageUploader, processImageBuffer, processUploads, DECLARED_TYPES };
