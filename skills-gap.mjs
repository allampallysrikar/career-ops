#!/usr/bin/env node
// skills-gap.mjs — Phase 11b (v2.2)
// Analyzes your CV against a job description and produces a prioritized skills gap report.
// For each missing skill: priority tier, estimated learning time, and top resource.
//
// Usage:
//   node skills-gap.mjs --report "reports/stripe-ai-eng.md"
//   node skills-gap.mjs --job "Stripe" --role "AI Engineer"
//   node skills-gap.mjs --all          # All active tracker jobs with reports
//   node skills-gap.mjs --list         # List all existing gap sheets
//
// Output:
//   data/skills-gap/{company}-{role}.md

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, resolve, basename } from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

const ROOT        = resolve(process.cwd());
const CV_FILE     = join(ROOT, 'cv.md');
const REPORTS_DIR = join(ROOT, 'reports');
const TRACKER_FILE= join(ROOT, 'data', 'applications.md');
const GAP_DIR     = join(ROOT, 'data', 'skills-gap');

function log(msg)  { process.stderr.write(`[skills-gap] ${msg}\n`); }
function ok(msg)   { process.stderr.write(`✅ ${msg}\n`); }
function warn(msg) { process.stderr.write(`⚠️  ${msg}\n`); }
function die(msg)  { process.stderr.write(`❌ ${msg}\n`); process.exit(1); }

// ── CLI Args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { report: null, job: null, role: null, all: false, list: false, help: false };
  for (let i = 0; i < args.length; i++) {
    if      (args[i] === '--report' && args[i+1]) flags.report = resolve(args[++i]);
    else if (args[i] === '--job'    && args[i+1]) flags.job    = args[++i];
    else if (args[i] === '--role'   && args[i+1]) flags.role   = args[++i];
    else if (args[i] === '--all')  flags.all  = true;
    else if (args[i] === '--list') flags.list = true;
    else if (args[i] === '--help' || args[i] === '-h') flags.help = true;
  }
  return flags;
}

function printHelp() {
  console.log(`
skills-gap — Analyze CV against job descriptions for skill gaps

Usage:
  node skills-gap.mjs --report <file>         Analyze against existing eval report
  node skills-gap.mjs --job "Co" --role "R"   Analyze for a specific job (no JD context)
  node skills-gap.mjs --all                   Process all active jobs with eval reports
  node skills-gap.mjs --list                  List all existing gap sheets

Output: data/skills-gap/{company}-{role}.md
`);
}

// ── Tracker helpers ───────────────────────────────────────────────────────────

function loadActiveJobs() {
  if (!existsSync(TRACKER_FILE)) return [];
  const content = readFileSync(TRACKER_FILE, 'utf8');
  const jobs = [];
  for (const line of content.split('\n')) {
    if (!line.startsWith('|') || line.includes('---')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 5 || cells[0] === '#' || cells[0] === 'Nº' || isNaN(parseInt(cells[0]))) continue;
    const status = cells[5] || '';
    if (/rechazada|rejected/i.test(status)) continue;
    jobs.push({ company: cells[2], role: cells[3] });
  }
  return jobs;
}

function findReportForJob(company, role) {
  if (!existsSync(REPORTS_DIR)) return null;
  const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'));
  const match = files.find(f => f.toLowerCase().includes(company.toLowerCase().slice(0, 6)));
  return match ? join(REPORTS_DIR, match) : null;
}

// ── Gemini Gap Analysis ───────────────────────────────────────────────────────

const GAP_PROMPT = (company, role, cvContent, jdContext) => `You are a senior technical recruiter and career coach. Analyze the candidate's CV against the job description and identify skill gaps.

Company: ${company}
Role: ${role}

CANDIDATE CV:
${cvContent.slice(0, 3000)}

JOB DESCRIPTION / CONTEXT:
${jdContext.slice(0, 3000)}

Return ONLY a valid JSON object (no markdown, no code fences):
{
  "overallFit": <0-100 integer — how well the CV matches right now>,
  "fitNarrative": "<2-sentence summary of the candidate's positioning for this role>",
  "criticalGaps": [
    {
      "skill": "<exact skill name>",
      "context": "<why it's critical for this role>",
      "candidateLevel": "none|beginner|intermediate",
      "estimatedHours": <hours to reach minimum viable proficiency>,
      "topResource": {
        "title": "<resource name>",
        "url": "<actual URL if well-known, else null>",
        "type": "course|book|docs|project|bootcamp"
      }
    }
  ],
  "importantGaps": [
    {
      "skill": "<skill>",
      "context": "<brief reason>",
      "candidateLevel": "none|beginner|intermediate",
      "estimatedHours": <hours>,
      "topResource": { "title": "<name>", "url": "<url or null>", "type": "<type>" }
    }
  ],
  "niceToHaveGaps": [
    {
      "skill": "<skill>",
      "estimatedHours": <hours>,
      "topResource": { "title": "<name>", "url": "<url or null>", "type": "<type>" }
    }
  ],
  "strengths": ["<strength 1>", "<strength 2>", "<strength 3>", "<strength 4>", "<strength 5>"],
  "quickWins": ["<thing to add to CV or LinkedIn immediately>", "<another quick win>"],
  "totalUpskillHours": <sum of all estimatedHours>,
  "applicationAdvice": "<1-2 sentences on whether to apply now, apply anyway, or wait>"
}

Be specific: name real courses (Coursera ML Specialization, Fast.ai, Rust Book), real docs, real projects to build. Avoid vague suggestions like "read documentation".`;

async function analyzeGaps(company, role, cvContent, jdContext) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    die('GEMINI_API_KEY not set in .env — get a free key at https://aistudio.google.com/apikey');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const model = genAI.getGenerativeModel({ model: modelName });

  log(`Analyzing gaps for ${company} — ${role} (${modelName})...`);

  const result = await model.generateContent(GAP_PROMPT(company, role, cvContent, jdContext));
  const raw = result.response.text().trim();

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Gemini response');

  return JSON.parse(jsonMatch[0]);
}

// ── Markdown Renderer ─────────────────────────────────────────────────────────

function resourceLine(r) {
  if (!r) return '—';
  const link = r.url ? `[${r.title}](${r.url})` : r.title;
  return `${link} *(${r.type})*`;
}

function levelEmoji(level) {
  if (level === 'none')         return '⭕ None';
  if (level === 'beginner')     return '🔵 Beginner';
  if (level === 'intermediate') return '🟡 Intermediate';
  return '—';
}

function fitBadge(score) {
  if (score >= 75) return `🟢 ${score}%`;
  if (score >= 50) return `🟡 ${score}%`;
  return `🔴 ${score}%`;
}

function buildMarkdown(company, role, analysis) {
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  let md = '';

  md += `# Skills Gap Analysis — ${role} @ ${company}\n\n`;
  md += `*Generated: ${date}*\n\n`;
  md += `## Overall Fit: ${fitBadge(analysis.overallFit)}\n\n`;
  md += `${analysis.fitNarrative}\n\n`;
  md += `> **Application advice:** ${analysis.applicationAdvice}\n\n`;

  // Strengths
  if (analysis.strengths?.length) {
    md += `## ✅ Strengths\n\n`;
    analysis.strengths.forEach(s => { md += `- ${s}\n`; });
    md += '\n';
  }

  // Quick wins
  if (analysis.quickWins?.length) {
    md += `## ⚡ Quick Wins (do today)\n\n`;
    analysis.quickWins.forEach(s => { md += `- ${s}\n`; });
    md += '\n';
  }

  // Critical gaps
  if (analysis.criticalGaps?.length) {
    md += `## 🔴 Critical Gaps\n\n`;
    md += `| Skill | Current Level | Hours | Top Resource |\n`;
    md += `|-------|---------------|-------|-------------|\n`;
    for (const g of analysis.criticalGaps) {
      md += `| **${g.skill}** | ${levelEmoji(g.candidateLevel)} | ~${g.estimatedHours}h | ${resourceLine(g.topResource)} |\n`;
    }
    md += '\n';
    // Context notes
    for (const g of analysis.criticalGaps) {
      md += `**${g.skill}:** ${g.context}\n\n`;
    }
  }

  // Important gaps
  if (analysis.importantGaps?.length) {
    md += `## 🟡 Important Gaps\n\n`;
    md += `| Skill | Current Level | Hours | Top Resource |\n`;
    md += `|-------|---------------|-------|-------------|\n`;
    for (const g of analysis.importantGaps) {
      md += `| ${g.skill} | ${levelEmoji(g.candidateLevel)} | ~${g.estimatedHours}h | ${resourceLine(g.topResource)} |\n`;
    }
    md += '\n';
  }

  // Nice-to-have gaps
  if (analysis.niceToHaveGaps?.length) {
    md += `## 🔵 Nice-to-Have Gaps\n\n`;
    md += `| Skill | Hours | Top Resource |\n`;
    md += `|-------|-------|-------------|\n`;
    for (const g of analysis.niceToHaveGaps) {
      md += `| ${g.skill} | ~${g.estimatedHours}h | ${resourceLine(g.topResource)} |\n`;
    }
    md += '\n';
  }

  // Total upskill
  md += `---\n\n`;
  md += `**Total estimated upskill time:** ~${analysis.totalUpskillHours}h\n`;

  return md;
}

// ── Console Summary ───────────────────────────────────────────────────────────

function printSummary(company, role, analysis, outPath) {
  const critical = analysis.criticalGaps?.length || 0;
  const important = analysis.importantGaps?.length || 0;
  const nice = analysis.niceToHaveGaps?.length || 0;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🎯  Skills Gap — ${role} @ ${company}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`  Fit: ${fitBadge(analysis.overallFit)}`);
  console.log(`  ${analysis.fitNarrative}`);
  console.log(`\n  Gaps:  🔴 ${critical} critical · 🟡 ${important} important · 🔵 ${nice} nice-to-have`);
  console.log(`  Upskill time: ~${analysis.totalUpskillHours}h total`);
  if (critical > 0) {
    console.log(`\n  Critical gaps:`);
    analysis.criticalGaps.forEach(g => console.log(`    • ${g.skill} (~${g.estimatedHours}h) — ${g.topResource?.title || '?'}`));
  }
  if (analysis.quickWins?.length) {
    console.log(`\n  Quick wins:`);
    analysis.quickWins.forEach(w => console.log(`    ⚡ ${w}`));
  }
  console.log(`\n  Advice: ${analysis.applicationAdvice}`);
  console.log(`  Saved → ${outPath}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv);
  if (flags.help) { printHelp(); process.exit(0); }

  // --list
  if (flags.list) {
    if (!existsSync(GAP_DIR)) { warn('No gap sheets found yet.'); process.exit(0); }
    const files = readdirSync(GAP_DIR).filter(f => f.endsWith('.md'));
    if (files.length === 0) { warn('No gap sheets found yet.'); process.exit(0); }
    console.log(`\n  Skills Gap Sheets (${files.length}):\n`);
    files.forEach(f => console.log(`  • data/skills-gap/${f}`));
    console.log();
    process.exit(0);
  }

  if (!existsSync(CV_FILE)) die('cv.md not found — run: node resume-import.mjs your-resume.pdf');
  const cvContent = readFileSync(CV_FILE, 'utf8');

  if (!existsSync(GAP_DIR)) mkdirSync(GAP_DIR, { recursive: true });

  // Build job list
  let jobs = [];
  if (flags.all) {
    const activeJobs = loadActiveJobs();
    // Only jobs that have an eval report
    for (const j of activeJobs) {
      const rp = findReportForJob(j.company, j.role);
      if (rp) jobs.push({ ...j, reportPath: rp });
      else warn(`No report found for ${j.company} — ${j.role}, skipping`);
    }
    if (jobs.length === 0) { warn('No jobs with reports found.'); process.exit(0); }
    log(`Found ${jobs.length} job(s) with reports`);
  } else if (flags.report) {
    if (!existsSync(flags.report)) die(`Report not found: ${flags.report}`);
    const base  = basename(flags.report, '.md').replace(/-\d{4}-\d{2}-\d{2}$/, '');
    const parts = base.split('-');
    const company = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    const role    = parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    jobs = [{ company, role, reportPath: flags.report }];
  } else if (flags.job) {
    const rp = findReportForJob(flags.job, flags.role || '');
    jobs = [{ company: flags.job, role: flags.role || 'the role', reportPath: rp }];
  } else {
    printHelp();
    die('Specify --report, --job, or --all');
  }

  let done = 0;
  for (const { company, role, reportPath } of jobs) {
    const jdContext = reportPath && existsSync(reportPath)
      ? readFileSync(reportPath, 'utf8')
      : `Role: ${role} at ${company}. No job description available.`;

    try {
      const analysis  = await analyzeGaps(company, role, cvContent, jdContext);
      const markdown  = buildMarkdown(company, role, analysis);
      const slug      = `${company}-${role}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const outPath   = join(GAP_DIR, `${slug}.md`);
      writeFileSync(outPath, markdown, 'utf8');
      ok(`Saved → ${outPath}`);
      printSummary(company, role, analysis, outPath);
      done++;
      if (done < jobs.length) await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      warn(`Failed for ${company} — ${role}: ${err.message}`);
    }
  }

  console.log(`\n✅ Skills gap analysis: ${done}/${jobs.length} completed → data/skills-gap/\n`);
}

main().catch(err => die(err?.message || String(err)));
