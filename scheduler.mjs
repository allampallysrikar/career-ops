#!/usr/bin/env node
// scheduler.mjs — Phase 6
// Cron-based job alert scheduler.
// Runs the scanner on a schedule, quick-scores new jobs with Gemini,
// and emails you a digest of high-score matches.
//
// Usage:
//   node scheduler.mjs start        # Start background scheduler (blocks)
//   node scheduler.mjs run-now      # Run one scan cycle immediately
//   node scheduler.mjs status       # Show last run info and upcoming schedule
//   node scheduler.mjs stop         # Stop a running scheduler (kills PID)
//
// Schedule is configured by SCHEDULER_CRON in .env (default: every 4 hours)
// Minimum score alert threshold: SCHEDULER_MIN_SCORE (default: 4.0)

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync, spawn } from 'child_process';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

const ROOT       = process.cwd();
const STATE_FILE = join(ROOT, 'data', '.scheduler-state.json');
const PID_FILE   = join(ROOT, 'data', '.scheduler.pid');
const LOG_FILE   = join(ROOT, 'data', 'scheduler.log');

function log(msg)  { const line = `[${new Date().toISOString()}] ${msg}\n`; process.stderr.write(line); appendLog(line); }
function ok(msg)   { log(`✅ ${msg}`); }
function warn(msg) { log(`⚠️  ${msg}`); }
function die(msg)  { process.stderr.write(`❌ ${msg}\n`); process.exit(1); }

function appendLog(line) {
  try { writeFileSync(LOG_FILE, line, { flag: 'a' }); } catch {}
}

// ── State Management ──────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_FILE)) return { lastRun: null, seenUrls: [], totalAlerts: 0 };
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Cron Parser (simple) ──────────────────────────────────────────────────────

function parseCronExpression(cron) {
  // Supports: "0 */4 * * *" style 5-field cron
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron expression: "${cron}"`);
  return parts;
}

function msUntilNextCron(cronExpr) {
  // Supports: interval form "0 */4 * * *" and fixed-hour "0 9 * * *"
  const [minute, hour] = parseCronExpression(cronExpr);
  const now = new Date();

  let intervalHours = 1;
  if (hour.startsWith('*/')) {
    intervalHours = Math.max(parseInt(hour.slice(2)) || 1, 1); // guard against */0
  } else if (!isNaN(parseInt(hour))) {
    intervalHours = 24; // fixed hour = daily cadence
  }

  const targetMinute = isNaN(parseInt(minute)) ? 0 : Math.max(0, Math.min(59, parseInt(minute)));
  const intervalMs = intervalHours * 60 * 60 * 1000;

  // Find the next aligned trigger time
  const next = new Date(now);
  next.setMinutes(targetMinute, 0, 0);
  // Advance by interval until we're strictly in the future
  let iterations = 0;
  while (next <= now && iterations < 1000) {
    next.setTime(next.getTime() + intervalMs);
    iterations++;
  }

  return Math.max(next.getTime() - now.getTime(), 60_000); // minimum 1 minute
}

// ── Quick Scorer (Gemini) ─────────────────────────────────────────────────────

async function quickScoreJob(job, cvSummary) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') return null;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });

  const prompt = `Rate this job's fit for the candidate on a 1-5 scale. Respond with ONLY a JSON object: {"score": 4.2, "reason": "one sentence"}

Job: ${job.title} at ${job.company} (${job.location})
URL: ${job.url}

Candidate CV summary (first 1500 chars):
${cvSummary}`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const json = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim());
    return { score: parseFloat(json.score) || 0, reason: json.reason || '' };
  } catch {
    return null;
  }
}

// ── Scan Cycle ────────────────────────────────────────────────────────────────

async function runScanCycle() {
  log('Starting scan cycle...');
  const state = loadState();
  const minScore = parseFloat(process.env.SCHEDULER_MIN_SCORE || '4.0');

  // Load CV summary for scoring
  const cvSummary = existsSync(join(ROOT, 'cv.md'))
    ? readFileSync(join(ROOT, 'cv.md'), 'utf8').slice(0, 1500)
    : '';

  if (!cvSummary) {
    warn('cv.md not found — scoring will be skipped. Run: node resume-import.mjs your-resume.pdf');
  }

  // Run the scanner and parse its output
  // scan.mjs writes a Markdown pipeline.md — we diff it against state.seenUrls
  let newJobs = [];
  try {
    execSync('node scan.mjs', { cwd: ROOT, stdio: 'pipe', timeout: 120_000 });
    // Read newly added jobs from pipeline.md
    const pipelineFile = join(ROOT, 'data', 'pipeline.md');
    if (existsSync(pipelineFile)) {
      const pipelineContent = readFileSync(pipelineFile, 'utf8');
      // Parse lines like: - [ ] https://... | Title at Company | ...
      const lines = pipelineContent.match(/^- \[ \].+/gm) || [];
      const allJobs = lines.map(line => {
        const parts = line.replace(/^- \[ \]\s*/, '').split(' | ');
        const url = parts[0]?.trim() || '';
        const label = parts[1]?.trim() || '';
        const [titlePart, companyPart] = label.split(' at ');
        return { url, title: titlePart?.trim() || url, company: companyPart?.trim() || '', location: '' };
      }).filter(j => j.url.startsWith('http'));

      newJobs = allJobs.filter(j => !state.seenUrls.includes(j.url));
      log(`Scanner returned ${allJobs.length} pipeline jobs, ${newJobs.length} new`);
    }
  } catch (err) {
    warn(`Scanner failed: ${err.message}`);
  }

  if (newJobs.length === 0) {
    log('No new jobs found this cycle');
    state.lastRun = new Date().toISOString();
    saveState(state);
    return [];
  }

  // Quick-score new jobs
  const scored = [];
  for (const job of newJobs) {
    const scoring = cvSummary ? await quickScoreJob(job, cvSummary) : null;
    scored.push({ ...job, score: scoring?.score || null, reason: scoring?.reason || '' });
    state.seenUrls.push(job.url);
  }

  // Keep seenUrls manageable (last 2000 entries)
  if (state.seenUrls.length > 2000) state.seenUrls = state.seenUrls.slice(-2000);

  // Enrich jobs with company intel signals
  const enrichedScored = enrichWithCompanyIntel(scored);

  // Separate high-score and unscored, then filter out 'avoid' companies
  const rawHighScore = enrichedScored.filter(j => j.score !== null && j.score >= minScore);
  const unscored     = enrichedScored.filter(j => j.score === null);

  const { keep: highScore, avoided } = filterAvoidCompanies(rawHighScore);

  if (avoided.length > 0) {
    warn(`Filtered out ${avoided.length} job(s) from companies flagged 🔴 AVOID in company-intel:`);
    avoided.forEach(j => warn(`  - ${j.company}: ${j.intelReason}`));
  }

  state.lastRun = new Date().toISOString();
  state.totalAlerts = (state.totalAlerts || 0) + highScore.length;
  saveState(state);

  log(`Scored: ${scored.length} jobs. High score (>=${minScore}): ${highScore.length} (${avoided.length} filtered by intel)`);

  if (highScore.length > 0 || unscored.length > 0) {
    await sendDigestEmail(highScore, unscored, minScore, avoided);
  }

  return highScore;
}

// ── Company Intel Enrichment ──────────────────────────────────────────────────
// Reads cached company intel from data/company-intel.json and attaches signal
// badges to jobs in the digest. Signals: grow 🟢 | caution 🟡 | avoid 🔴

function loadCompanyIntelCache() {
  const intelFile = join(ROOT, 'data', 'company-intel.json');
  if (!existsSync(intelFile)) return {};
  try { return JSON.parse(readFileSync(intelFile, 'utf8')); } catch { return {}; }
}

function enrichWithCompanyIntel(jobs) {
  const cache = loadCompanyIntelCache();
  if (Object.keys(cache).length === 0) return jobs; // no intel yet — pass through

  return jobs.map(job => {
    const key  = (job.company || '').toLowerCase().trim();
    const intel = cache[key];
    if (!intel) return job;

    const emoji = intel.signal === 'grow' ? '🟢' : intel.signal === 'avoid' ? '🔴' : '🟡';
    return { ...job, intelSignal: intel.signal, intelEmoji: emoji, intelSummary: intel.summary || '' };
  });
}

function filterAvoidCompanies(jobs) {
  const cache = loadCompanyIntelCache();
  if (Object.keys(cache).length === 0) return { keep: jobs, avoided: [] };

  const keep    = [];
  const avoided = [];
  for (const job of jobs) {
    const key   = (job.company || '').toLowerCase().trim();
    const intel = cache[key];
    if (intel && intel.signal === 'avoid') {
      avoided.push({ ...job, intelReason: intel.negatives?.[0] || 'Layoffs / hiring freeze detected' });
    } else {
      keep.push(job);
    }
  }
  return { keep, avoided };
}

// ── Digest Email ──────────────────────────────────────────────────────────────

async function sendDigestEmail(highScoreJobs, unscoredJobs, minScore, avoidedJobs = []) {
  const alertEmail = process.env.ALERT_EMAIL;
  if (!alertEmail || alertEmail === 'your_email@example.com') {
    warn('ALERT_EMAIL not set in .env — printing digest to console instead');
    printDigest(highScoreJobs, unscoredJobs, avoidedJobs);
    return;
  }

  const subject = `🎯 JobForge: ${highScoreJobs.length} new match${highScoreJobs.length !== 1 ? 'es' : ''} found`;

  let body = `JobForge Job Digest — ${new Date().toLocaleDateString()}\n\n`;

  if (highScoreJobs.length > 0) {
    body += `🌟 HIGH SCORE MATCHES (>= ${minScore}/5):\n\n`;
    for (const job of highScoreJobs) {
      const intel = job.intelEmoji ? ` ${job.intelEmoji}` : '';
      body += `• ${job.title} at ${job.company}${intel} — Score: ${job.score}/5\n`;
      body += `  ${job.reason}\n`;
      if (job.intelSummary) body += `  Intel: ${job.intelSummary.slice(0, 120)}\n`;
      body += `  Apply: ${job.url}\n\n`;
    }
  }

  if (unscoredJobs.length > 0) {
    body += `\n📋 NEW JOBS (unscored — review manually):\n\n`;
    for (const job of unscoredJobs.slice(0, 10)) {
      const intel = job.intelEmoji ? ` ${job.intelEmoji}` : '';
      body += `• ${job.title} at ${job.company}${intel} (${job.location})\n  ${job.url}\n\n`;
    }
  }

  if (avoidedJobs.length > 0) {
    body += `\n🔴 FILTERED (company intel flagged as AVOID — not recommended):\n\n`;
    for (const job of avoidedJobs) {
      body += `• ${job.title} at ${job.company} — ${job.intelReason}\n`;
    }
    body += '\nRun "node company-intel.mjs --company <name> --refresh" to update intel.\n';
  }

  body += `\n─────────────────────────────────\nRun "node scan.mjs" to process pipeline | "node scheduler.mjs status" to check schedule`;

  // Send via Gmail if configured
  const tokenFile = join(ROOT, 'data', '.gmail-token.json');
  if (existsSync(tokenFile)) {
    try {
      // Dynamically import send-email's Gmail sender
      const tokenData = JSON.parse(readFileSync(tokenFile, 'utf8'));
      const refreshToken = tokenData.refresh_token;
      if (!refreshToken) throw new Error('No refresh token stored');

      // Refresh access token
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token:  refreshToken,
          client_id:      process.env.GMAIL_CLIENT_ID || '',
          client_secret:  process.env.GMAIL_CLIENT_SECRET || '',
          grant_type:     'refresh_token',
        }),
      });
      const tokenResp = await res.json();
      const accessToken = tokenResp.access_token;
      if (!accessToken) throw new Error('Token refresh failed');

      // Build RFC 2822 message
      const message = [`To: ${alertEmail}`, `Subject: ${subject}`, `Content-Type: text/plain; charset=utf-8`, `MIME-Version: 1.0`, '', body].join('\r\n');
      const encoded = Buffer.from(message).toString('base64url');

      const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: encoded }),
      });
      const sendData = await sendRes.json();
      if (sendData.error) throw new Error(sendData.error.message);

      ok(`Digest email sent to ${alertEmail} (${highScoreJobs.length} matches)`);
      return;
    } catch (err) {
      warn(`Gmail send failed: ${err.message} — printing digest to console`);
    }
  } else {
    warn('Gmail not configured (run: npm run email:auth) — printing digest to console');
  }

  printDigest(highScoreJobs, unscoredJobs, avoidedJobs);
}

function printDigest(highScoreJobs, unscoredJobs, avoidedJobs = []) {
  console.log('\n🎯 JOB DIGEST:\n');
  for (const job of highScoreJobs) {
    const intel = job.intelEmoji ? ` ${job.intelEmoji}` : '';
    console.log(`  ⭐ ${job.title} at ${job.company}${intel} — ${job.score}/5`);
    console.log(`     ${job.url}`);
  }
  if (unscoredJobs.length > 0) {
    console.log(`\n  📋 ${unscoredJobs.length} new unscored jobs — run: node scan.mjs`);
  }
  if (avoidedJobs.length > 0) {
    console.log(`\n  🔴 ${avoidedJobs.length} job(s) filtered (company intel: AVOID)`);
    avoidedJobs.forEach(j => console.log(`     - ${j.company}: ${j.intelReason}`));
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

function showStatus() {
  const state = loadState();
  const cronExpr = process.env.SCHEDULER_CRON || '0 */4 * * *';
  const msUntilNext = msUntilNextCron(cronExpr);
  const nextRun = new Date(Date.now() + msUntilNext);

  console.log('\n📅 Scheduler Status:\n');
  console.log(`  Cron expression: ${cronExpr}`);
  console.log(`  Last run:        ${state.lastRun || 'Never'}`);
  console.log(`  Next run:        ${nextRun.toLocaleString()} (in ${Math.round(msUntilNext / 60000)} minutes)`);
  console.log(`  Jobs seen:       ${state.seenUrls?.length || 0}`);
  console.log(`  Total alerts:    ${state.totalAlerts || 0}`);
  console.log(`  Min score:       ${process.env.SCHEDULER_MIN_SCORE || '4.0'}/5`);
  console.log(`  Alert email:     ${process.env.ALERT_EMAIL || '(not set)'}`);
  console.log('');
}

// ── Main Loop ─────────────────────────────────────────────────────────────────

async function startScheduler() {
  const cronExpr = process.env.SCHEDULER_CRON || '0 */4 * * *';
  log(`Scheduler started. Cron: "${cronExpr}". Min score: ${process.env.SCHEDULER_MIN_SCORE || 4.0}`);

  // Write PID file
  writeFileSync(PID_FILE, String(process.pid));

  // Run immediately on start
  await runScanCycle();

  // Then loop
  while (true) {
    const delay = msUntilNextCron(cronExpr);
    log(`Next scan in ${Math.round(delay / 60000)} minutes`);
    await new Promise(r => setTimeout(r, delay));
    await runScanCycle();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cmd = process.argv[2] || 'help';

  switch (cmd) {
    case 'start':    return startScheduler();
    case 'run-now':  return runScanCycle();
    case 'status':   return showStatus();
    case 'stop':
      if (existsSync(PID_FILE)) {
        const pid = readFileSync(PID_FILE, 'utf8').trim();
        try { process.kill(parseInt(pid), 'SIGTERM'); ok(`Stopped scheduler (PID ${pid})`); } catch { warn('Process not running'); }
      } else warn('No PID file found — scheduler may not be running');
      break;
    default:
      console.log(`
scheduler — Automated job alert runner

Usage:
  node scheduler.mjs start      Start background scheduler (runs continuously)
  node scheduler.mjs run-now    Run one scan cycle immediately
  node scheduler.mjs status     Show schedule and last run info
  node scheduler.mjs stop       Stop the running scheduler

Configure in .env:
  SCHEDULER_CRON=0 */4 * * *    Schedule (default: every 4 hours)
  SCHEDULER_MIN_SCORE=4.0        Alert threshold (default: 4.0/5)
  ALERT_EMAIL=you@example.com    Where to send digests
`);
  }
}

main().catch(err => die(err.message));
