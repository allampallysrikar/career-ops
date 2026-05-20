#!/usr/bin/env node
// send-email.mjs — Phase 5b
// Sends cold emails and follow-ups via Gmail or Outlook.
// Also includes an inbox reply parser that auto-updates the tracker.
//
// Usage:
//   node send-email.mjs --auth                              # First-time Gmail OAuth login
//   node send-email.mjs --to "jane@stripe.com" --job "Stripe - AI Engineer"  # Send cold email
//   node send-email.mjs --follow-ups                        # Send all due follow-ups
//   node send-email.mjs --parse-inbox                       # Parse replies & update tracker
//   node send-email.mjs --provider outlook --auth           # Outlook instead of Gmail

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { createServer } from 'http';
import 'dotenv/config';

const ROOT          = process.cwd();
const TOKEN_FILE    = join(ROOT, 'data', '.gmail-token.json');
const CONTACTS_FILE = join(ROOT, 'data', 'contacts.md');
const TRACKER_FILE  = join(ROOT, 'data', 'applications.md');
const FOLLOWUPS_FILE = join(ROOT, 'data', 'follow-ups.md');

// Rate limiting: max 20 emails/day, 5-second minimum gap between sends
const MAX_DAILY_SENDS = 20;
const SEND_GAP_MS = 5000;

function log(msg)  { process.stderr.write(`[send-email] ${msg}\n`); }
function ok(msg)   { process.stderr.write(`✅ ${msg}\n`); }
function warn(msg) { process.stderr.write(`⚠️  ${msg}\n`); }
function die(msg)  { process.stderr.write(`❌ ${msg}\n`); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Gmail OAuth2 ──────────────────────────────────────────────────────────────

function getGmailOAuthUrl() {
  const clientId    = process.env.GMAIL_CLIENT_ID;
  const redirectUri = process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth/gmail/callback';
  const scopes = [
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
  ].join(' ');

  return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent`;
}

async function exchangeCodeForTokens(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      redirect_uri:  process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth/gmail/callback',
      grant_type:    'authorization_code',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token exchange failed: ${JSON.stringify(data)}`);
  return data;
}

async function refreshAccessToken() {
  if (!existsSync(TOKEN_FILE)) die('No Gmail token found — run: node send-email.mjs --auth');
  const stored = JSON.parse(readFileSync(TOKEN_FILE, 'utf8'));
  if (!stored.refresh_token) die('No refresh token — run: node send-email.mjs --auth again');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token:  stored.refresh_token,
      client_id:      process.env.GMAIL_CLIENT_ID,
      client_secret:  process.env.GMAIL_CLIENT_SECRET,
      grant_type:     'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);

  // Save updated token
  writeFileSync(TOKEN_FILE, JSON.stringify({ ...stored, ...data, refreshed_at: Date.now() }, null, 2));
  return data.access_token;
}

async function gmailAuth() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  if (!clientId || clientId === 'your_gmail_client_id_here') {
    die('GMAIL_CLIENT_ID not set in .env\nSetup guide: https://console.cloud.google.com/ → APIs → Gmail API → OAuth2 credentials');
  }

  const port = parseInt(process.env.DASHBOARD_PORT || '3000');
  const authUrl = getGmailOAuthUrl();

  console.log('\n🔐 Gmail OAuth2 Setup\n');
  console.log('1. Open this URL in your browser:');
  console.log(`\n   ${authUrl}\n`);
  console.log('2. Authorize the app, then you\'ll be redirected to localhost');
  console.log('3. Waiting for callback...\n');

  // Start a temporary server to catch the OAuth callback
  await new Promise((done, fail) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (!url.pathname.includes('/oauth/gmail/callback')) {
        res.end('Not found'); return;
      }

      const code = url.searchParams.get('code');
      if (!code) { res.end('No code received'); fail(new Error('No code')); return; }

      try {
        const tokens = await exchangeCodeForTokens(code);
        if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true });
        writeFileSync(TOKEN_FILE, JSON.stringify({ ...tokens, saved_at: Date.now() }, null, 2));
        res.end('<h2>✅ Gmail connected! You can close this tab.</h2>');
        ok('Gmail token saved — you can now send emails');
        server.close();
        done();
      } catch (err) {
        res.end(`<h2>❌ Error: ${err.message}</h2>`);
        fail(err);
      }
    });
    server.listen(port, () => log(`OAuth server listening on port ${port}`));
  });
}

// ── Gmail Send ────────────────────────────────────────────────────────────────

async function sendGmail({ to, subject, body, replyToMessageId }) {
  const accessToken = await refreshAccessToken();

  // Build RFC 2822 message
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
  ];
  if (replyToMessageId) headers.push(`In-Reply-To: ${replyToMessageId}`, `References: ${replyToMessageId}`);

  const message = [...headers, '', body].join('\r\n');
  const encoded = Buffer.from(message).toString('base64url');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: encoded }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Gmail send failed: ${data.error.message}`);
  return data.id;
}

// ── Inbox Parser ──────────────────────────────────────────────────────────────

async function parseInbox() {
  log('Parsing Gmail inbox for job-related replies...');
  const accessToken = await refreshAccessToken();

  // Search for emails matching our sent cold email subjects
  const query = encodeURIComponent('in:anywhere label:career-ops OR (subject:"application" OR subject:"opportunity" OR subject:"position") newer_than:30d');
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=50`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });
  const data = await res.json();
  const messages = data.messages || [];

  log(`Found ${messages.length} relevant messages`);
  let updated = 0;

  for (const msg of messages) {
    const detail = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }).then(r => r.json());

    const headers = detail.payload?.headers || [];
    const from    = headers.find(h => h.name === 'From')?.value || '';
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const snippet = detail.snippet || '';

    // Classify the reply
    const lower = `${subject} ${snippet}`.toLowerCase();
    let status = null;

    if (/interview|schedule|calendly|zoom|meet|call|chat/.test(lower)) {
      status = 'Entrevista';
      ok(`Interview detected: ${from} — "${subject}"`);
    } else if (/reject|unfortunately|not.{0,20}moving forward|other candidate|filled/.test(lower)) {
      status = 'Rechazada';
      log(`Rejection detected: ${from}`);
    } else if (/thank|received|application|will review|get back/.test(lower)) {
      status = 'Respondido';
      log(`Acknowledgement detected: ${from}`);
    }

    if (status) {
      // Try to match to a tracker entry by sender domain
      const senderDomain = from.match(/@([\w.-]+)/)?.[1] || '';
      if (senderDomain && existsSync(TRACKER_FILE)) {
        let tracker = readFileSync(TRACKER_FILE, 'utf8');
        const companyRe = new RegExp(`(\\|[^|]*\\|[^|]*\\|[^|]*${senderDomain.split('.')[0]}[^|]*)\\|[^|]+\\|`, 'i');
        if (companyRe.test(tracker)) {
          tracker = tracker.replace(companyRe, `$1| ${status} |`);
          writeFileSync(TRACKER_FILE, tracker, 'utf8');
          ok(`Tracker updated: ${senderDomain.split('.')[0]} → ${status}`);
          updated++;
        }
      }
    }
  }

  console.log(`\n📬 Inbox parse complete: ${updated} tracker entries updated`);
}

// ── Rate Limiter ──────────────────────────────────────────────────────────────

function getSendCountToday() {
  const logFile = join(ROOT, 'data', '.send-log.json');
  if (!existsSync(logFile)) return 0;
  const sendLog = JSON.parse(readFileSync(logFile, 'utf8'));
  const today = new Date().toISOString().split('T')[0];
  return (sendLog.dates || {})[today] || 0;
}

function incrementSendCount() {
  const logFile = join(ROOT, 'data', '.send-log.json');
  const sendLog = existsSync(logFile) ? JSON.parse(readFileSync(logFile, 'utf8')) : { dates: {} };
  const today = new Date().toISOString().split('T')[0];
  sendLog.dates[today] = (sendLog.dates[today] || 0) + 1;
  writeFileSync(logFile, JSON.stringify(sendLog, null, 2));
}

// ── Email Content Generation ──────────────────────────────────────────────────

async function generateColdEmail(to, jobSlug) {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });

  const cvContent = existsSync(join(ROOT, 'cv.md')) ? readFileSync(join(ROOT, 'cv.md'), 'utf8') : '';

  const prompt = `Write a cold email for a job application. Rules:
- Under 150 words
- Subject line: specific and intriguing, not generic
- No "I hope this email finds you well" or similar opener
- Lead with the strongest proof point from the CV
- One specific reason why this company is interesting
- Clear single CTA: a brief 20-minute call
- Warm but professional tone
- Sign off with name from CV

CV Summary (first 2000 chars):
${cvContent.slice(0, 2000)}

Job/Company: ${jobSlug}
Recipient email: ${to}

Output format:
SUBJECT: [subject line here]

[email body here]`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const subjectMatch = text.match(/^SUBJECT:\s*(.+)/m);
  const subject = subjectMatch ? subjectMatch[1].trim() : `Quick intro — ${jobSlug}`;
  const body = text.replace(/^SUBJECT:.*\n\n?/m, '').trim();
  return { subject, body };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const flags = { auth: false, parseInbox: false, followUps: false, to: null, job: null, provider: 'gmail' };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--auth')          flags.auth = true;
    if (args[i] === '--parse-inbox')   flags.parseInbox = true;
    if (args[i] === '--follow-ups')    flags.followUps = true;
    if (args[i] === '--to' && args[i + 1])  flags.to  = args[++i];
    if (args[i] === '--job' && args[i + 1]) flags.job = args[++i];
    if (args[i] === '--provider' && args[i + 1]) flags.provider = args[++i];
  }

  if (flags.auth)       return gmailAuth();
  if (flags.parseInbox) return parseInbox();
  if (flags.followUps)  {
    warn('--follow-ups: run the existing follow-up cadence tool instead: node followup-cadence.mjs');
    warn('Then review the output and send individual follow-ups with: node send-email.mjs --to <email>');
    return;
  }

  if (flags.to) {
    const sentToday = getSendCountToday();
    if (sentToday >= MAX_DAILY_SENDS) {
      die(`Daily limit reached (${MAX_DAILY_SENDS} emails/day). Try again tomorrow.`);
    }

    const { subject, body } = await generateColdEmail(flags.to, flags.job || 'the role');

    console.log('\n📧 Generated cold email:\n');
    console.log(`To: ${flags.to}`);
    console.log(`Subject: ${subject}`);
    console.log('\n' + body);
    console.log('\n─────────────────────────────────────────');

    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => rl.question('\nSend this email? (y/N): ', resolve));
    rl.close();

    if (answer.toLowerCase() === 'y') {
      await sleep(SEND_GAP_MS);
      const msgId = await sendGmail({ to: flags.to, subject, body });
      incrementSendCount();
      ok(`Email sent! Message ID: ${msgId} (${sentToday + 1}/${MAX_DAILY_SENDS} today)`);
    } else {
      warn('Send cancelled');
    }
    return;
  }

  console.log(`
send-email — Send cold emails and parse Gmail replies

Usage:
  node send-email.mjs --auth                               First-time Gmail setup
  node send-email.mjs --to "name@company.com" --job "Co - Role"  Send cold email
  node send-email.mjs --parse-inbox                        Parse replies, update tracker
  node send-email.mjs --follow-ups                         Send overdue follow-ups
`);
}

main().catch(err => die(err.message));
