#!/usr/bin/env node
// linkedin-apply.mjs — Phase 11c (v2.2)
// Playwright-based LinkedIn Easy Apply automation.
// Reads jobs from data/pipeline.md, auto-fills and submits Easy Apply forms.
//
// PREREQUISITES:
//   1. npm install playwright (already in package.json)
//   2. npx playwright install chromium
//   3. Set LINKEDIN_EMAIL and LINKEDIN_PASSWORD in .env
//   4. Ensure your resume PDF is at output/resume.pdf (or set RESUME_PDF in .env)
//
// Usage:
//   node linkedin-apply.mjs --url "https://www.linkedin.com/jobs/view/..."
//   node linkedin-apply.mjs --all          # Apply to all pending pipeline jobs
//   node linkedin-apply.mjs --dry-run      # Navigate + screenshot but don't submit
//   node linkedin-apply.mjs --status       # Show pipeline stats only
//
// Output:
//   data/linkedin-apply-log.json   Per-application outcome log
//   screenshots/                   Saved screenshots per application

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { chromium } from 'playwright';
import 'dotenv/config';

const ROOT         = resolve(process.cwd());
const PIPELINE_FILE= join(ROOT, 'data', 'pipeline.md');
const TRACKER_FILE = join(ROOT, 'data', 'applications.md');
const LOG_FILE     = join(ROOT, 'data', 'linkedin-apply-log.json');
const SCREENSHOTS  = join(ROOT, 'screenshots');
const RESUME_PDF   = process.env.RESUME_PDF || join(ROOT, 'output', 'resume.pdf');

// Selectors — LinkedIn occasionally shuffles class names, but aria labels are stable
const SEL = {
  emailInput:        '#username',
  passwordInput:     '#password',
  loginButton:       '[data-litms-control-urn="login-submit"]',
  easyApplyButton:   'button[aria-label*="Easy Apply"]',
  nextButton:        'button[aria-label="Continue to next step"]',
  reviewButton:      'button[aria-label="Review your application"]',
  submitButton:      'button[aria-label="Submit application"]',
  closeModal:        'button[aria-label="Dismiss"]',
  followCheckbox:    'input[id*="follow-company"]',
  contactNameField:  'input[id*="contactName"], input[placeholder*="name"]',
  phoneField:        'input[id*="phoneNumber"], input[type="tel"]',
  resumeUpload:      'input[type="file"]',
  errorMessages:     '.artdeco-inline-feedback--error',
  formFields:        'input:not([type="hidden"]):not([type="file"]), select, textarea',
  successModal:      '.jobs-easy-apply-content',
  jobTitle:          'h1.job-details-jobs-unified-top-card__job-title',
  companyName:       'a.job-details-jobs-unified-top-card__company-name',
  applicationSent:   '.artdeco-inline-feedback--success, [data-test-modal-id="easy-apply-success-modal"]',
};

function log(msg)  { process.stderr.write(`[linkedin-apply] ${msg}\n`); }
function ok(msg)   { process.stderr.write(`✅ ${msg}\n`); }
function warn(msg) { process.stderr.write(`⚠️  ${msg}\n`); }
function die(msg)  { process.stderr.write(`❌ ${msg}\n`); process.exit(1); }

// ── CLI Args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { url: null, all: false, dryRun: false, status: false, help: false, headless: true };
  for (let i = 0; i < args.length; i++) {
    if      (args[i] === '--url'     && args[i+1]) flags.url     = args[++i];
    else if (args[i] === '--all')    flags.all     = true;
    else if (args[i] === '--dry-run')flags.dryRun  = true;
    else if (args[i] === '--status') flags.status  = true;
    else if (args[i] === '--show')   flags.headless = false;  // --show opens visible browser
    else if (args[i] === '--help' || args[i] === '-h') flags.help = true;
  }
  return flags;
}

function printHelp() {
  console.log(`
linkedin-apply — Automate LinkedIn Easy Apply submissions

Usage:
  node linkedin-apply.mjs --url <linkedin-job-url>    Apply to one job
  node linkedin-apply.mjs --all                       Apply to all pending pipeline jobs
  node linkedin-apply.mjs --dry-run                   Navigate + screenshot, no submit
  node linkedin-apply.mjs --status                    Print pipeline stats
  node linkedin-apply.mjs --show                      Open visible browser (debugging)

Prerequisites:
  1. npx playwright install chromium
  2. LINKEDIN_EMAIL + LINKEDIN_PASSWORD in .env
  3. Resume PDF at output/resume.pdf (or RESUME_PDF in .env)

Output:
  data/linkedin-apply-log.json   Outcome per application
  screenshots/                   Evidence screenshots
`);
}

// ── Pipeline Parser ───────────────────────────────────────────────────────────

function loadPipeline() {
  if (!existsSync(PIPELINE_FILE)) return [];
  const content = readFileSync(PIPELINE_FILE, 'utf8');
  const jobs = [];
  for (const line of content.split('\n')) {
    if (!line.startsWith('- [')) continue;
    const done = line.startsWith('- [x]');
    const rest = line.replace(/^- \[[ x]\]\s*/, '');
    const parts = rest.split(' | ');
    const url = parts[0]?.trim();
    if (!url || !url.includes('linkedin.com/jobs')) continue;
    const titleAt = parts[1]?.trim() || '';
    const titleMatch = titleAt.match(/^(.+?) at (.+)$/);
    jobs.push({
      url,
      title:   titleMatch?.[1]?.trim() || titleAt,
      company: titleMatch?.[2]?.trim() || 'Unknown',
      applied: done,
    });
  }
  return jobs;
}

function markPipelineApplied(url) {
  if (!existsSync(PIPELINE_FILE)) return;
  let content = readFileSync(PIPELINE_FILE, 'utf8');
  // Replace "- [ ] <url>" with "- [x] <url>"
  content = content.replace(new RegExp(`- \\[ \\] ${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `- [x] ${url}`);
  writeFileSync(PIPELINE_FILE, content, 'utf8');
}

function addToTracker(company, role, status = 'Applied') {
  if (!existsSync(TRACKER_FILE)) return;
  let content = readFileSync(TRACKER_FILE, 'utf8');
  const lines = content.split('\n');
  // Find highest ID
  let maxId = 0;
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    const id = parseInt(cells[0]);
    if (!isNaN(id) && id > maxId) maxId = id;
  }
  const date = new Date().toISOString().split('T')[0];
  const newRow = `| ${maxId + 1} | ${date} | ${company} | ${role} | — | ${status} | — | — |`;
  // Insert before last blank/non-table line
  const insertAt = lines.findLastIndex(l => l.startsWith('|'));
  lines.splice(insertAt + 1, 0, newRow);
  writeFileSync(TRACKER_FILE, lines.join('\n'), 'utf8');
}

// ── Log Helpers ───────────────────────────────────────────────────────────────

function loadLog() {
  return existsSync(LOG_FILE) ? JSON.parse(readFileSync(LOG_FILE, 'utf8')) : [];
}

function appendLog(entry) {
  const log = loadLog();
  log.push({ ...entry, timestamp: new Date().toISOString() });
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2), 'utf8');
}

function isAlreadyApplied(url) {
  return loadLog().some(e => e.url === url && e.outcome === 'applied');
}

// ── CV Data Extractor ─────────────────────────────────────────────────────────

function extractCVData() {
  const cvFile = join(ROOT, 'cv.md');
  if (!existsSync(cvFile)) return {};
  const content = readFileSync(cvFile, 'utf8');
  return {
    name:     content.match(/^#\s+(.+)/m)?.[1]?.trim() || '',
    email:    content.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i)?.[0] || '',
    phone:    content.match(/(?:\+?\d[\d\s\-().]{7,}\d)/)?.[0] || '',
    linkedin: content.match(/linkedin\.com\/in\/([\w-]+)/i)?.[1] || '',
    city:     content.match(/📍\s*([^\n|,]+)/)?.[1]?.trim() || '',
    website:  content.match(/https?:\/\/(?!linkedin)[^\s)]+/)?.[0] || '',
  };
}

// ── Form Auto-Fill ────────────────────────────────────────────────────────────

async function smartFillField(field, cvData) {
  const label   = await field.getAttribute('aria-label') || '';
  const id      = await field.getAttribute('id') || '';
  const placeholder = await field.getAttribute('placeholder') || '';
  const hint    = (label + id + placeholder).toLowerCase();
  const tag     = await field.evaluate(el => el.tagName.toLowerCase());
  const type    = await field.getAttribute('type') || 'text';

  // Skip hidden / file inputs
  if (type === 'hidden' || type === 'file' || type === 'checkbox' || type === 'radio') return;

  let value = null;

  if (/phone|tel|mobile/i.test(hint))        value = cvData.phone;
  else if (/email/i.test(hint))              value = cvData.email;
  else if (/first.*name|firstname/i.test(hint)) value = cvData.name.split(' ')[0];
  else if (/last.*name|lastname|surname/i.test(hint)) value = cvData.name.split(' ').slice(-1)[0];
  else if (/full.*name|yourname/i.test(hint))value = cvData.name;
  else if (/city|location/i.test(hint))      value = cvData.city;
  else if (/website|portfolio|url/i.test(hint)) value = cvData.website;
  else if (/linkedin/i.test(hint))           value = cvData.linkedin ? `https://linkedin.com/in/${cvData.linkedin}` : '';
  else if (/year.*exp|experience.*year/i.test(hint)) value = '5'; // sensible default
  else if (/salary.*expect|desired.*salary/i.test(hint)) value = ''; // leave blank — negotiate later
  else if (/cover.*letter/i.test(hint))      return; // skip — we have our own cover letter

  if (tag === 'select') {
    if (value) {
      // Try to select matching option
      const options = await field.locator('option').all();
      for (const opt of options) {
        const text = await opt.textContent();
        if (text?.toLowerCase().includes(value.toLowerCase())) {
          await field.selectOption({ label: text.trim() });
          return;
        }
      }
      // Fallback: pick first non-empty option
      await field.selectOption({ index: 1 });
    }
    return;
  }

  if (value) {
    await field.fill(value);
  }
}

async function handleFormStep(page, cvData, dryRun) {
  // Wait for form to stabilize
  await page.waitForTimeout(1000);

  // Fill all visible form fields
  const fields = await page.$$(SEL.formFields);
  for (const field of fields) {
    try {
      const visible = await field.isVisible();
      if (!visible) continue;
      await smartFillField(field, cvData);
    } catch { /* ignore individual field errors */ }
  }

  // Handle resume upload if field exists
  if (!dryRun && existsSync(RESUME_PDF)) {
    const uploadInputs = await page.$$('input[type="file"]');
    for (const input of uploadInputs) {
      try {
        await input.setInputFiles(RESUME_PDF);
        log('Uploaded resume PDF');
        await page.waitForTimeout(1500);
        break; // usually only one resume slot
      } catch { /* already uploaded or not needed */ }
    }
  }

  // Uncheck "Follow company" if present (noise in feed)
  try {
    const followBox = await page.$(SEL.followCheckbox);
    if (followBox && await followBox.isChecked()) await followBox.uncheck();
  } catch { /* not present */ }
}

// ── Screenshot Helper ─────────────────────────────────────────────────────────

async function screenshot(page, slug, label) {
  if (!existsSync(SCREENSHOTS)) mkdirSync(SCREENSHOTS, { recursive: true });
  const file = join(SCREENSHOTS, `${slug}-${label}.png`);
  await page.screenshot({ path: file, fullPage: false });
  log(`Screenshot → ${file}`);
}

// ── LinkedIn Login ────────────────────────────────────────────────────────────

async function ensureLoggedIn(page) {
  const email    = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;

  if (!email || !password) {
    die('Set LINKEDIN_EMAIL and LINKEDIN_PASSWORD in your .env file');
  }

  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Already logged in?
  if (page.url().includes('/feed') || page.url().includes('/jobs')) {
    log('Already logged in');
    return;
  }

  await page.fill(SEL.emailInput, email);
  await page.fill(SEL.passwordInput, password);
  await page.click(SEL.loginButton);
  await page.waitForTimeout(3000);

  if (page.url().includes('/checkpoint') || page.url().includes('/challenge')) {
    warn('LinkedIn security challenge detected — manual intervention required');
    warn('Switch to --show mode to complete CAPTCHA, then re-run');
    die('Login blocked by security challenge');
  }

  if (!page.url().includes('/feed') && !page.url().includes('/jobs')) {
    die('Login failed — check LINKEDIN_EMAIL and LINKEDIN_PASSWORD');
  }
  ok('Logged in to LinkedIn');
}

// ── Apply to One Job ──────────────────────────────────────────────────────────

async function applyToJob(page, url, cvData, dryRun) {
  const slug = url.replace(/[^a-z0-9]/gi, '-').slice(-40);
  log(`Navigating to ${url}`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(2000);

  await screenshot(page, slug, '01-job-page');

  // Extract job title / company from page
  let jobTitle = '', company = '';
  try { jobTitle = await page.$eval(SEL.jobTitle, el => el.textContent?.trim()); } catch {}
  try { company  = await page.$eval(SEL.companyName, el => el.textContent?.trim()); } catch {}
  log(`Job: ${jobTitle || 'Unknown'} @ ${company || 'Unknown'}`);

  // Find Easy Apply button
  const easyApplyBtn = await page.$(SEL.easyApplyButton);
  if (!easyApplyBtn) {
    warn(`No Easy Apply button found at ${url} — job may require external application`);
    return { outcome: 'no-easy-apply', url, jobTitle, company };
  }

  await easyApplyBtn.click();
  await page.waitForTimeout(2000);
  await screenshot(page, slug, '02-modal-open');

  // Multi-step form loop
  let stepCount = 0;
  const MAX_STEPS = 10;

  while (stepCount < MAX_STEPS) {
    stepCount++;
    log(`Form step ${stepCount}`);

    // Check for errors from previous step
    const errors = await page.$$(SEL.errorMessages);
    if (errors.length > 0) {
      const msgs = await Promise.all(errors.map(e => e.textContent()));
      warn(`Validation errors: ${msgs.join(', ')}`);
    }

    // Fill current step
    await handleFormStep(page, cvData, dryRun);
    await page.waitForTimeout(500);
    await screenshot(page, slug, `0${stepCount + 2}-step-${stepCount}`);

    if (dryRun) {
      log(`[DRY RUN] Step ${stepCount} filled — stopping before submission`);
      return { outcome: 'dry-run', url, jobTitle, company };
    }

    // Check for Submit button first
    const submitBtn = await page.$(SEL.submitButton);
    if (submitBtn && await submitBtn.isVisible()) {
      log('Found Submit button — submitting application');
      await submitBtn.click();
      await page.waitForTimeout(3000);
      await screenshot(page, slug, `${stepCount + 3}-submitted`);
      ok(`Submitted: ${jobTitle} @ ${company}`);
      return { outcome: 'applied', url, jobTitle, company };
    }

    // Check for Review button
    const reviewBtn = await page.$(SEL.reviewButton);
    if (reviewBtn && await reviewBtn.isVisible()) {
      log('Review step');
      await reviewBtn.click();
      await page.waitForTimeout(1500);
      continue;
    }

    // Check for Next button
    const nextBtn = await page.$(SEL.nextButton);
    if (nextBtn && await nextBtn.isVisible()) {
      await nextBtn.click();
      await page.waitForTimeout(1500);
      continue;
    }

    // No more navigation buttons — check if already succeeded
    const success = await page.$(SEL.applicationSent);
    if (success) {
      ok(`Application confirmed: ${jobTitle} @ ${company}`);
      return { outcome: 'applied', url, jobTitle, company };
    }

    // Fallback: look for any primary/submit-like button
    const anyPrimary = await page.$('button.artdeco-button--primary');
    if (anyPrimary && await anyPrimary.isVisible()) {
      const txt = await anyPrimary.textContent();
      if (/submit|send|apply/i.test(txt || '')) {
        await anyPrimary.click();
        await page.waitForTimeout(2000);
        return { outcome: 'applied', url, jobTitle, company };
      }
      await anyPrimary.click();
      await page.waitForTimeout(1500);
      continue;
    }

    // If we reach here, the form is in an unknown state
    warn(`Step ${stepCount}: unable to advance — form may need manual review`);
    await screenshot(page, slug, `${stepCount + 3}-stuck`);
    return { outcome: 'stuck', url, jobTitle, company };
  }

  warn(`Reached max steps (${MAX_STEPS}) — form not completed`);
  return { outcome: 'max-steps', url, jobTitle, company };
}

// ── Status Command ────────────────────────────────────────────────────────────

function printStatus() {
  const pipeline = loadPipeline();
  const appLog   = loadLog();
  const pending  = pipeline.filter(j => !j.applied);
  const applied  = appLog.filter(e => e.outcome === 'applied');
  const failed   = appLog.filter(e => !['applied', 'dry-run'].includes(e.outcome));

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📊  LinkedIn Apply Status`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`  Pipeline jobs:   ${pipeline.length} total · ${pending.length} pending`);
  console.log(`  Applied via bot: ${applied.length}`);
  console.log(`  Errors/stuck:    ${failed.length}`);
  if (applied.length > 0) {
    console.log(`\n  Recent applications:`);
    applied.slice(-5).reverse().forEach(e => {
      const d = new Date(e.timestamp).toLocaleDateString();
      console.log(`    ✅ ${e.jobTitle || 'Unknown'} @ ${e.company || 'Unknown'} (${d})`);
    });
  }
  console.log();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv);
  if (flags.help) { printHelp(); process.exit(0); }
  if (flags.status) { printStatus(); process.exit(0); }

  // Validate credentials
  if (!process.env.LINKEDIN_EMAIL || !process.env.LINKEDIN_PASSWORD) {
    die('Set LINKEDIN_EMAIL and LINKEDIN_PASSWORD in .env before running');
  }

  // Build job list
  let jobUrls = [];
  if (flags.url) {
    jobUrls = [flags.url];
  } else if (flags.all) {
    const pipeline = loadPipeline();
    jobUrls = pipeline
      .filter(j => !j.applied)
      .filter(j => !isAlreadyApplied(j.url))
      .map(j => j.url);
    if (jobUrls.length === 0) { warn('No pending LinkedIn jobs in pipeline.'); process.exit(0); }
    log(`Found ${jobUrls.length} pending job(s) in pipeline`);
  } else {
    printHelp();
    die('Specify --url <linkedin-url> or --all');
  }

  if (flags.dryRun) warn('DRY RUN mode — forms will be filled but NOT submitted');
  if (!flags.headless) warn('Running in visible browser mode');

  const cvData  = extractCVData();
  const browser = await chromium.launch({
    headless: flags.headless,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  try {
    await ensureLoggedIn(page);

    let applied = 0; let failed = 0;

    for (let i = 0; i < jobUrls.length; i++) {
      const url = jobUrls[i];
      log(`\n[${i + 1}/${jobUrls.length}] Processing ${url}`);

      if (!flags.dryRun && isAlreadyApplied(url)) {
        warn('Already applied — skipping');
        continue;
      }

      try {
        const result = await applyToJob(page, url, cvData, flags.dryRun);
        appendLog(result);

        if (result.outcome === 'applied') {
          markPipelineApplied(url);
          addToTracker(result.company, result.jobTitle || 'Unknown Role');
          applied++;
        } else if (result.outcome === 'dry-run') {
          applied++; // count as success in dry-run
        } else {
          failed++;
        }

        // Polite delay between applications (avoid rate limiting)
        if (i < jobUrls.length - 1) {
          const delay = 5000 + Math.random() * 3000;
          log(`Waiting ${Math.round(delay / 1000)}s before next application...`);
          await page.waitForTimeout(delay);
        }
      } catch (err) {
        warn(`Error on ${url}: ${err.message}`);
        appendLog({ url, outcome: 'error', error: err.message });
        failed++;
      }
    }

    console.log(`\n✅ Done: ${applied} applied · ${failed} failed`);
    if (!flags.dryRun) console.log(`   Log → data/linkedin-apply-log.json`);
    console.log(`   Screenshots → screenshots/\n`);

  } finally {
    await browser.close();
  }
}

main().catch(err => die(err?.message || String(err)));
