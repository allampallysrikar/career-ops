#!/usr/bin/env node
// cover-letter.mjs — Phase 10b
// Generates a tailored one-page cover letter for each job.
// Outputs both a Markdown file and a PDF (via generate-pdf.mjs).
//
// Usage:
//   node cover-letter.mjs --report "reports/stripe-ai-eng.md"
//   node cover-letter.mjs --job "Stripe" --role "AI Engineer"
//   node cover-letter.mjs --all        # All pending jobs in tracker
//   node cover-letter.mjs --preview    # Print to console without saving
//
// Output:
//   output/{company}-{role}-cover-letter.md
//   output/{company}-{role}-cover-letter.pdf

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, resolve, basename } from 'path';
import { execSync } from 'child_process';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

const ROOT         = process.cwd();
const CV_FILE      = join(ROOT, 'cv.md');
const REPORTS_DIR  = join(ROOT, 'reports');
const TRACKER_FILE = join(ROOT, 'data', 'applications.md');
const OUTPUT_DIR   = join(ROOT, 'output');

function log(msg)  { process.stderr.write(`[cover-letter] ${msg}\n`); }
function ok(msg)   { process.stderr.write(`✅ ${msg}\n`); }
function warn(msg) { process.stderr.write(`⚠️  ${msg}\n`); }
function die(msg)  { process.stderr.write(`❌ ${msg}\n`); process.exit(1); }

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { report: null, job: null, role: null, all: false, preview: false, help: false };
  for (let i = 0; i < args.length; i++) {
    if      (args[i] === '--report'  && args[i+1]) flags.report  = resolve(args[++i]);
    else if (args[i] === '--job'     && args[i+1]) flags.job     = args[++i];
    else if (args[i] === '--role'    && args[i+1]) flags.role    = args[++i];
    else if (args[i] === '--all')    flags.all     = true;
    else if (args[i] === '--preview') flags.preview = true;
    else if (args[i] === '--help' || args[i] === '-h') flags.help = true;
  }
  return flags;
}

function printHelp() {
  console.log(`
cover-letter — Generate tailored cover letters for pipeline jobs

Usage:
  node cover-letter.mjs --report <file>         Use existing eval report as JD source
  node cover-letter.mjs --job "Co" --role "R"   Generate for a specific job
  node cover-letter.mjs --all                   Process all Aplicado/Enviado jobs
  node cover-letter.mjs --preview               Print to console, don't save
  node cover-letter.mjs --help                  Show this help

Output saved to: output/{company}-{role}-cover-letter.md (.pdf if generate-pdf.mjs is available)
`);
}

// ── CV helpers ────────────────────────────────────────────────────────────────

function extractContactInfo(cvContent) {
  const emailMatch = cvContent.match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  const phoneMatch = cvContent.match(/(?:\+?\d[\d\s\-().]{7,}\d)/);
  const linkedinMatch = cvContent.match(/linkedin\.com\/in\/([\w-]+)/i);
  const nameMatch = cvContent.match(/^#\s+(.+)/m);
  return {
    name:     nameMatch?.[1]?.trim()     || 'Your Name',
    email:    emailMatch?.[0]            || '',
    phone:    phoneMatch?.[0]            || '',
    linkedin: linkedinMatch ? `linkedin.com/in/${linkedinMatch[1]}` : '',
  };
}

// ── Tracker: pending jobs ─────────────────────────────────────────────────────

function findPendingJobs() {
  if (!existsSync(TRACKER_FILE)) return [];
  const content = readFileSync(TRACKER_FILE, 'utf8');
  const jobs = [];
  for (const line of content.split('\n')) {
    if (!line.startsWith('|') || line.includes('---')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 5) continue;
    if (cells[0] === '#' || cells[0] === 'Nº' || isNaN(parseInt(cells[0]))) continue;
    const status = cells[5] || '';
    // Include jobs that haven't been rejected or reached offer stage
    if (!/rechazada|rejected|oferta|offer/i.test(status)) {
      jobs.push({ company: cells[2], role: cells[3] });
    }
  }
  return jobs;
}

function findReportForJob(company, role) {
  if (!existsSync(REPORTS_DIR)) return null;
  const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'));
  const match = files.find(f => {
    const base = f.toLowerCase();
    return base.includes(company.toLowerCase().slice(0, 6));
  });
  return match ? join(REPORTS_DIR, match) : null;
}

// ── Gemini Cover Letter Generator ─────────────────────────────────────────────

const COVER_LETTER_PROMPT = (company, role, contact, cvContent, jdContext) => `You are an expert career coach. Write a compelling, tailored cover letter for:

Candidate: ${contact.name}
Company: ${company}
Role: ${role}

STRICT RULES:
1. Maximum 4 paragraphs, under 350 words total
2. Opening: DO NOT start with "I am writing" or "I am excited". Lead with the candidate's strongest proof point.
3. Paragraph 2: Specific technical/domain achievements most relevant to this role (from CV).
4. Paragraph 3: One specific reason why this COMPANY — not just any company — is interesting. Reference something real about them.
5. Closing: Clear CTA — request a conversation. Confident, not desperate.
6. Tone: Warm, direct, professional. No buzzwords ("synergy", "passionate", "team player").
7. Output ONLY the letter body — no subject line, no "Dear Hiring Manager" header, just the paragraphs.

Return ONLY a JSON object (no markdown, no code fences):
{
  "subject": "concise, specific email subject line (not 'Application for...')",
  "salutation": "Dear [Name/Team] — use hiring team name if inferable from JD, else 'Hiring Team'",
  "body": "full letter body — 4 paragraphs separated by \\n\\n",
  "closing": "Sincerely, / Best regards, etc.",
  "postscript": "optional PS line if there's a compelling hook (null if not needed)"
}

CANDIDATE CV:
${cvContent.slice(0, 3000)}

JOB CONTEXT:
${jdContext.slice(0, 3000)}`;

async function generateCoverLetter(company, role, cvContent, jdContext) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    die('GEMINI_API_KEY not set in .env — get a free key at https://aistudio.google.com/apikey');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const model = genAI.getGenerativeModel({ model: modelName });

  log(`Generating cover letter for ${company} — ${role} (${modelName})...`);

  const result = await model.generateContent(COVER_LETTER_PROMPT(company, role, extractContactInfo(cvContent), cvContent, jdContext));
  const raw = result.response.text().trim();

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Gemini response');

  return JSON.parse(jsonMatch[0]);
}

// ── Markdown Formatter ────────────────────────────────────────────────────────

function buildMarkdown(company, role, letter, contact) {
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  let md = '';

  // Header with contact info
  md += `# ${contact.name}\n`;
  const contactLine = [contact.email, contact.phone, contact.linkedin].filter(Boolean).join(' | ');
  if (contactLine) md += `${contactLine}\n`;
  md += `\n${date}\n\n`;

  // Salutation
  md += `${letter.salutation},\n\n`;

  // Body paragraphs
  md += `${letter.body}\n\n`;

  // Closing
  md += `${letter.closing}\n\n`;
  md += `**${contact.name}**\n`;
  if (contact.email)    md += `${contact.email}\n`;
  if (contact.phone)    md += `${contact.phone}\n`;
  if (contact.linkedin) md += `${contact.linkedin}\n`;

  if (letter.postscript) {
    md += `\n*P.S. ${letter.postscript}*\n`;
  }

  return md;
}

// ── PDF Generation ────────────────────────────────────────────────────────────

function generatePDF(mdContent, company, role) {
  const slug     = `${company}-${role}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const mdPath   = join(OUTPUT_DIR, `${slug}-cover-letter.md`);
  const pdfPath  = join(OUTPUT_DIR, `${slug}-cover-letter.pdf`);
  const pdfScript = join(ROOT, 'generate-pdf.mjs');

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(mdPath, mdContent, 'utf8');
  ok(`Saved Markdown → ${mdPath}`);

  if (!existsSync(pdfScript)) {
    warn('generate-pdf.mjs not found — skipping PDF export');
    return { mdPath, pdfPath: null };
  }

  try {
    execSync(`node "${pdfScript}" --input "${mdPath}" --output "${pdfPath}"`, {
      stdio: 'pipe', cwd: ROOT, timeout: 60_000,
    });
    ok(`Saved PDF → ${pdfPath}`);
    return { mdPath, pdfPath };
  } catch (err) {
    warn(`PDF generation failed: ${err.message}`);
    return { mdPath, pdfPath: null };
  }
}

// ── Tracker update ────────────────────────────────────────────────────────────

function updateTrackerCoverLetter(company, role, pdfPath) {
  if (!existsSync(TRACKER_FILE) || !pdfPath) return;
  let content = readFileSync(TRACKER_FILE, 'utf8');
  const relPath = pdfPath.replace(ROOT + '/', '');
  const link = `[CL](${relPath})`;

  // Add cover letter link to the notes/report column (column 8) if empty
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    const lower = line.toLowerCase();
    if (!lower.includes(company.toLowerCase().slice(0, 5))) continue;
    const cells = line.split('|');
    if (cells.length >= 9) {
      const reportCell = cells[8]?.trim();
      if (!reportCell || reportCell === '-' || reportCell === '') {
        cells[8] = ` ${link} `;
        lines[i] = cells.join('|');
        break;
      }
    }
  }
  writeFileSync(TRACKER_FILE, lines.join('\n'), 'utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv);

  if (flags.help) { printHelp(); process.exit(0); }
  if (!existsSync(CV_FILE)) die(`cv.md not found — run: node resume-import.mjs your-resume.pdf`);

  const cvContent = readFileSync(CV_FILE, 'utf8');
  const contact   = extractContactInfo(cvContent);

  // Build job list
  let jobs = [];

  if (flags.all) {
    jobs = findPendingJobs();
    if (jobs.length === 0) { warn('No active jobs found in tracker.'); process.exit(0); }
    log(`Found ${jobs.length} job(s) to generate cover letters for`);
  } else if (flags.job) {
    jobs = [{ company: flags.job, role: flags.role || 'the role' }];
  } else if (flags.report) {
    if (!existsSync(flags.report)) die(`Report not found: ${flags.report}`);
    const base  = basename(flags.report, '.md').replace(/-\d{4}-\d{2}-\d{2}$/, '');
    const parts = base.split('-');
    const company = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    const role    = parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    jobs = [{ company, role, reportPath: flags.report }];
  } else {
    printHelp();
    die('Specify --report, --job, or --all');
  }

  let done = 0;
  for (const job of jobs) {
    const { company, role } = job;
    const reportPath = job.reportPath || findReportForJob(company, role);
    const jdContext  = reportPath && existsSync(reportPath)
      ? readFileSync(reportPath, 'utf8')
      : `Role: ${role} at ${company}.`;

    try {
      const letter   = await generateCoverLetter(company, role, cvContent, jdContext);
      const markdown = buildMarkdown(company, role, letter, contact);

      if (flags.preview) {
        console.log('\n' + '─'.repeat(60));
        console.log(`📨  COVER LETTER — ${role} at ${company}`);
        console.log('─'.repeat(60));
        console.log(`Subject: ${letter.subject}\n`);
        console.log(markdown);
        console.log('─'.repeat(60) + '\n');
        done++;
        continue;
      }

      const { mdPath, pdfPath } = generatePDF(markdown, company, role);
      updateTrackerCoverLetter(company, role, pdfPath);

      console.log(`\n  ✅  ${company} — ${role}`);
      console.log(`     📄 ${mdPath}`);
      if (pdfPath) console.log(`     📑 ${pdfPath}`);
      console.log(`     📧 Subject: "${letter.subject}"`);
      done++;
    } catch (err) {
      warn(`Failed for ${company} — ${role}: ${err.message}`);
    }
  }

  if (!flags.preview) {
    console.log(`\n✅ Generated ${done}/${jobs.length} cover letter(s) → output/\n`);
  }
}

main().catch(err => die(err?.message || String(err)));
