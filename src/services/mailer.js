'use strict';

/**
 * Email delivery.
 *
 * Three transports, selected by MAIL_TRANSPORT:
 *   smtp    — production (Nodemailer + your provider's SMTP credentials)
 *   file    — development: messages are written to tmp/mail-outbox so a
 *             developer can read the OTP without it ever touching the console
 *   capture — tests: messages are held in memory and asserted on
 *
 * Credentials live only in environment variables. Nothing here is ever logged.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const nodemailer = require('nodemailer');
const { getConfig } = require('../config/env');
const logger = require('../lib/logger');

let smtpTransport;
let captured = [];

function getSmtpTransport() {
  if (!smtpTransport) {
    const cfg = getConfig();
    smtpTransport = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT,
      secure: cfg.SMTP_SECURE,
      auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
      pool: true,
      maxConnections: 3,
    });
  }
  return smtpTransport;
}

async function deliver({ to, subject, html, text }) {
  const cfg = getConfig();

  if (cfg.MAIL_TRANSPORT === 'capture') {
    captured.push({ to, subject, html, text, at: new Date() });
    return { messageId: `capture-${captured.length}` };
  }

  if (cfg.MAIL_TRANSPORT === 'file') {
    const dir = path.resolve(cfg.MAIL_OUTBOX_DIR);
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTo = String(to).replace(/[^a-z0-9@._-]/gi, '_');
    const base = path.join(dir, `${stamp}-${safeTo}`);
    await fs.writeFile(`${base}.html`, html, 'utf8');
    await fs.writeFile(`${base}.json`, JSON.stringify({ to, subject, at: stamp }, null, 2), 'utf8');
    return { messageId: `file-${stamp}` };
  }

  return getSmtpTransport().sendMail({ from: cfg.MAIL_FROM, to, subject, html, text });
}

/**
 * Sends a message. Delivery failures are logged and swallowed: a broken mail
 * server must not turn a valid registration into a 500, and the caller decides
 * whether the flow can continue without the email.
 */
async function send({ to, subject, html, text }) {
  try {
    const info = await deliver({ to, subject, html, text });
    logger.info('email sent', { to, subject, transport: getConfig().MAIL_TRANSPORT });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    logger.error('email delivery failed', { to, subject, message: err.message });
    return { ok: false, error: err.message };
  }
}

/* ---- test helpers ---- */
function capturedMessages() {
  return captured;
}
function lastCapturedTo(email) {
  return [...captured].reverse().find((m) => m.to === email);
}
function clearCaptured() {
  captured = [];
}

module.exports = { send, capturedMessages, lastCapturedTo, clearCaptured };
