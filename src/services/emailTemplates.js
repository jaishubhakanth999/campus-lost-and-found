'use strict';

/**
 * Branded, responsive email templates.
 *
 * Table-based layout with inline styles so it renders in Gmail, Outlook and
 * mobile clients. Every call-to-action is an absolute https link built from
 * APP_URL, so a button in an email always lands on the deployed site.
 */

const { getConfig } = require('../config/env');

const C = {
  ink: '#17251F',
  green: '#236B50',
  greenDark: '#1A5340',
  lime: '#D8F36A',
  cream: '#F7F8F3',
  muted: '#5E6B64',
  line: '#E3E8DF',
  white: '#FFFFFF',
};

function absolute(pathname = '/') {
  const base = getConfig().APP_URL.replace(/\/+$/, '');
  const suffix = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${suffix}`;
}

function escapeHtml(value = '') {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function layout({ preheader, heading, body, cta, footerNote }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CampusConnect</title>
</head>
<body style="margin:0;padding:0;background:${C.cream};font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink};">
<div style="display:none;font-size:1px;color:${C.cream};max-height:0;overflow:hidden;">${escapeHtml(preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.cream};padding:28px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${C.white};border-radius:18px;overflow:hidden;border:1px solid ${C.line};">
      <tr>
        <td style="background:${C.green};padding:26px 32px;">
          <table role="presentation" width="100%"><tr>
            <td style="font-size:20px;font-weight:700;color:${C.white};letter-spacing:-0.2px;">
              Campus<span style="color:${C.lime};">Connect</span>
            </td>
            <td align="right" style="font-size:10px;letter-spacing:2px;color:#CFE3D8;">SAI UNIVERSITY</td>
          </tr></table>
        </td>
      </tr>
      <tr><td style="padding:34px 32px 8px;">
        <h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:${C.ink};">${heading}</h1>
        ${body}
      </td></tr>
      ${
        cta
          ? `<tr><td style="padding:8px 32px 30px;">
               <a href="${cta.url}" style="display:inline-block;background:${C.green};color:${C.white};text-decoration:none;padding:14px 26px;border-radius:10px;font-weight:600;font-size:15px;">${escapeHtml(cta.label)}</a>
             </td></tr>`
          : ''
      }
      <tr><td style="padding:0 32px 26px;">
        <p style="margin:0;font-size:12px;color:${C.muted};line-height:1.6;">
          ${footerNote || 'You are receiving this email because you have an account on CampusConnect, the Sai University lost &amp; found portal.'}
        </p>
      </td></tr>
      <tr><td style="background:${C.cream};padding:18px 32px;border-top:1px solid ${C.line};">
        <p style="margin:0;font-size:11px;color:${C.muted};">
          CampusConnect · Sai University · <a href="${absolute('/')}" style="color:${C.green};text-decoration:none;">Open the portal</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

const p = (html) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#2A3A32;">${html}</p>`;

function codeBlock(code) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 22px;">
    <tr><td align="center" style="background:${C.cream};border:1px dashed ${C.green};border-radius:14px;padding:22px 12px;">
      <div style="font-size:11px;letter-spacing:2px;color:${C.muted};margin-bottom:8px;">YOUR VERIFICATION CODE</div>
      <div style="font-family:'Courier New',monospace;font-size:38px;font-weight:700;letter-spacing:10px;color:${C.greenDark};">${code}</div>
    </td></tr>
  </table>`;
}

function otpEmail({ name, code, minutes, purpose }) {
  const intent =
    purpose === 'signup'
      ? 'verify your university email address and activate your account'
      : purpose === 'admin_login'
        ? 'complete your administrator sign-in'
        : 'complete your sign-in';
  const subject = `Your CampusConnect code: ${code}`;
  const html = layout({
    preheader: `Your code is ${code}. It expires in ${minutes} minutes.`,
    heading: `Hi ${escapeHtml(name || 'there')}, here is your code`,
    body:
      p(`Use the code below to ${intent}. It is valid for <strong>${minutes} minutes</strong> and can be used once.`) +
      codeBlock(code) +
      p(
        'If you did not request this code, you can safely ignore this email — nobody can access your account without it.'
      ) +
      p(
        `<span style="font-size:13px;color:${C.muted};">CampusConnect will never ask you for this code by phone, chat or in person.</span>`
      ),
    cta: { label: 'Enter the code', url: absolute('/auth.html') },
  });
  return { subject, html, text: `Your CampusConnect code is ${code}. It expires in ${minutes} minutes.` };
}

function welcomeEmail({ name }) {
  return {
    subject: 'Welcome to CampusConnect — your email is verified',
    html: layout({
      preheader: 'Your university email is verified.',
      heading: `You are in, ${escapeHtml(name || 'friend')}.`,
      body:
        p('Your university email address is now verified and your CampusConnect account is active.') +
        p('You can report a lost item, post something you found, and claim an item that belongs to you.') +
        p('Tip: add a photo and a specific location — listings with photos are reunited far more often.'),
      cta: { label: 'Open CampusConnect', url: absolute('/dashboard.html') },
    }),
    text: 'Your university email is verified. Welcome to CampusConnect.',
  };
}

function claimReceivedEmail({ ownerName, claimantName, itemTitle, claimMessage, itemUrl }) {
  return {
    subject: `New claim on “${itemTitle}”`,
    html: layout({
      preheader: `${claimantName} claims this item belongs to them.`,
      heading: 'Someone has claimed your listing',
      body:
        p(`Hi ${escapeHtml(ownerName || 'there')}, <strong>${escapeHtml(claimantName)}</strong> submitted a claim for <strong>${escapeHtml(itemTitle)}</strong>.`) +
        `<table role="presentation" width="100%" style="margin:0 0 18px;"><tr><td style="background:${C.cream};border-left:4px solid ${C.green};border-radius:8px;padding:14px 16px;font-size:14px;line-height:1.6;color:#2A3A32;font-style:italic;">“${escapeHtml(claimMessage)}”</td></tr></table>` +
        p('Read the full claim, check their evidence, then approve or reject it from your dashboard.'),
      cta: { label: 'Review the claim', url: itemUrl || absolute('/dashboard.html') },
      footerNote: 'Only approve a claim when the description matches details only the real owner would know.',
    }),
    text: `${claimantName} claimed "${itemTitle}": ${claimMessage}`,
  };
}

function claimDecisionEmail({ claimantName, itemTitle, decision, note, itemUrl }) {
  const approved = decision === 'approved';
  return {
    subject: approved ? `Your claim for “${itemTitle}” was approved` : `Update on your claim for “${itemTitle}”`,
    html: layout({
      preheader: approved ? 'Arrange the handover with the finder.' : 'The listing owner has responded.',
      heading: approved ? 'Good news — your claim was approved' : 'Your claim was not approved',
      body:
        p(`Hi ${escapeHtml(claimantName || 'there')}, the owner of <strong>${escapeHtml(itemTitle)}</strong> has ${approved ? 'approved' : 'rejected'} your claim.`) +
        (note
          ? `<table role="presentation" width="100%" style="margin:0 0 18px;"><tr><td style="background:${C.cream};border-left:4px solid ${approved ? C.green : '#B45309'};border-radius:8px;padding:14px 16px;font-size:14px;line-height:1.6;">${escapeHtml(note)}</td></tr></table>`
          : '') +
        p(
          approved
            ? 'Coordinate the handover from your dashboard — agree on a public place on campus, and confirm once you have the item.'
            : 'If you believe this is a mistake, you can reply to the owner from the item page or contact the campus help desk.'
        ),
      cta: { label: approved ? 'Arrange handover' : 'View the item', url: itemUrl || absolute('/dashboard.html') },
    }),
    text: `Your claim for "${itemTitle}" was ${decision}.${note ? ` Note: ${note}` : ''}`,
  };
}

function itemReturnedEmail({ name, itemTitle, itemUrl }) {
  return {
    subject: `“${itemTitle}” is back with its owner`,
    html: layout({
      preheader: 'Another item reunited on campus.',
      heading: 'Reunited — thank you',
      body:
        p(`Hi ${escapeHtml(name || 'there')}, <strong>${escapeHtml(itemTitle)}</strong> has been marked as returned to its owner.`) +
        p('Thank you for helping keep the campus community connected. Every returned item started with someone bothering to report it.'),
      cta: { label: 'See the gallery', url: itemUrl || absolute('/index.html') },
    }),
    text: `"${itemTitle}" has been marked as returned.`,
  };
}

function passwordResetEmail({ name, url, minutes }) {
  return {
    subject: 'Reset your CampusConnect password',
    html: layout({
      preheader: `Your reset link expires in ${minutes} minutes.`,
      heading: 'Reset your password',
      body:
        p(`Hi ${escapeHtml(name || 'there')}, we received a request to reset the password for your CampusConnect account.`) +
        p(`The link below works once and expires in <strong>${minutes} minutes</strong>.`) +
        `<table role="presentation" width="100%" style="margin:0 0 18px;"><tr><td style="background:${C.cream};border:1px dashed ${C.green};border-radius:12px;padding:14px 16px;font-size:13px;word-break:break-all;color:${C.greenDark};">${escapeHtml(url)}</td></tr></table>` +
        p('If you did not ask for this, ignore the email — your password stays exactly as it is. Nobody can use this link without opening it from your inbox.'),
      cta: { label: 'Choose a new password', url },
      footerNote: 'For your security, this link stops working once it has been used or after it expires.',
    }),
    text: `Reset your CampusConnect password (expires in ${minutes} minutes): ${url}`,
  };
}

function listingExpiringEmail({ name, itemTitle, daysLeft, itemUrl }) {
  return {
    subject: `“${itemTitle}” closes in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    html: layout({
      preheader: 'Still looking? Re-post it in one click.',
      heading: 'Your listing is about to close',
      body:
        p(`Hi ${escapeHtml(name || 'there')}, your ${daysLeft === 1 ? 'listing closes tomorrow' : `listing closes in ${daysLeft} days`}: <strong>${escapeHtml(itemTitle)}</strong>.`) +
        p('If you have already found it, open the listing and mark it returned so the gallery stays accurate. If you are still looking, re-post it — a fresh listing is seen by everyone again.'),
      cta: { label: 'Open the listing', url: itemUrl },
    }),
    text: `"${itemTitle}" closes in ${daysLeft} days.`,
  };
}

function securityAlertEmail({ name, event, when, ip }) {
  return {
    subject: 'Security notice for your CampusConnect account',
    html: layout({
      preheader: event,
      heading: 'Security notice',
      body:
        p(`Hi ${escapeHtml(name || 'there')}, ${escapeHtml(event)}.`) +
        p(`<strong>Time:</strong> ${escapeHtml(when)}<br><strong>IP address:</strong> ${escapeHtml(ip || 'unknown')}`) +
        p('If this was not you, sign in and revoke the session from your dashboard, then contact the campus help desk.'),
      cta: { label: 'Review your sessions', url: absolute('/dashboard.html') },
    }),
    text: `${event} at ${when}.`,
  };
}

module.exports = {
  otpEmail,
  passwordResetEmail,
  listingExpiringEmail,
  welcomeEmail,
  claimReceivedEmail,
  claimDecisionEmail,
  itemReturnedEmail,
  securityAlertEmail,
  layout,
  absolute,
  escapeHtml,
};
