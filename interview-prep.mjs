#!/usr/bin/env node
// interview-prep.mjs — Phase 10a
// Generates a personalised mock interview prep sheet for each job.
// For every job that reaches "Entrevista" (Interview) status, it produces:
//   • 20 targeted questions across 4 categories
//   • STAR-formatted ideal answer frameworks for behavioural questions
//   • Company-specific research talking points
//   • Saved to data/interview-prep/{slug}.md
//
// Usage:
//   node interview-prep.mjs --report "reports/stripe-ai-eng.md"
//   node interview-prep.mjs --job "Stripe" --role "AI Engineer"
//   node interview-prep.mjs --all        # All jobs in Entrevista status
//   node interview-prep.mjs --list       # List existing prep sheets

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, resolve, basename } from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

const ROOT        = process.cwd();
const CV_FILE     = join(ROOT, 'cv.md');
const REPORTS_DIR = join(ROOT, 'reports');
const TRACKER_FILE = join(ROOT, 'data', 'applications.md');
const PREP_DIR    = join(ROOT, 'data', 'interview-prep');

function log(msg)  { process.stderr.write(`[interview-prep] ${msg}\n`); }
function ok(msg)   { process.stderr.write(`✅ ${msg}\n`); }
function warn(msg) { process.stderr.write(`⚠️  ${msg}\n`); }
function die(msg)  { process.stderr.write(`❌ ${msg}\n`); process.exit(1); }

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { report: null, job: null, role: null, all: false, list: false, help: false };
  for (let i = 0; i < args.length; i++) {
    if      (args[i] === '--report' && args[i+1]) flags.report = resolve(args[++i]);
    else if (args[i] === '--job'    && args[i+1]) flags.job    = args[++i];
    else if (args[i] === '--role'   && args[i+1]) flags.role   = args[++i];
    else if (args[i] === '--all')   flags.all  = true;
    else if (args[i] === '--list')  flags.list = true;
    else if (args[i] === '--help' || args[i] === '-h') flags.help = true;
  }
  return flags;
}

function printHelp() {
  console.log(`
interview-prep — AI-generated mock interview prep sheets

Usage:
  node interview-prep.mjs --report <file>        Use existing eval report as JD source
  node interview-prep.mjs --job "Co" --role "R"  Generate for a specific company/role
  node interview-prep.mjs --all                  Process all "Entrevista" jobs in tracker
  node interview-prep.mjs --list                 List existing prep sheets
  node interview-prep.mjs --help                 Show this help

Output: data/interview-prep/{company}-{role}.md

Categories generated:
  1. Technical / Domain (8 questions)   — role-specific skills and tools
  2. Behavioural / STAR (6 questions)   — with answer frameworks
  3. Company / Culture (3 questions)    — company-specific research
  4. Questions to Ask Them (3 prompts)  — intelligent reverse questions
`);
}

// ── Tracker: find interview-stage jobs ───────────────────────────────────────

function findInterviewJobs() {
  if (!existsSync(TRACKER_FILE)) return [];
  const content = readFileSync(TRACKER_FILE, 'utf8');
  const jobs = [];
  for (const line of content.split('\n')) {
    if (!line.startsWith('|') || line.includes('---')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 5) continue;
    if (cells[0] === '#' || cells[0] === 'Nº' || isNaN(parseInt(cells[0]))) continue;
    const status = cells[5] || '';
    if (/entrevista|interview/i.test(status)) {
      jobs.push({ company: cells[2], role: cells[3] });
    }
  }
  return jobs;
}

function findReportForJob(company, role) {
  if (!existsSync(REPORTS_DIR)) return null;
  const files = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'));
  const slug = `${company}-${role}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const match = files.find(f => {
    const base = f.toLowerCase().replace(/\.md$/, '');
    return base.includes(company.toLowerCase().slice(0, 6)) ||
           base.includes(slug.slice(0, 10));
  });
  return match ? join(REPORTS_DIR, match) : null;
}

// ── Gemini Question Generator ─────────────────────────────────────────────────

const PREP_PROMPT = (company, role, cvContent, jdContext) => `You are an expert interview coach. Generate a comprehensive mock interview prep sheet for:

Company: ${company}
Role: ${role}

Output ONLY valid JSON (no markdown, no code fences) in this exact structure:
{
  "overview": "2-3 sentences: what this role is likely testing for, and the key hiring criteria",
  "technicalQuestions": [
    {
      "q": "question text",
      "hint": "what a strong answer covers (2-3 key points)",
      "why": "why interviewers ask this"
    }
  ],
  "behaviouralQuestions": [
    {
      "q": "Tell me about a time when...",
      "starFramework": {
        "situation": "what context to set up",
        "task": "what your responsibility was",
        "action": "specific actions to highlight from the candidate's CV",
        "result": "quantified outcome to aim for"
      },
      "why": "competency being assessed"
    }
  ],
  "companyQuestions": [
    {
      "q": "company/culture question",
      "researchPoints": ["point 1", "point 2"]
    }
  ],
  "questionsToAsk": [
    {
      "q": "intelligent question to ask interviewer",
      "why": "why this question signals strong candidacy"
    }
  ],
  "redFlags": ["common mistakes candidates make for this role/company"],
  "keyTalkingPoints": ["3-4 things from the candidate's CV to emphasise for this specific role"]
}

Requirements:
- technicalQuestions: exactly 8, specific to the tech stack and domain of this role
- behaviouralQuestions: exactly 6, map STAR actions to things in the CV below
- companyQuestions: exactly 3, reference actual things about this company
- questionsToAsk: exactly 3, intelligent and specific — not generic

CANDIDATE CV (first 3000 chars):
${cvContent.slice(0, 3000)}

JOB CONTEXT:
${jdContext.slice(0, 4000)}`;

async function generatePrepSheet(company, role, cvContent, jdContext) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    die('GEMINI_API_KEY not set in .env — get a free key at https://aistudio.google.com/apikey');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const model = genAI.getGenerativeModel({ model: modelName });

  log(`Generating prep sheet for ${company} — ${role} (${modelName})...`);

  const result = await model.generateContent(PREP_PROMPT(company, role, cvContent, jdContext));
  const raw = result.response.text().trim();

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Gemini response');

  return JSON.parse(jsonMatch[0]);
}

// ── Markdown Renderer ─────────────────────────────────────────────────────────

function renderPrepSheet(company, role, data) {
  const date = new Date().toISOString().split('T')[0];
  let md = `# Interview Prep: ${role} at ${company}\n\n`;
  md += `*Generated: ${date}*\n\n`;
  md += `---\n\n`;

  // Overview
  md += `## 🎯 What They're Testing For\n\n${data.overview}\n\n`;

  // Key talking points from CV
  if (data.keyTalkingPoints?.length > 0) {
    md += `## 💼 Lead with These From Your CV\n\n`;
    data.keyTalkingPoints.forEach(p => md += `- ${p}\n`);
    md += '\n';
  }

  md += `---\n\n`;

  // Technical questions
  md += `## 🔧 Technical Questions (${data.technicalQuestions?.length || 0})\n\n`;
  (data.technicalQuestions || []).forEach((q, i) => {
    md += `### ${i + 1}. ${q.q}\n\n`;
    md += `**Why they ask:** ${q.why}\n\n`;
    md += `**Strong answer covers:**\n${q.hint}\n\n`;
  });

  // Behavioural questions
  md += `---\n\n## 🧠 Behavioural Questions — STAR Framework (${data.behaviouralQuestions?.length || 0})\n\n`;
  (data.behaviouralQuestions || []).forEach((q, i) => {
    md += `### ${i + 1}. ${q.q}\n\n`;
    md += `**Competency:** ${q.why}\n\n`;
    if (q.starFramework) {
      md += `**STAR Framework:**\n`;
      md += `- **Situation:** ${q.starFramework.situation}\n`;
      md += `- **Task:** ${q.starFramework.task}\n`;
      md += `- **Action:** ${q.starFramework.action}\n`;
      md += `- **Result:** ${q.starFramework.result}\n`;
    }
    md += '\n';
  });

  // Company questions
  md += `---\n\n## 🏢 Company & Culture Questions (${data.companyQuestions?.length || 0})\n\n`;
  (data.companyQuestions || []).forEach((q, i) => {
    md += `### ${i + 1}. ${q.q}\n\n`;
    if (q.researchPoints?.length > 0) {
      md += `**Research points:**\n`;
      q.researchPoints.forEach(p => md += `- ${p}\n`);
    }
    md += '\n';
  });

  // Questions to ask
  md += `---\n\n## ❓ Questions to Ask Them (${data.questionsToAsk?.length || 0})\n\n`;
  (data.questionsToAsk || []).forEach((q, i) => {
    md += `### ${i + 1}. "${q.q}"\n\n`;
    md += `*Why this works: ${q.why}*\n\n`;
  });

  // Red flags
  if (data.redFlags?.length > 0) {
    md += `---\n\n## ⚠️ Common Mistakes to Avoid\n\n`;
    data.redFlags.forEach(r => md += `- ${r}\n`);
    md += '\n';
  }

  md += `---\n\n*Generated by career-ops interview-prep | Run \`node interview-prep.mjs --all\` to refresh*\n`;
  return md;
}

// ── Save ──────────────────────────────────────────────────────────────────────

function savePrepSheet(company, role, markdown) {
  if (!existsSync(PREP_DIR)) mkdirSync(PREP_DIR, { recursive: true });
  const slug = `${company}-${role}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');
  const outPath = join(PREP_DIR, `${slug}.md`);
  writeFileSync(outPath, markdown, 'utf8');
  ok(`Saved prep sheet → ${outPath}`);
  return outPath;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv);

  if (flags.help) { printHelp(); process.exit(0); }

  if (flags.list) {
    if (!existsSync(PREP_DIR)) { console.log('No prep sheets yet.'); process.exit(0); }
    const sheets = readdirSync(PREP_DIR).filter(f => f.endsWith('.md'));
    if (sheets.length === 0) { console.log('No prep sheets yet.'); process.exit(0); }
    console.log(`\n📋 Interview Prep Sheets (${sheets.length}):\n`);
    sheets.forEach(s => console.log(`  • data/interview-prep/${s}`));
    console.log('');
    process.exit(0);
  }

  if (!existsSync(CV_FILE)) die(`cv.md not found — run: node resume-import.mjs your-resume.pdf`);
  const cvContent = readFileSync(CV_FILE, 'utf8');

  // Build job list
  let jobs = [];

  if (flags.all) {
    jobs = findInterviewJobs();
    if (jobs.length === 0) {
      warn('No jobs with "Entrevista" status in tracker. Update status first.');
      warn('Or use: node interview-prep.mjs --job "Company" --role "Role"');
      process.exit(0);
    }
    log(`Found ${jobs.length} interview-stage job(s)`);
  } else if (flags.job) {
    jobs = [{ company: flags.job, role: flags.role || 'Engineer' }];
  } else if (flags.report) {
    if (!existsSync(flags.report)) die(`Report not found: ${flags.report}`);
    const base = basename(flags.report, '.md').replace(/-\d{4}-\d{2}-\d{2}$/, '');
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

    // Find JD context
    const reportPath = job.reportPath || findReportForJob(company, role);
    const jdContext  = reportPath && existsSync(reportPath)
      ? readFileSync(reportPath, 'utf8')
      : `Role: ${role} at ${company}. Research this company's engineering culture and typical hiring process.`;

    if (!reportPath) {
      warn(`No report found for ${company} — generating from company/role names only`);
    }

    try {
      const data     = await generatePrepSheet(company, role, cvContent, jdContext);
      const markdown = renderPrepSheet(company, role, data);
      const outPath  = savePrepSheet(company, role, markdown);

      // Print preview
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`  🎤  INTERVIEW PREP: ${role.toUpperCase()} @ ${company.toUpperCase()}`);
      console.log('═'.repeat(60));
      console.log(`  ${data.overview?.slice(0, 120)}...`);
      console.log(`\n  📁 Full prep sheet: ${outPath}`);
      console.log(`  Questions: ${data.technicalQuestions?.length || 0} technical | ${data.behaviouralQuestions?.length || 0} behavioural | ${data.companyQuestions?.length || 0} company\n`);
      done++;
    } catch (err) {
      warn(`Failed for ${company} — ${role}: ${err.message}`);
    }
  }

  console.log(`\n✅ Generated ${done}/${jobs.length} prep sheet(s)\n`);
}

main().catch(err => die(err?.message || String(err)));
