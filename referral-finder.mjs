#!/usr/bin/env node
// referral-finder.mjs — Phase 9a
// Referral Network Detector: match your LinkedIn 1st-degree connections
// against companies in your pipeline, then draft warm intro message templates.
//
// Usage:
//   node referral-finder.mjs --connections ~/Downloads/Connections.csv
//   node referral-finder.mjs --connections Connections.csv --all
//   node referral-finder.mjs --connections Connections.csv --company "Stripe"
//   node referral-finder.mjs --report               # Print data/referrals.md
//
// How to get your LinkedIn CSV:
//   LinkedIn.com → Me → Settings & Privacy → Data Privacy
//   → Get a copy of your data → Connections → Request archive
//   (arrives in your email within ~10 min as Connections.csv)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, basename } from 'path';
import 'dotenv/config';

const ROOT           = process.cwd();
const TRACKER_FILE   = join(ROOT, 'data', 'applications.md');
const PIPELINE_FILE  = join(ROOT, 'data', 'pipeline.md');
const REFERRALS_FILE = join(ROOT, 'data', 'referrals.md');
const CV_FILE        = join(ROOT, 'cv.md');

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg)  { process.stderr.write(`[referral-finder] ${msg}\n`); }
function ok(msg)   { process.stderr.write(`✅ ${msg}\n`); }
function warn(msg) { process.stderr.write(`⚠️  ${msg}\n`); }
function die(msg)  { process.stderr.write(`❌ ${msg}\n`); process.exit(1); }

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { connections: null, company: null, all: false, report: false, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--connections' && args[i + 1]) flags.connections = resolve(args[++i]);
    else if (args[i] === '--company' && args[i + 1])    flags.company = args[++i];
    else if (args[i] === '--all')     flags.all = true;
    else if (args[i] === '--report')  flags.report = true;
    else if (args[i] === '--help' || args[i] === '-h') flags.help = true;
  }
  return flags;
}

function printHelp() {
  console.log(`
referral-finder — Detect LinkedIn connections at your pipeline companies

Usage:
  node referral-finder.mjs --connections <file.csv> [options]

Options:
  --connections <path>   Path to LinkedIn Connections.csv export
  --company <name>       Only check a specific company name
  --all                  Process all companies in applications.md + pipeline.md
  --report               Print the saved data/referrals.md
  --help                 Show this help message

How to get Connections.csv:
  LinkedIn.com → Me → Settings & Privacy → Data Privacy
  → Get a copy of your data → select "Connections" → Request archive
  (arrives in your email in ~10 min)

Examples:
  node referral-finder.mjs --connections ~/Downloads/Connections.csv --all
  node referral-finder.mjs --connections Connections.csv --company "Stripe"
`);
}

// ── CSV Parser ────────────────────────────────────────────────────────────────
// LinkedIn exports a CSV with a 3-line header, then column headers, then data.
// Format: First Name,Last Name,URL,Email Address,Company,Position,Connected On

function parseLinkedInCSV(csvPath) {
  if (!existsSync(csvPath)) die(`Connections CSV not found: ${csvPath}`);

  const raw = readFileSync(csvPath, 'utf8');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

  // Find the header row (contains "First Name" or "URL")
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/first\s*name/i.test(lines[i]) || /^"?first\s*name/i.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    die('Could not find header row in CSV. Expected columns: First Name, Last Name, URL, Email Address, Company, Position, Connected On');
  }

  // Parse header columns
  const headers = parseCSVRow(lines[headerIdx]).map(h => h.toLowerCase().trim());
  const colIdx = {
    firstName:   headers.findIndex(h => h.includes('first')),
    lastName:    headers.findIndex(h => h.includes('last')),
    url:         headers.findIndex(h => h === 'url' || h.includes('linkedin')),
    email:       headers.findIndex(h => h.includes('email')),
    company:     headers.findIndex(h => h.includes('company')),
    position:    headers.findIndex(h => h.includes('position') || h.includes('title')),
    connectedOn: headers.findIndex(h => h.includes('connected')),
  };

  if (colIdx.firstName === -1 || colIdx.company === -1) {
    warn(`Header columns found: ${headers.join(', ')}`);
    die('Missing required columns "First Name" and "Company" in CSV');
  }

  const connections = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i]);
    if (cols.length < 3) continue;

    const company = (cols[colIdx.company] || '').trim();
    if (!company) continue;

    connections.push({
      firstName:   (cols[colIdx.firstName] || '').trim(),
      lastName:    (cols[colIdx.lastName]  || '').trim(),
      url:         colIdx.url  >= 0 ? (cols[colIdx.url]  || '').trim() : '',
      email:       colIdx.email >= 0 ? (cols[colIdx.email] || '').trim() : '',
      company,
      position:    colIdx.position >= 0 ? (cols[colIdx.position] || '').trim() : '',
      connectedOn: colIdx.connectedOn >= 0 ? (cols[colIdx.connectedOn] || '').trim() : '',
    });
  }

  ok(`Parsed ${connections.length} connections from ${basename(csvPath)}`);
  return connections;
}

// Simple CSV row parser that handles quoted fields with commas
function parseCSVRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ── Company Extraction ────────────────────────────────────────────────────────

function extractCompaniesFromTracker() {
  const companies = new Set();

  if (existsSync(TRACKER_FILE)) {
    const content = readFileSync(TRACKER_FILE, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.startsWith('|') || line.includes('---')) continue;
      const cells = line.split('|').map(c => c.trim()).filter(Boolean);
      // Skip header row; company is column 3 (index 2)
      if (cells.length >= 3 && cells[0] !== '#' && cells[0] !== 'Nº' && !isNaN(parseInt(cells[0]))) {
        const company = cells[2];
        if (company && company !== 'Company') companies.add(company.trim());
      }
    }
  }

  if (existsSync(PIPELINE_FILE)) {
    const content = readFileSync(PIPELINE_FILE, 'utf8');
    // Pipeline format: - [ ] <url> | <title> at <company> | Added: ...
    const companyRe = /at\s+(.+?)\s*\|/gi;
    let m;
    while ((m = companyRe.exec(content)) !== null) {
      companies.add(m[1].trim());
    }
  }

  return [...companies];
}

// ── Fuzzy Name Matching ───────────────────────────────────────────────────────
// Normalizes company names for comparison — removes Inc/Ltd/LLC suffixes,
// lowercases, strips punctuation.

function normalizeCompanyName(name) {
  return name
    .toLowerCase()
    .replace(/\b(inc|ltd|llc|corp|co|gmbh|s\.a\.|plc|ag|bv|nv|oy|ab|as)\b\.?/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function companiesMatch(trackerName, connectionCompany) {
  const a = normalizeCompanyName(trackerName);
  const b = normalizeCompanyName(connectionCompany);

  if (a === b) return true;

  // One contains the other (e.g. "Stripe" matches "Stripe, Inc.")
  if (a.includes(b) || b.includes(a)) return true;

  // Word overlap: ≥60% of shorter name's words appear in longer
  const wordsA = a.split(' ').filter(w => w.length > 2);
  const wordsB = b.split(' ').filter(w => w.length > 2);
  const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
  const longer  = wordsA.length >  wordsB.length ? wordsA : wordsB;
  if (shorter.length === 0) return false;
  const overlap = shorter.filter(w => longer.includes(w)).length;
  return overlap / shorter.length >= 0.6;
}

// ── Matching Engine ───────────────────────────────────────────────────────────

function findMatches(connections, targetCompanies) {
  const results = {}; // company → { connections: [], trackerName }

  for (const trackerName of targetCompanies) {
    for (const conn of connections) {
      if (companiesMatch(trackerName, conn.company)) {
        if (!results[trackerName]) results[trackerName] = { trackerName, connections: [] };
        results[trackerName].connections.push(conn);
      }
    }
  }

  return Object.values(results).filter(r => r.connections.length > 0);
}

// ── Message Template Generator ────────────────────────────────────────────────

function getApplicantName() {
  if (!existsSync(CV_FILE)) return 'Your Name';
  const cv = readFileSync(CV_FILE, 'utf8');
  const match = cv.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : 'Your Name';
}

function generateIntroMessage(conn, trackerName, applicantName) {
  const firstName = conn.firstName || 'there';
  const role = conn.position ? ` (${conn.position})` : '';

  return `Hi ${firstName},

I noticed you work at ${trackerName}${role} — I'm currently exploring opportunities there and would love to get your take on the team and culture.

I've been focused on [your area] and have experience in [2-3 relevant skills]. I won't take much of your time — even a 15-minute call or a quick note about what it's like to work there would be hugely helpful.

Happy to connect: ${conn.url || 'LinkedIn'}

Thanks,
${applicantName}`.trim();
}

// ── Report Writer ─────────────────────────────────────────────────────────────

function writeReferralsReport(matches, applicantName) {
  if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  let md = `# Referral Network Map\n\n`;
  md += `*Generated: ${date} | ${matches.reduce((s, m) => s + m.connections.length, 0)} connections across ${matches.length} pipeline companies*\n\n`;
  md += `---\n\n`;

  if (matches.length === 0) {
    md += `> No matches found. Import a larger connections set or add more companies to your pipeline.\n`;
  }

  for (const match of matches.sort((a, b) => b.connections.length - a.connections.length)) {
    md += `## ${match.trackerName}\n\n`;
    md += `**${match.connections.length} connection${match.connections.length > 1 ? 's' : ''}**\n\n`;
    md += `| Name | Position | LinkedIn | Email | Connected |\n`;
    md += `|------|----------|----------|-------|-----------|\n`;

    for (const conn of match.connections) {
      const name = `${conn.firstName} ${conn.lastName}`.trim();
      const linkedin = conn.url ? `[Profile](${conn.url})` : '—';
      const email = conn.email || '—';
      md += `| ${name} | ${conn.position || '—'} | ${linkedin} | ${email} | ${conn.connectedOn || '—'} |\n`;
    }

    md += `\n### Intro Message Template\n\n`;
    // Generate a template for the most relevant contact (prefer someone with "engineer", "recruiter", "hr", "talent" in title)
    const priority = match.connections.find(c =>
      /recruiter|talent|hr|people|hiring/i.test(c.position)
    ) || match.connections.find(c =>
      /engineer|developer|manager|lead|director/i.test(c.position)
    ) || match.connections[0];

    md += `*For: ${priority.firstName} ${priority.lastName} (${priority.position || 'Connection'})*\n\n`;
    md += `\`\`\`\n${generateIntroMessage(priority, match.trackerName, applicantName)}\n\`\`\`\n\n`;
    md += `---\n\n`;
  }

  writeFileSync(REFERRALS_FILE, md, 'utf8');
  ok(`Saved referral map → ${REFERRALS_FILE}`);
  return md;
}

// ── Console Output ────────────────────────────────────────────────────────────

function printSummary(matches, totalConnections) {
  console.log('\n' + '═'.repeat(60));
  console.log('  🤝  REFERRAL NETWORK REPORT');
  console.log('═'.repeat(60));
  console.log(`  Connections scanned : ${totalConnections}`);
  console.log(`  Pipeline companies  : match source`);
  console.log(`  Matches found       : ${matches.length} companies`);
  console.log(`  Total connections   : ${matches.reduce((s, m) => s + m.connections.length, 0)}`);
  console.log('═'.repeat(60));

  if (matches.length === 0) {
    console.log('\n  No matches found in current pipeline.');
    console.log('  Add more companies to data/applications.md or data/pipeline.md\n');
    return;
  }

  console.log('');
  for (const match of matches.sort((a, b) => b.connections.length - a.connections.length)) {
    const indicator = match.connections.length >= 3 ? '🔥' : match.connections.length === 2 ? '⭐' : '✅';
    console.log(`  ${indicator}  ${match.trackerName}`);
    for (const conn of match.connections) {
      const name = `${conn.firstName} ${conn.lastName}`.padEnd(24);
      const pos  = (conn.position || 'Unknown role').slice(0, 32);
      console.log(`       └─ ${name} ${pos}`);
    }
    console.log('');
  }

  console.log(`📄 Full report with message templates: data/referrals.md\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv);

  if (flags.help) { printHelp(); process.exit(0); }

  // Report mode: just print existing referrals.md
  if (flags.report) {
    if (!existsSync(REFERRALS_FILE)) {
      die('No referrals report found. Run: node referral-finder.mjs --connections Connections.csv --all');
    }
    console.log(readFileSync(REFERRALS_FILE, 'utf8'));
    process.exit(0);
  }

  if (!flags.connections) {
    printHelp();
    die('--connections <file> is required');
  }

  // Step 1: Parse the LinkedIn CSV
  const connections = parseLinkedInCSV(flags.connections);
  if (connections.length === 0) die('No connections parsed from CSV');

  // Step 2: Build company list
  let targetCompanies = [];

  if (flags.company) {
    targetCompanies = [flags.company];
    log(`Checking single company: ${flags.company}`);
  } else if (flags.all) {
    targetCompanies = extractCompaniesFromTracker();
    log(`Loaded ${targetCompanies.length} companies from tracker + pipeline`);
  } else {
    targetCompanies = extractCompaniesFromTracker();
    log(`Loaded ${targetCompanies.length} companies from tracker + pipeline`);
  }

  if (targetCompanies.length === 0) {
    warn('No companies found in pipeline. Add jobs to data/applications.md or data/pipeline.md first.');
    warn('Or specify a company directly: --company "Stripe"');
    process.exit(0);
  }

  // Step 3: Find matches
  log('Matching connections against pipeline companies...');
  const matches = findMatches(connections, targetCompanies);
  log(`Found ${matches.length} companies with connections`);

  // Step 4: Get applicant name for message templates
  const applicantName = getApplicantName();

  // Step 5: Write report
  writeReferralsReport(matches, applicantName);

  // Step 6: Print summary
  printSummary(matches, connections.length);
}

main().catch(err => die(err?.message || String(err)));
