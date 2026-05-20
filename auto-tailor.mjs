#!/usr/bin/env node
// auto-tailor.mjs — Phase 4
// Automatically generates a tailored PDF resume for each job in the pipeline
// that scores above the configured threshold (default: 4.0/5).
//
// Usage:
//   node auto-tailor.mjs                    # Process all pending jobs in pipeline.md
//   node auto-tailor.mjs --min-score 3.5    # Override minimum score threshold
//   node auto-tailor.mjs --dry-run          # Preview what would be tailored without generating PDFs
//   node auto-tailor.mjs --job "Company - Role"  # Tailor a specific job by name
//
// What it does per job:
//   1. Reads the existing evaluation report from reports/
//   2. Extracts JD keywords from Block A/B of the report
//   3. Calls Gemini to tailor cv.md (keyword injection, section reordering)
//   4. Generates a tailored PDF via generate-pdf.mjs
//   5. Saves to output/{company}-{role}-tailored.pdf
//   6. Updates the tracker (applications.md) with the PDF path

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from 'fs';
import { resolve, join } from 'path';
import { execSync } from 'child_process';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

const ROOT = process.cwd();
const REPORTS_DIR  = join(ROOT, 'reports');
const OUTPUT_DIR   = join(ROOT, 'output');
const TRACKER_FILE = join(ROOT, 'data', 'applications.md');
const CV_FILE      = join(ROOT, 'cv.md');

function log(msg)  { process.stderr.write(`[auto-tailor] ${msg}\n`); }
function ok(msg)   { process.stderr.write(`✅ ${msg}\n`); }
function warn(msg) { process.stderr.write(`⚠️  ${msg}\n`); }
function die(msg)  { process.stderr.write(`❌ ${msg}\n`); process.exit(1); }

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { minScore: 4.0, dryRun: false, job: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') flags.dryRun = true;
    else if (args[i] === '--min-score' && args[i + 1]) flags.minScore = parseFloat(args[++i]);
    else if (args[i] === '--job' && args[i + 1]) flags.job = args[++i];
  }
  return flags;
}

// ── Report Parsing ────────────────────────────────────────────────────────────

function listReports() {
  if (!existsSync(REPORTS_DIR)) return [];
  return readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'));
}

function parseScoreFromReport(content) {
  // Look for score patterns: "Score: 4.2/5", "**4.2**/5", "SCORE_SUMMARY: 4.2"
  const patterns = [
    /SCORE_SUMMARY.*?(\d+\.?\d*)/i,
    /(?:overall|final)[\s_]score[:\s]+(\d+\.?\d*)/i,
    /\*\*(\d+\.?\d*)\*\*\s*\/\s*5/,
    /score[:\s]+(\d+\.?\d*)\s*\/\s*5/i,
  ];
  for (const re of patterns) {
    const m = content.match(re);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

function extractCompanyRole(filename) {
  // Filename format: "company-role-YYYY-MM-DD.md" or "company-role.md"
  const base = filename.replace(/\.md$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const parts = base.split('-');
  if (parts.length < 2) return { company: base, role: '' };
  // Heuristic: first word is company, rest is role
  const company = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  const role = parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  return { company, role };
}

// ── Gemini Tailoring ──────────────────────────────────────────────────────────

async function tailorCV(cvContent, reportContent, company, role) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    die('GEMINI_API_KEY not set in .env');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });

  const prompt = `You are a resume tailoring expert. Your task is to tailor the candidate's resume (cv.md) specifically for the job at ${company} as a ${role}.

RULES:
1. Keep ALL content truthful — only reorder, reword, or emphasize existing facts. Do NOT invent new accomplishments.
2. Inject 5-10 keywords from the job evaluation report into existing bullet points naturally.
3. Reorder bullet points within each role so the most relevant ones appear first.
4. Update the Professional Summary to directly reference this role type and company's domain.
5. Update the Core Competencies section to list skills most relevant to this role first.
6. Do NOT add or remove entire bullet points — only reorder and lightly reword.
7. Output ONLY the modified cv.md content — no explanation, no preamble.

JOB EVALUATION REPORT:
${reportContent.slice(0, 8000)}

ORIGINAL CV.MD:
${cvContent}`;

  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

// ── PDF Generation ────────────────────────────────────────────────────────────

function generatePDF(cvContent, company, role) {
  const slug = `${company}-${role}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const outputPath = join(OUTPUT_DIR, `${slug}-tailored.pdf`);
  const tmpCvPath  = join(ROOT, `.cv-tailor-tmp-${Date.now()}.md`);

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  writeFileSync(tmpCvPath, cvContent, 'utf8');

  try {
    execSync(`node "${join(ROOT, 'generate-pdf.mjs')}" --input "${tmpCvPath}" --output "${outputPath}"`, {
      stdio: 'pipe',
      cwd: ROOT,
    });
    ok(`PDF generated: ${outputPath}`);
    return outputPath;
  } catch (err) {
    warn(`PDF generation failed: ${err.message}`);
    return null;
  } finally {
    try { unlinkSync(tmpCvPath); } catch {}
  }
}

// ── Tracker Update ────────────────────────────────────────────────────────────

function updateTrackerPDFPath(company, role, pdfPath) {
  if (!existsSync(TRACKER_FILE)) return;
  let content = readFileSync(TRACKER_FILE, 'utf8');
  const relPath = pdfPath.replace(ROOT + '/', '');
  const pdfLink = `[PDF](${relPath})`;
  const lines = content.split('\n');
  let updated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    const lower = line.toLowerCase();
    if (!lower.includes(company.toLowerCase()) || !lower.includes(role.toLowerCase())) continue;
    // Only update if PDF column is empty or a dash
    const cells = line.split('|');
    if (cells.length < 7) continue;
    const pdfCell = cells[6].trim();
    if (pdfCell === '' || pdfCell === '-' || pdfCell === '—') {
      cells[6] = ` ${pdfLink} `;
      lines[i] = cells.join('|');
      updated = true;
      break;
    }
  }

  if (updated) {
    writeFileSync(TRACKER_FILE, lines.join('\n'), 'utf8');
    ok(`Tracker updated with PDF path for ${company} — ${role}`);
  }
}

// ── ATS Check Integration ─────────────────────────────────────────────────────
// Runs ats-check.mjs on the tailored CV + JD text after tailoring.
// Non-blocking: a low ATS score triggers a warning but does NOT stop PDF generation.

function extractJDFromReport(reportContent) {
  // Reports include the original JD in Block A or under a "Job Description" heading
  const jdMatch = reportContent.match(/#+\s*(?:Job Description|JD|Original|Position)\s*\n+([\s\S]+?)(?=\n#|\Z)/i);
  if (jdMatch) return jdMatch[1].trim();
  // Fall back to first 3000 chars of the report as a JD proxy
  return reportContent.slice(0, 3000);
}

function runATSCheck(tailoredCvContent, jdText, company, role) {
  const tmpCv  = join(ROOT, `.ats-cv-tmp-${Date.now()}.md`);
  const tmpJD  = join(ROOT, `.ats-jd-tmp-${Date.now()}.txt`);

  try {
    writeFileSync(tmpCv,  tailoredCvContent, 'utf8');
    writeFileSync(tmpJD,  jdText,            'utf8');

    execSync(
      `node "${join(ROOT, 'ats-check.mjs')}" --jd "${tmpJD}" --resume "${tmpCv}"`,
      { cwd: ROOT, stdio: 'pipe', timeout: 60_000 }
    );

    // Read the latest score from the ATS log
    const atsLog = join(ROOT, 'data', 'ats-scores.json');
    if (existsSync(atsLog)) {
      const entries = JSON.parse(readFileSync(atsLog, 'utf8'));
      // Find most recent entry (last one added)
      const latest = entries[entries.length - 1];
      if (latest) {
        const grade = latest.score >= 80 ? '🟢 STRONG' : latest.score >= 60 ? '🟡 MODERATE' : '🔴 WEAK';
        const prefix = latest.score >= 60 ? ok : warn;
        prefix(`ATS Score for ${company} — ${role}: ${latest.score}/100 ${grade}`);
        if (latest.score < 60) {
          warn(`  Low ATS score — consider adding these keywords: ${(latest.missing || []).slice(0, 5).join(', ')}`);
        }
        return latest.score;
      }
    }
  } catch (err) {
    warn(`ATS check skipped for ${company} — ${role}: ${err.message}`);
  } finally {
    try { unlinkSync(tmpCv); } catch {}
    try { unlinkSync(tmpJD); } catch {}
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { minScore, dryRun, job } = parseArgs(process.argv);

  if (!existsSync(CV_FILE)) die(`cv.md not found at ${CV_FILE} — run: node resume-import.mjs your-resume.pdf`);

  const cvContent = readFileSync(CV_FILE, 'utf8');
  const reports   = listReports();

  if (reports.length === 0) {
    warn('No reports found in reports/. Run job evaluation first via Claude Code or: node gemini-eval.mjs "JD text"');
    return;
  }

  log(`Found ${reports.length} report(s). Minimum score threshold: ${minScore}/5`);
  if (dryRun) warn('DRY RUN — no files will be written');

  let processed = 0;
  let skipped   = 0;

  for (const reportFile of reports) {
    const reportPath = join(REPORTS_DIR, reportFile);
    const reportContent = readFileSync(reportPath, 'utf8');
    const { company, role } = extractCompanyRole(reportFile);

    // Filter by specific job if --job flag provided
    if (job && !`${company} ${role}`.toLowerCase().includes(job.toLowerCase())) {
      continue;
    }

    const score = parseScoreFromReport(reportContent);

    if (score === null) {
      warn(`${reportFile}: Could not parse score — skipping`);
      skipped++;
      continue;
    }

    if (score < minScore) {
      log(`${company} — ${role}: Score ${score}/5 below threshold ${minScore} — skipping`);
      skipped++;
      continue;
    }

    log(`${company} — ${role}: Score ${score}/5 ✓ — tailoring CV...`);

    if (dryRun) {
      console.log(`  Would tailor: ${company} — ${role} (score: ${score})`);
      processed++;
      continue;
    }

    try {
      const tailoredCV = await tailorCV(cvContent, reportContent, company, role);

      // ── ATS Check on tailored CV ──────────────────────────────────────────
      const jdText  = extractJDFromReport(reportContent);
      const atsScore = runATSCheck(tailoredCV, jdText, company, role);
      if (atsScore !== null && atsScore < 60) {
        warn(`Generating PDF despite low ATS score (${atsScore}/100). Consider revising further.`);
      }

      const pdfPath    = generatePDF(tailoredCV, company, role);
      if (pdfPath) {
        updateTrackerPDFPath(company, role, pdfPath);
        processed++;
      }
    } catch (err) {
      warn(`Failed to tailor ${company} — ${role}: ${err.message}`);
      skipped++;
    }
  }

  console.log(`\n📊 Auto-Tailor Summary:`);
  console.log(`   Tailored: ${processed} jobs`);
  console.log(`   Skipped:  ${skipped} jobs`);
  if (processed > 0) {
    console.log(`\n   Find your tailored PDFs in: output/`);
  }
}

main().catch(err => die(err.message));
