#!/usr/bin/env node
// salary-bench.mjs — Phase 11a (v2.2)
// Gemini-powered salary benchmarking for every job in the tracker.
// Fetches market data (base, equity, total comp, percentiles) with a 48h cache.
//
// Usage:
//   node salary-bench.mjs --role "AI Engineer" --company "Stripe" --location "Remote"
//   node salary-bench.mjs --all            # All non-rejected jobs in tracker
//   node salary-bench.mjs --report         # Print full markdown summary table
//   node salary-bench.mjs --refresh        # Ignore cache, re-fetch everything
//
// Output:
//   data/salary-bench.json   (keyed cache)
//   data/salary-bench.md     (human-readable table, --report)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

const ROOT          = resolve(process.cwd());
const TRACKER_FILE  = join(ROOT, 'data', 'applications.md');
const BENCH_FILE    = join(ROOT, 'data', 'salary-bench.json');
const BENCH_MD      = join(ROOT, 'data', 'salary-bench.md');
const CACHE_TTL_MS  = 48 * 60 * 60 * 1000; // 48 hours

function log(msg)  { process.stderr.write(`[salary-bench] ${msg}\n`); }
function ok(msg)   { process.stderr.write(`✅ ${msg}\n`); }
function warn(msg) { process.stderr.write(`⚠️  ${msg}\n`); }
function die(msg)  { process.stderr.write(`❌ ${msg}\n`); process.exit(1); }

// ── CLI Args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { role: null, company: null, location: 'Remote', all: false, report: false, refresh: false, help: false };
  for (let i = 0; i < args.length; i++) {
    if      (args[i] === '--role'     && args[i+1]) flags.role     = args[++i];
    else if (args[i] === '--company'  && args[i+1]) flags.company  = args[++i];
    else if (args[i] === '--location' && args[i+1]) flags.location = args[++i];
    else if (args[i] === '--all')     flags.all     = true;
    else if (args[i] === '--report')  flags.report  = true;
    else if (args[i] === '--refresh') flags.refresh = true;
    else if (args[i] === '--help' || args[i] === '-h') flags.help = true;
  }
  return flags;
}

function printHelp() {
  console.log(`
salary-bench — Benchmark salary ranges for pipeline jobs

Usage:
  node salary-bench.mjs --role "AI Engineer" --company "Stripe"
  node salary-bench.mjs --all                # Process all active tracker jobs
  node salary-bench.mjs --report             # Print summary table
  node salary-bench.mjs --refresh            # Bypass cache, re-fetch all
  node salary-bench.mjs --help               # Show this help

Options:
  --role <title>        Job title to benchmark
  --company <name>      Company name (affects equity/stage estimates)
  --location <place>    Location context (default: Remote)

Output:
  data/salary-bench.json   Cached results
  data/salary-bench.md     Markdown summary table (--report)
`);
}

// ── Tracker Parser ────────────────────────────────────────────────────────────

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

// ── Cache Helpers ─────────────────────────────────────────────────────────────

function loadCache() {
  return existsSync(BENCH_FILE) ? JSON.parse(readFileSync(BENCH_FILE, 'utf8')) : {};
}

function saveCache(cache) {
  if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(BENCH_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

function cacheKey(company, role) {
  return `${company.toLowerCase().trim()}::${role.toLowerCase().trim()}`;
}

function isCacheValid(entry) {
  return entry && (Date.now() - entry.fetchedAt < CACHE_TTL_MS);
}

// ── Gemini Salary Intelligence ────────────────────────────────────────────────

const SALARY_PROMPT = (company, role, location) => `You are a compensation data analyst with access to current market data from Glassdoor, Levels.fyi, LinkedIn Salary, and Blind.

Provide realistic salary benchmarks for:
  Role: ${role}
  Company: ${company}
  Location/Remote: ${location}

Return ONLY a valid JSON object (no markdown, no code fences):
{
  "currency": "USD",
  "baseSalary": {
    "p25": <25th percentile annual base as integer>,
    "p50": <median annual base as integer>,
    "p75": <75th percentile annual base as integer>,
    "p90": <90th percentile annual base as integer>
  },
  "equity": {
    "typical": "<e.g. '0.01–0.05% for Series B' or '$50K–$200K RSU/year at public company'>",
    "vestingSchedule": "<standard vesting, e.g. '4-year cliff + monthly'>",
    "noteworthy": "<any equity-relevant info about this specific company stage>"
  },
  "totalComp": {
    "p50": <median total annual comp including equity and bonus, as integer>,
    "p90": <90th percentile total comp, as integer>
  },
  "bonus": "<typical annual bonus range, e.g. '10–20% of base'>",
  "benefits": ["<key benefit 1>", "<key benefit 2>", "<key benefit 3>"],
  "marketSignal": "hot|neutral|cooling",
  "negotiationTips": ["<tip 1>", "<tip 2>", "<tip 3>"],
  "dataQuality": "high|medium|low",
  "sources": ["<source name>", "<source name>"],
  "lastUpdated": "${new Date().toISOString().split('T')[0]}"
}

Be realistic. If the company is a startup, account for stage. If remote, note geo-pay differences.
For roles with high uncertainty, lower dataQuality to 'low' and widen ranges.`;

async function fetchSalaryFromGemini(company, role, location) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    die('GEMINI_API_KEY not set in .env — get a free key at https://aistudio.google.com/apikey');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const model = genAI.getGenerativeModel({ model: modelName });

  log(`Fetching salary data for ${role} at ${company} (${location})...`);

  const result = await model.generateContent(SALARY_PROMPT(company, role, location));
  const raw = result.response.text().trim();

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Gemini response');

  const parsed = JSON.parse(jsonMatch[0]);
  return { ...parsed, fetchedAt: Date.now(), company, role, location };
}

// ── Display Helpers ───────────────────────────────────────────────────────────

function formatUSD(n) {
  if (!n || isNaN(n)) return 'N/A';
  return '$' + Math.round(n / 1000) + 'K';
}

function signalBadge(signal) {
  if (signal === 'hot')     return '🔥 Hot';
  if (signal === 'cooling') return '❄️  Cooling';
  return '🟡 Neutral';
}

function qualityBadge(q) {
  if (q === 'high')   return '✅ High';
  if (q === 'low')    return '⚠️  Low';
  return '🔵 Medium';
}

function printEntry(entry) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`💰  ${entry.role} @ ${entry.company}  (${entry.location})`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`  Base Salary:`);
  console.log(`    p25 ${formatUSD(entry.baseSalary?.p25)}  │  p50 ${formatUSD(entry.baseSalary?.p50)}  │  p75 ${formatUSD(entry.baseSalary?.p75)}  │  p90 ${formatUSD(entry.baseSalary?.p90)}`);
  console.log(`  Total Comp:  p50 ${formatUSD(entry.totalComp?.p50)}  │  p90 ${formatUSD(entry.totalComp?.p90)}`);
  console.log(`  Bonus:       ${entry.bonus || 'N/A'}`);
  console.log(`  Equity:      ${entry.equity?.typical || 'N/A'}`);
  console.log(`               Vesting: ${entry.equity?.vestingSchedule || 'N/A'}`);
  console.log(`  Market:      ${signalBadge(entry.marketSignal)}   Data quality: ${qualityBadge(entry.dataQuality)}`);
  if (entry.negotiationTips?.length) {
    console.log(`  Negotiation Tips:`);
    entry.negotiationTips.forEach(t => console.log(`    • ${t}`));
  }
  if (entry.benefits?.length) {
    console.log(`  Benefits:    ${entry.benefits.join(' · ')}`);
  }
  console.log(`  Sources:     ${(entry.sources || []).join(', ')}`);
  const age = Math.round((Date.now() - entry.fetchedAt) / 3600000);
  console.log(`  Cached:      ${age}h ago (refreshes at 48h)\n`);
}

// ── Markdown Report ───────────────────────────────────────────────────────────

function writeMarkdownReport(cache) {
  const entries = Object.values(cache).sort((a, b) =>
    (b.baseSalary?.p50 || 0) - (a.baseSalary?.p50 || 0)
  );

  let md = `# Salary Benchmarks\n\n`;
  md += `*Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}*\n\n`;
  md += `| Company | Role | Base p50 | Base p90 | TC p50 | TC p90 | Bonus | Market | Quality |\n`;
  md += `|---------|------|----------|----------|--------|--------|-------|--------|---------|\n`;

  for (const e of entries) {
    const signal = e.marketSignal === 'hot' ? '🔥' : e.marketSignal === 'cooling' ? '❄️' : '🟡';
    const quality = e.dataQuality === 'high' ? '✅' : e.dataQuality === 'low' ? '⚠️' : '🔵';
    md += `| ${e.company} | ${e.role} | ${formatUSD(e.baseSalary?.p50)} | ${formatUSD(e.baseSalary?.p90)} | ${formatUSD(e.totalComp?.p50)} | ${formatUSD(e.totalComp?.p90)} | ${e.bonus || '—'} | ${signal} | ${quality} |\n`;
  }

  md += `\n---\n\n`;
  md += `## Detail\n\n`;
  for (const e of entries) {
    md += `### ${e.role} @ ${e.company}\n\n`;
    md += `- **Location:** ${e.location}\n`;
    md += `- **Base:** p25 ${formatUSD(e.baseSalary?.p25)} · p50 ${formatUSD(e.baseSalary?.p50)} · p75 ${formatUSD(e.baseSalary?.p75)} · p90 ${formatUSD(e.baseSalary?.p90)}\n`;
    md += `- **Total Comp:** p50 ${formatUSD(e.totalComp?.p50)} · p90 ${formatUSD(e.totalComp?.p90)}\n`;
    md += `- **Bonus:** ${e.bonus || 'N/A'}\n`;
    md += `- **Equity:** ${e.equity?.typical || 'N/A'} (${e.equity?.vestingSchedule || 'N/A'})\n`;
    if (e.equity?.noteworthy) md += `  - *${e.equity.noteworthy}*\n`;
    md += `- **Benefits:** ${(e.benefits || []).join(', ')}\n`;
    md += `- **Market signal:** ${signalBadge(e.marketSignal)} · Data quality: ${qualityBadge(e.dataQuality)}\n`;
    if (e.negotiationTips?.length) {
      md += `- **Negotiation tips:**\n`;
      e.negotiationTips.forEach(t => { md += `  - ${t}\n`; });
    }
    md += `- **Sources:** ${(e.sources || []).join(', ')}\n\n`;
  }

  writeFileSync(BENCH_MD, md, 'utf8');
  ok(`Saved salary report → data/salary-bench.md`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv);
  if (flags.help) { printHelp(); process.exit(0); }

  const cache = loadCache();

  // --report only
  if (flags.report && !flags.all && !flags.role) {
    const entries = Object.values(cache);
    if (entries.length === 0) { warn('No salary data yet. Run --all first.'); process.exit(0); }
    writeMarkdownReport(cache);
    entries.forEach(e => printEntry(e));
    process.exit(0);
  }

  // Build job list
  let jobs = [];
  if (flags.all) {
    jobs = loadActiveJobs();
    if (jobs.length === 0) { warn('No active jobs in tracker.'); process.exit(0); }
    log(`Found ${jobs.length} active job(s) to benchmark`);
  } else if (flags.role) {
    jobs = [{ company: flags.company || 'Unknown', role: flags.role }];
  } else {
    printHelp();
    die('Specify --role, --all, or --report');
  }

  let fetched = 0;
  let cached  = 0;

  for (const { company, role } of jobs) {
    const key   = cacheKey(company, role);
    const entry = cache[key];

    if (!flags.refresh && isCacheValid(entry)) {
      log(`Cache hit for ${company} — ${role} (${Math.round((Date.now() - entry.fetchedAt) / 3600000)}h old)`);
      cached++;
      continue;
    }

    try {
      const data  = await fetchSalaryFromGemini(company, role, flags.location);
      cache[key]  = data;
      saveCache(cache);
      printEntry(data);
      fetched++;
      // Rate limit: avoid hammering the free Gemini tier
      if (fetched < jobs.length) await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      warn(`Failed for ${company} — ${role}: ${err.message}`);
    }
  }

  if (flags.report) writeMarkdownReport(cache);

  console.log(`\n✅ Salary benchmarks: ${fetched} fetched, ${cached} from cache → data/salary-bench.json\n`);
  if (!flags.report) console.log(`   Run with --report to generate data/salary-bench.md\n`);
}

main().catch(err => die(err?.message || String(err)));
