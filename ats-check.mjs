#!/usr/bin/env node
// ats-check.mjs — ATS Score Checker
// Scores a resume against a job description before applying.
// Catches invisible rejections: keyword gaps, formatting issues, section problems.
//
// Usage:
//   node ats-check.mjs --jd "path/to/jd.txt"              # Score cv.md against JD file
//   node ats-check.mjs --jd "path/to/jd.txt" --resume "path/to/resume.md"
//   node ats-check.mjs --report "reports/stripe-ai-eng.md" # Use existing eval report as JD source
//   node ats-check.mjs --url "https://jobs.lever.co/..."   # Fetch JD from URL
//   node ats-check.mjs --all                               # Score all reports in reports/

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

const ROOT        = process.cwd();
const CV_FILE     = join(ROOT, 'cv.md');
const REPORTS_DIR = join(ROOT, 'reports');
const ATS_LOG     = join(ROOT, 'data', 'ats-scores.json');

function log(msg)  { process.stderr.write(`[ats-check] ${msg}\n`); }
function ok(msg)   { process.stderr.write(`✅ ${msg}\n`); }
function warn(msg) { process.stderr.write(`⚠️  ${msg}\n`); }
function die(msg)  { process.stderr.write(`❌ ${msg}\n`); process.exit(1); }

// ── Keyword Extraction ────────────────────────────────────────────────────────

// Common tech/soft skill patterns to extract from JDs
const TECH_KEYWORDS = [
  // Languages
  'python','javascript','typescript','java','go','golang','rust','c\\+\\+','c#','scala','kotlin','swift','ruby','php','r\\b',
  // AI/ML
  'machine learning','deep learning','nlp','llm','large language model','transformer','pytorch','tensorflow','keras','scikit','hugging face','rag','fine.?tun','embedding','vector database','langchain','llamaindex',
  // Cloud/Infra
  'aws','gcp','azure','kubernetes','k8s','docker','terraform','ansible','ci/cd','devops','mlops','airflow','spark','kafka','redis','postgresql','mysql','mongodb','elasticsearch',
  // Web
  'react','next\\.js','vue','angular','node','express','fastapi','django','flask','rest api','graphql','grpc',
  // Data
  'sql','pandas','numpy','data pipeline','etl','dbt','snowflake','bigquery','databricks',
  // Practices
  'agile','scrum','tdd','microservices','distributed systems','system design','a/b test',
];

function extractKeywordsFromText(text) {
  const lower = text.toLowerCase();
  const found = new Set();
  for (const kw of TECH_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(lower)) {
      found.add(kw.replace(/\\\\/g, '').replace(/[\\^$.*+?()[\]{}|]/g, '').replace(/\s+/g, ' ').trim());
    }
  }
  // Also extract capitalized n-grams (likely proper nouns / product names)
  const properNouns = [...lower.matchAll(/\b([A-Z][a-zA-Z0-9]*(?:\s[A-Z][a-zA-Z0-9]*)*)\b/g)]
    .map(m => m[1].toLowerCase())
    .filter(w => w.length > 3 && !['this','that','with','from','have','will','your','they','their'].includes(w));
  properNouns.forEach(n => found.add(n));
  return [...found];
}

// ── Formatting Checks ─────────────────────────────────────────────────────────

function checkFormatting(resumeText) {
  const issues = [];
  const warnings = [];

  // Check for table-like structures (pipes)
  if ((resumeText.match(/\|/g) || []).length > 10) {
    issues.push({ type: 'error', msg: 'Tables detected — most ATS systems cannot parse Markdown/HTML tables. Convert to plain bullet lists.' });
  }

  // Check for multi-column indicators (lots of tabs or aligned spaces)
  const lines = resumeText.split('\n');
  const tabLines = lines.filter(l => (l.match(/\t/g) || []).length > 2);
  if (tabLines.length > 5) {
    issues.push({ type: 'error', msg: 'Multi-column layout detected (tabs). ATS reads left-to-right only — use single column.' });
  }

  // Check for standard section headers
  const requiredSections = ['experience', 'education', 'skills'];
  const optionalSections = ['summary', 'objective', 'certifications', 'projects'];
  const resumeLower = resumeText.toLowerCase();

  for (const section of requiredSections) {
    if (!resumeLower.includes(section)) {
      issues.push({ type: 'error', msg: `Missing required section: "${section.toUpperCase()}". ATS expects standard section headers.` });
    }
  }

  // Check for special/Unicode characters
  const specialChars = [...resumeText.matchAll(/[^\x00-\x7F]/g)];
  if (specialChars.length > 20) {
    warnings.push({ type: 'warning', msg: `${specialChars.length} non-ASCII characters found. Some ATS systems strip them — prefer standard ASCII equivalents.` });
  }

  // Check length
  const wordCount = resumeText.split(/\s+/).filter(Boolean).length;
  if (wordCount < 300) {
    warnings.push({ type: 'warning', msg: `Resume is short (${wordCount} words). ATS prefers 450–800 words for most roles.` });
  } else if (wordCount > 1200) {
    warnings.push({ type: 'warning', msg: `Resume is long (${wordCount} words). Consider trimming to 800 words — ATS may truncate long resumes.` });
  }

  // Check for bullet points (good for ATS)
  const bulletCount = (resumeText.match(/^[-•*]\s/gm) || []).length;
  if (bulletCount < 5) {
    warnings.push({ type: 'warning', msg: 'Very few bullet points. ATS parses bullet-point achievements better than prose paragraphs.' });
  }

  // Check for dates (ATS validates employment history)
  const datePattern = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\.?\s+\d{4}\b/gi;
  const dates = resumeText.match(datePattern) || [];
  if (dates.length < 2) {
    warnings.push({ type: 'warning', msg: 'No employment dates detected. ATS requires clear start/end dates for experience sections.' });
  }

  // Check for quantified achievements
  const metrics = (resumeText.match(/\b\d+[%x]|\$\d+|\d+\s*(users|customers|teams|engineers|million|thousand|k\b)/gi) || []);
  if (metrics.length < 2) {
    warnings.push({ type: 'warning', msg: 'Few quantified achievements found. ATS and recruiters rank resumes with measurable impact (%, $, numbers) higher.' });
  }

  return { issues, warnings };
}

// ── Gemini AI Keyword Analysis ────────────────────────────────────────────────

async function analyzeWithGemini(resumeText, jdText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    warn('GEMINI_API_KEY not set — skipping AI analysis, using keyword matching only');
    return null;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });

  const prompt = `You are an ATS (Applicant Tracking System) expert. Analyze this resume against this job description.

Return ONLY a valid JSON object with this exact shape:
{
  "requiredKeywordsPresent": ["keyword1", "keyword2"],
  "requiredKeywordsMissing": ["keyword3", "keyword4"],
  "preferredKeywordsPresent": ["keyword5"],
  "preferredKeywordsMissing": ["keyword6", "keyword7"],
  "titleMatch": true,
  "seniorityMatch": true,
  "topRecommendations": [
    "Add 'MLOps' to your skills section — it appears 4 times in the JD",
    "Your summary doesn't mention 'distributed systems' which is a top requirement"
  ],
  "overallFit": "strong"
}

overallFit must be one of: "strong" | "good" | "moderate" | "weak"
topRecommendations: max 5, specific and actionable.

JOB DESCRIPTION:
${jdText.slice(0, 4000)}

RESUME:
${resumeText.slice(0, 4000)}`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim().replace(/```json\n?|\n?```/g, '');
    return JSON.parse(text);
  } catch (err) {
    warn(`AI analysis failed: ${err.message} — using keyword matching only`);
    return null;
  }
}

// ── Score Computation ─────────────────────────────────────────────────────────

function computeScore({ jdKeywords, resumeKeywords, formatting, aiAnalysis }) {
  let score = 100;
  const breakdown = {};

  // Keyword match (40 points)
  const jdSet  = new Set(jdKeywords.map(k => k.toLowerCase()));
  const cvSet  = new Set(resumeKeywords.map(k => k.toLowerCase()));
  const matched = [...jdSet].filter(k => cvSet.has(k));
  const missing = [...jdSet].filter(k => !cvSet.has(k));
  const keywordRatio = jdSet.size > 0 ? matched.length / jdSet.size : 1;
  const keywordScore = Math.round(keywordRatio * 40);
  breakdown.keywords = { score: keywordScore, max: 40, matched: matched.length, missing: missing.slice(0, 10), total: jdSet.size };
  score = score - 40 + keywordScore;

  // Formatting (35 points)
  const formatDeductions = formatting.issues.length * 10 + formatting.warnings.length * 3;
  const formatScore = Math.max(0, 35 - formatDeductions);
  breakdown.formatting = { score: formatScore, max: 35, issues: formatting.issues.length, warnings: formatting.warnings.length };
  score = score - 35 + formatScore;

  // AI analysis boost/penalty (25 points)
  if (aiAnalysis) {
    const fitMap = { strong: 25, good: 20, moderate: 12, weak: 5 };
    const aiScore = fitMap[aiAnalysis.overallFit] || 15;
    breakdown.aiAnalysis = { score: aiScore, max: 25, fit: aiAnalysis.overallFit };
    score = score - 25 + aiScore;
  } else {
    breakdown.aiAnalysis = { score: 15, max: 25, fit: 'unknown (no API key)' };
    score = score - 25 + 15;
  }

  return { total: Math.max(0, Math.min(100, score)), breakdown, missing };
}

// ── Report Renderer ───────────────────────────────────────────────────────────

function renderReport({ company, role, score, breakdown, formatting, aiAnalysis, missing }) {
  const bar = (pct) => '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
  const grade = score >= 80 ? '🟢 STRONG' : score >= 60 ? '🟡 MODERATE' : '🔴 WEAK';

  let out = '\n';
  out += `╔══════════════════════════════════════════════════════╗\n`;
  out += `║              ATS COMPATIBILITY REPORT                ║\n`;
  out += `╚══════════════════════════════════════════════════════╝\n\n`;
  if (company || role) out += `  Job: ${role || '?'} at ${company || '?'}\n\n`;

  out += `  Overall Score: ${score}/100  ${grade}\n`;
  out += `  ${bar(score)} ${score}%\n\n`;

  out += `  ── Score Breakdown ──────────────────────────────────\n`;
  out += `  Keywords  ${breakdown.keywords.score}/${breakdown.keywords.max}  `;
  out += `(${breakdown.keywords.matched}/${breakdown.keywords.total} JD keywords matched)\n`;
  out += `  Formatting ${breakdown.formatting.score}/${breakdown.formatting.max}  `;
  out += `(${breakdown.formatting.issues} errors, ${breakdown.formatting.warnings} warnings)\n`;
  out += `  AI Fit    ${breakdown.aiAnalysis.score}/${breakdown.aiAnalysis.max}  `;
  out += `(${breakdown.aiAnalysis.fit})\n\n`;

  if (missing.length > 0) {
    out += `  ── Missing Keywords ────────────────────────────────\n`;
    out += `  Add these to your resume to improve ATS pass rate:\n`;
    missing.forEach(kw => { out += `    • ${kw}\n`; });
    out += '\n';
  }

  if (formatting.issues.length > 0) {
    out += `  ── ❌ Critical Formatting Issues ───────────────────\n`;
    formatting.issues.forEach(i => { out += `    • ${i.msg}\n`; });
    out += '\n';
  }

  if (formatting.warnings.length > 0) {
    out += `  ── ⚠️  Formatting Warnings ──────────────────────────\n`;
    formatting.warnings.forEach(w => { out += `    • ${w.msg}\n`; });
    out += '\n';
  }

  if (aiAnalysis?.topRecommendations?.length > 0) {
    out += `  ── 💡 AI Recommendations ───────────────────────────\n`;
    aiAnalysis.topRecommendations.forEach(r => { out += `    • ${r}\n`; });
    out += '\n';
  }

  const verdict = score >= 80
    ? '  ✅ Your resume is likely to pass ATS filters. Apply with confidence.'
    : score >= 60
    ? '  🔧 Moderate ATS compatibility. Apply the recommendations above before submitting.'
    : '  🚨 High risk of ATS rejection. Fix critical issues before applying.';
  out += verdict + '\n\n';

  return out;
}

// ── Save to ATS Log ───────────────────────────────────────────────────────────

function saveToLog(entry) {
  const log = existsSync(ATS_LOG) ? JSON.parse(readFileSync(ATS_LOG, 'utf8')) : [];
  const idx = log.findIndex(e => e.company === entry.company && e.role === entry.role);
  if (idx >= 0) log[idx] = entry; else log.push(entry);
  writeFileSync(ATS_LOG, JSON.stringify(log, null, 2));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function checkOne({ jdText, resumeText, company, role }) {
  log(`Checking: ${role || 'unknown role'} at ${company || 'unknown company'}`);

  const jdKeywords     = extractKeywordsFromText(jdText);
  const resumeKeywords = extractKeywordsFromText(resumeText);
  const formatting     = checkFormatting(resumeText);
  const aiAnalysis     = await analyzeWithGemini(resumeText, jdText);

  const { total: score, breakdown, missing } = computeScore({ jdKeywords, resumeKeywords, formatting, aiAnalysis });

  const report = renderReport({ company, role, score, breakdown, formatting, aiAnalysis, missing });
  console.log(report);

  saveToLog({ company, role, score, breakdown, missing, checkedAt: new Date().toISOString() });
  ok(`ATS score: ${score}/100 saved to data/ats-scores.json`);
  return { score, breakdown, missing, formatting, aiAnalysis };
}

async function main() {
  const args = process.argv.slice(2);
  const flags = { jd: null, resume: null, report: null, url: null, all: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--jd'     && args[i+1]) flags.jd     = args[++i];
    if (args[i] === '--resume' && args[i+1]) flags.resume = args[++i];
    if (args[i] === '--report' && args[i+1]) flags.report = args[++i];
    if (args[i] === '--url'    && args[i+1]) flags.url    = args[++i];
    if (args[i] === '--all') flags.all = true;
  }

  if (!existsSync(CV_FILE)) die('cv.md not found. Run: node resume-import.mjs your-resume.pdf');
  const resumeText = readFileSync(flags.resume ? resolve(flags.resume) : CV_FILE, 'utf8');

  if (flags.all) {
    if (!existsSync(REPORTS_DIR)) die('No reports directory found');
    const reports = readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'));
    if (reports.length === 0) { warn('No reports found in reports/'); return; }

    log(`Checking ${reports.length} reports...`);
    const results = [];
    for (const file of reports) {
      const content = readFileSync(join(REPORTS_DIR, file), 'utf8');
      // Extract JD text from report (look for job description section)
      const jdMatch = content.match(/##\s*(?:Job Description|JD|Role|Position)[^\n]*\n([\s\S]+?)(?=\n##|$)/i);
      const jdText  = jdMatch ? jdMatch[1] : content.slice(0, 3000);
      const parts   = file.replace('.md','').split('-');
      const company = parts[0] || '';
      const role    = parts.slice(1).join(' ');
      const result  = await checkOne({ jdText, resumeText, company, role });
      results.push({ file, score: result.score });
    }

    console.log('\n📊 Summary:');
    results.sort((a,b) => b.score - a.score)
      .forEach(r => console.log(`  ${r.score >= 80 ? '🟢' : r.score >= 60 ? '🟡' : '🔴'} ${r.score}/100 — ${r.file}`));
    return;
  }

  let jdText = '';
  let company = '', role = '';

  if (flags.jd) {
    jdText = readFileSync(resolve(flags.jd), 'utf8');
  } else if (flags.report) {
    const content = readFileSync(resolve(flags.report), 'utf8');
    jdText = content.slice(0, 4000);
    const parts = flags.report.replace('.md','').split(/[\\/]/).pop().split('-');
    company = parts[0] || ''; role = parts.slice(1).join(' ');
  } else if (flags.url) {
    log(`Fetching JD from ${flags.url}...`);
    const res = await fetch(flags.url);
    const html = await res.text();
    jdText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 5000);
  } else {
    console.log(`
ats-check — ATS Resume Compatibility Scorer

Usage:
  node ats-check.mjs --jd jd.txt
  node ats-check.mjs --jd jd.txt --resume custom-resume.md
  node ats-check.mjs --report reports/stripe-engineer.md
  node ats-check.mjs --url "https://jobs.lever.co/..."
  node ats-check.mjs --all
`);
    process.exit(1);
  }

  await checkOne({ jdText, resumeText, company, role });
}

main().catch(err => { process.stderr.write(`❌ ${err?.message || err}\n`); process.exit(1); });
