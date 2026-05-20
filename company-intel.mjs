#!/usr/bin/env node
// company-intel.mjs — Phase 9b
// Company Intel Monitor: uses Gemini to surface recent signals about companies
// in your pipeline — funding rounds, layoffs, hiring freezes, growth signals.
// Results are cached for 48 hours and classified as 🟢/🟡/🔴 traffic lights.
//
// Usage:
//   node company-intel.mjs --company "Stripe"
//   node company-intel.mjs --all               # Check every company in pipeline
//   node company-intel.mjs --report            # Print cached intel as a report
//   node company-intel.mjs --refresh           # Force re-fetch (ignore cache)
//
// Requirements: GEMINI_API_KEY in .env

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import 'dotenv/config';

const ROOT         = process.cwd();
const TRACKER_FILE = join(ROOT, 'data', 'applications.md');
const PIPELINE_FILE = join(ROOT, 'data', 'pipeline.md');
const INTEL_FILE   = join(ROOT, 'data', 'company-intel.json');
const REPORT_FILE  = join(ROOT, 'data', 'company-intel.md');

const CACHE_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
const GEMINI_DELAY_MS = 1500; // rate-limit buffer between API calls

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg)  { process.stderr.write(`[company-intel] ${msg}\n`); }
function ok(msg)   { process.stderr.write(`✅ ${msg}\n`); }
function warn(msg) { process.stderr.write(`⚠️  ${msg}\n`); }
function die(msg)  { process.stderr.write(`❌ ${msg}\n`); process.exit(1); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { company: null, all: false, report: false, refresh: false, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--company' && args[i + 1]) flags.company = args[++i];
    else if (args[i] === '--all')     flags.all = true;
    else if (args[i] === '--report')  flags.report = true;
    else if (args[i] === '--refresh') flags.refresh = true;
    else if (args[i] === '--help' || args[i] === '-h') flags.help = true;
  }
  return flags;
}

function printHelp() {
  console.log(`
company-intel — Monitor company health signals for your pipeline

Usage:
  node company-intel.mjs --company <name>   Fetch intel for one company
  node company-intel.mjs --all              Fetch intel for all pipeline companies
  node company-intel.mjs --report           Print saved intel as Markdown report
  node company-intel.mjs --refresh          Force re-fetch (bypass 48h cache)
  node company-intel.mjs --help             Show this help

Signals classified as:
  🟢 GROW    — Active hiring, positive funding news, no red flags
  🟡 CAUTION — Mixed signals, leadership changes, uncertainty
  🔴 AVOID   — Layoffs, hiring freeze, restructuring, financial distress

Results cached 48h in data/company-intel.json to respect API limits.

Examples:
  node company-intel.mjs --company "Stripe"
  node company-intel.mjs --all --refresh
`);
}

// ── Cache Management ──────────────────────────────────────────────────────────

function loadCache() {
  if (!existsSync(INTEL_FILE)) return {};
  try {
    return JSON.parse(readFileSync(INTEL_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(INTEL_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

function isCacheValid(entry) {
  if (!entry || !entry.fetchedAt) return false;
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

// ── Company Extraction ────────────────────────────────────────────────────────

function extractCompaniesFromTracker() {
  const companies = new Set();

  if (existsSync(TRACKER_FILE)) {
    const content = readFileSync(TRACKER_FILE, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.startsWith('|') || line.includes('---')) continue;
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length >= 3 && cells[0] !== '#' && cells[0] !== 'Nº' && !isNaN(parseInt(cells[0]))) {
        const company = cells[2];
        if (company && company !== 'Company') companies.add(company.trim());
      }
    }
  }

  if (existsSync(PIPELINE_FILE)) {
    const content = readFileSync(PIPELINE_FILE, 'utf8');
    const re = /at\s+(.+?)\s*\|/gi;
    let m;
    while ((m = re.exec(content)) !== null) {
      companies.add(m[1].trim());
    }
  }

  return [...companies];
}

// ── Gemini Intel Fetch ────────────────────────────────────────────────────────

const INTEL_PROMPT_TEMPLATE = (company) => `You are a company research analyst. Analyze "${company}" based on your training data and return a JSON object with structured intel.

Consider: recent layoffs, hiring freezes, growth signals, funding rounds, executive changes, product launches, financial health, employee sentiment, and tech stack.

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "signal": "grow" | "caution" | "avoid",
  "confidence": "high" | "medium" | "low",
  "summary": "2-3 sentence overview of current company health and trajectory",
  "positives": ["list of positive signals — funding, hiring, growth, launches"],
  "negatives": ["list of red flags — layoffs, freezes, restructuring, financial issues"],
  "recentNews": ["2-4 recent notable events or signals you know about"],
  "hiringSignal": "active" | "selective" | "frozen" | "unknown",
  "techStack": ["primary technologies used — languages, cloud, frameworks"],
  "stage": "startup" | "scaleup" | "public" | "enterprise" | "unknown",
  "lastFunding": "funding round and amount if known, or null",
  "headcount": "approximate employee count or range if known, or null",
  "applicationAdvice": "1 sentence: specific advice for someone applying to this company right now"
}

Company: ${company}`;

async function fetchIntelFromGemini(company) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    die('GEMINI_API_KEY not set in .env — get a free key at https://aistudio.google.com/apikey');
  }

  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const model = genAI.getGenerativeModel({ model: modelName });

  log(`Fetching intel for: ${company} (${modelName})`);

  try {
    const result = await model.generateContent(INTEL_PROMPT_TEMPLATE(company));
    const raw = result.response.text().trim();

    // Extract JSON even if wrapped in markdown code fences
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in Gemini response');

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (!parsed.signal || !['grow', 'caution', 'avoid'].includes(parsed.signal)) {
      warn(`Invalid signal value for ${company}: ${parsed.signal} — defaulting to caution`);
      parsed.signal = 'caution';
    }

    return {
      company,
      fetchedAt: Date.now(),
      ...parsed,
    };
  } catch (err) {
    warn(`Failed to fetch intel for ${company}: ${err.message}`);
    return {
      company,
      fetchedAt: Date.now(),
      signal: 'caution',
      confidence: 'low',
      summary: `Could not retrieve intel for ${company}. Manual research recommended.`,
      positives: [],
      negatives: ['Intel fetch failed — treat as unknown'],
      recentNews: [],
      hiringSignal: 'unknown',
      techStack: [],
      stage: 'unknown',
      lastFunding: null,
      headcount: null,
      applicationAdvice: 'Research this company manually before applying.',
      error: err.message,
    };
  }
}

// ── Signal Formatting ─────────────────────────────────────────────────────────

function signalEmoji(signal) {
  if (signal === 'grow')    return '🟢';
  if (signal === 'avoid')   return '🔴';
  return '🟡';
}

function signalLabel(signal) {
  if (signal === 'grow')    return 'GROW';
  if (signal === 'avoid')   return 'AVOID';
  return 'CAUTION';
}

function hiringEmoji(hiringSignal) {
  if (hiringSignal === 'active')    return '🚀 Active hiring';
  if (hiringSignal === 'selective') return '🎯 Selective hiring';
  if (hiringSignal === 'frozen')    return '🧊 Hiring frozen';
  return '❓ Unknown';
}

function confidenceLabel(confidence) {
  if (confidence === 'high')   return '▓▓▓ High';
  if (confidence === 'medium') return '▓▓░ Medium';
  return '▓░░ Low';
}

function cacheAgeLabel(fetchedAt) {
  const ageMs = Date.now() - fetchedAt;
  const ageH  = Math.floor(ageMs / 3600000);
  const ageM  = Math.floor((ageMs % 3600000) / 60000);
  if (ageH === 0) return `${ageM}m ago`;
  return `${ageH}h ago`;
}

// ── Console Output ────────────────────────────────────────────────────────────

function printIntelCard(intel) {
  const emoji = signalEmoji(intel.signal);
  const label = signalLabel(intel.signal);
  const age   = cacheAgeLabel(intel.fetchedAt);

  console.log('\n' + '─'.repeat(60));
  console.log(`  ${emoji}  ${intel.company.toUpperCase()}  [${label}]  (${age})`);
  console.log('─'.repeat(60));
  console.log(`  📊 Stage:      ${intel.stage || 'unknown'}`);
  console.log(`  👥 Headcount:  ${intel.headcount || 'unknown'}`);
  console.log(`  💰 Funding:    ${intel.lastFunding || 'unknown'}`);
  console.log(`  🔍 Confidence: ${confidenceLabel(intel.confidence)}`);
  console.log(`  ${hiringEmoji(intel.hiringSignal)}`);
  console.log('');
  console.log(`  ${intel.summary}`);

  if (intel.positives && intel.positives.length > 0) {
    console.log('\n  ✅ Positives:');
    intel.positives.forEach(p => console.log(`     + ${p}`));
  }

  if (intel.negatives && intel.negatives.length > 0) {
    console.log('\n  ⚠️  Concerns:');
    intel.negatives.forEach(n => console.log(`     - ${n}`));
  }

  if (intel.recentNews && intel.recentNews.length > 0) {
    console.log('\n  📰 Recent signals:');
    intel.recentNews.forEach(n => console.log(`     • ${n}`));
  }

  if (intel.techStack && intel.techStack.length > 0) {
    console.log(`\n  🛠  Tech stack: ${intel.techStack.join(', ')}`);
  }

  if (intel.applicationAdvice) {
    console.log(`\n  💡 Advice: ${intel.applicationAdvice}`);
  }
  console.log('');
}

// ── Markdown Report Writer ────────────────────────────────────────────────────

function writeMarkdownReport(cache) {
  const entries = Object.values(cache).sort((a, b) => {
    const order = { avoid: 0, caution: 1, grow: 2 };
    return (order[b.signal] ?? 1) - (order[a.signal] ?? 1);
  });

  const date = new Date().toISOString().split('T')[0];
  let md = `# Company Intel Report\n\n`;
  md += `*Generated: ${date} | ${entries.length} companies tracked*\n\n`;

  // Summary table
  const grow    = entries.filter(e => e.signal === 'grow').length;
  const caution = entries.filter(e => e.signal === 'caution').length;
  const avoid   = entries.filter(e => e.signal === 'avoid').length;

  md += `## Summary\n\n`;
  md += `| Signal | Count |\n|--------|-------|\n`;
  md += `| 🟢 GROW | ${grow} |\n`;
  md += `| 🟡 CAUTION | ${caution} |\n`;
  md += `| 🔴 AVOID | ${avoid} |\n\n`;

  md += `## Quick Reference\n\n`;
  md += `| Company | Signal | Hiring | Confidence | Updated |\n`;
  md += `|---------|--------|--------|------------|---------|\n`;

  for (const intel of entries) {
    const emoji   = signalEmoji(intel.signal);
    const label   = signalLabel(intel.signal);
    const hiring  = intel.hiringSignal || 'unknown';
    const conf    = intel.confidence || 'low';
    const updated = new Date(intel.fetchedAt).toISOString().split('T')[0];
    md += `| ${intel.company} | ${emoji} ${label} | ${hiring} | ${conf} | ${updated} |\n`;
  }

  md += `\n---\n\n`;

  // Detailed sections
  for (const intel of entries) {
    const emoji = signalEmoji(intel.signal);
    const age   = cacheAgeLabel(intel.fetchedAt);

    md += `## ${emoji} ${intel.company}\n\n`;
    md += `**Signal:** ${signalLabel(intel.signal)} | **Confidence:** ${intel.confidence} | **Updated:** ${age}\n\n`;
    md += `**${intel.summary}**\n\n`;

    if (intel.positives && intel.positives.length > 0) {
      md += `**Positives:**\n`;
      intel.positives.forEach(p => md += `- ✅ ${p}\n`);
      md += '\n';
    }

    if (intel.negatives && intel.negatives.length > 0) {
      md += `**Concerns:**\n`;
      intel.negatives.forEach(n => md += `- ⚠️ ${n}\n`);
      md += '\n';
    }

    if (intel.recentNews && intel.recentNews.length > 0) {
      md += `**Recent signals:**\n`;
      intel.recentNews.forEach(n => md += `- ${n}\n`);
      md += '\n';
    }

    const details = [];
    if (intel.stage)        details.push(`Stage: ${intel.stage}`);
    if (intel.headcount)    details.push(`Headcount: ${intel.headcount}`);
    if (intel.lastFunding)  details.push(`Funding: ${intel.lastFunding}`);
    if (intel.techStack && intel.techStack.length > 0) details.push(`Stack: ${intel.techStack.join(', ')}`);
    if (details.length > 0) md += `*${details.join(' | ')}*\n\n`;

    if (intel.applicationAdvice) md += `> 💡 **${intel.applicationAdvice}**\n\n`;

    md += `---\n\n`;
  }

  writeFileSync(REPORT_FILE, md, 'utf8');
  ok(`Saved intel report → ${REPORT_FILE}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv);

  if (flags.help) { printHelp(); process.exit(0); }

  // Report mode: print saved report or generate from cache
  if (flags.report) {
    const cache = loadCache();
    if (Object.keys(cache).length === 0) {
      die('No intel data found. Run: node company-intel.mjs --all');
    }
    writeMarkdownReport(cache);
    console.log(readFileSync(REPORT_FILE, 'utf8'));
    process.exit(0);
  }

  // Determine companies to process
  let companies = [];
  if (flags.company) {
    companies = [flags.company];
  } else if (flags.all) {
    companies = extractCompaniesFromTracker();
    log(`Found ${companies.length} companies in pipeline`);
  } else {
    printHelp();
    die('Specify --company <name> or --all');
  }

  if (companies.length === 0) {
    warn('No companies found. Add jobs to data/applications.md or data/pipeline.md first.');
    process.exit(0);
  }

  // Load existing cache
  const cache = loadCache();
  let fetchCount = 0;

  for (const company of companies) {
    const cacheKey = company.toLowerCase().trim();

    // Check cache validity
    if (!flags.refresh && isCacheValid(cache[cacheKey])) {
      log(`Using cached intel for ${company} (${cacheAgeLabel(cache[cacheKey].fetchedAt)} old)`);
      printIntelCard(cache[cacheKey]);
      continue;
    }

    // Fetch fresh intel
    if (fetchCount > 0) await sleep(GEMINI_DELAY_MS); // rate limiting
    const intel = await fetchIntelFromGemini(company);
    cache[cacheKey] = intel;
    fetchCount++;

    // Save cache after each fetch (resilient to interruption)
    saveCache(cache);
    printIntelCard(intel);
  }

  // Write markdown report
  writeMarkdownReport(cache);

  // Summary line
  const results = companies.map(c => cache[c.toLowerCase().trim()]).filter(Boolean);
  const grow    = results.filter(r => r.signal === 'grow').length;
  const caution = results.filter(r => r.signal === 'caution').length;
  const avoid   = results.filter(r => r.signal === 'avoid').length;

  console.log('═'.repeat(60));
  console.log('  INTEL SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  🟢 GROW    : ${grow} companies`);
  console.log(`  🟡 CAUTION : ${caution} companies`);
  console.log(`  🔴 AVOID   : ${avoid} companies`);
  console.log(`\n  Full report: data/company-intel.md`);
  console.log(`  Cache file : data/company-intel.json\n`);

  if (avoid > 0) {
    console.log('  🔴 Companies to reconsider:');
    results.filter(r => r.signal === 'avoid').forEach(r => console.log(`     - ${r.company}`));
    console.log('');
  }
}

main().catch(err => die(err?.message || String(err)));
