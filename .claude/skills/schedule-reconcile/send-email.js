/**
 * send-email.js — Send the schedule-reconcile HTML email via Gmail API
 *
 * Uses cached OAuth tokens from the gmail-mcp-center setup (the same tokens
 * the interactive Claude session uses). Reads subject from payload.json and
 * HTML body from email.html.
 *
 * Usage: node send-email.js <payload.json> <email.html> <to1,to2,...>
 */

const fs = require('fs');
const { google } = require('googleapis');

const GMAIL_KEYS = 'C:\\Users\\hlcadmin\\.gmail-mcp-center\\gcp-oauth.keys.json';
const GMAIL_TOKENS = 'C:\\Users\\hlcadmin\\.gmail-mcp-center\\credentials.json';
const FROM = 'staff@huntingtonissaquah.com';

const [,, payloadPath, htmlPath, recipientsArg] = process.argv;
if (!payloadPath || !htmlPath || !recipientsArg) {
  console.error('Usage: node send-email.js <payload.json> <email.html> <to1,to2,...>');
  process.exit(1);
}
const recipients = recipientsArg.split(',').map(s => s.trim()).filter(Boolean);
if (recipients.length === 0) { console.error('No recipients'); process.exit(1); }

function makeAuth() {
  const keys = JSON.parse(fs.readFileSync(GMAIL_KEYS, 'utf8'));
  const { client_id, client_secret, redirect_uris } = keys.installed || keys.web;
  const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris?.[0]);
  const tokens = JSON.parse(fs.readFileSync(GMAIL_TOKENS, 'utf8'));
  auth.setCredentials(tokens);
  return auth;
}

(async () => {
  const t0 = Date.now();
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  const html = fs.readFileSync(htmlPath, 'utf8');
  const subject = payload.subject;
  const stats = payload.stats || {};

  const plaintext = `Schedule reconciliation for Issaquah — ${payload.dateRange}. ${stats.discrepancies || 0} discrepancies, ${stats.matched || 0} matched. See HTML body for details.`;

  const auth = makeAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const toHeader = recipients.join(', ');
  const boundary = '----send-email-boundary-' + Date.now();
  const rawEmail = [
    `From: ${FROM}`,
    `To: ${toHeader}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    '',
    plaintext,
    '',
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    '',
    html,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');

  const encodedEmail = Buffer.from(rawEmail).toString('base64url');
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodedEmail } });

  console.log(`Email sent in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  To: ${toHeader}`);
  console.log(`  Subject: ${subject}`);
  console.log(`  ID: ${res.data.id}`);
})().catch(err => {
  console.error('send-email.js failed:', err.message);
  process.exit(1);
});
