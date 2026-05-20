#!/usr/bin/env node
// contact-finder.mjs — Phase 5a
// Finds hiring manager / recruiter email addresses using Snov.io API.
// Free tier: 50 credits/month — get keys at https://app.snov.io/api-setting
//
// Usage:
//   node contact-finder.mjs --domain stripe.com
//   node contact-finder.mjs --domain stripe.com --name "John Smith"
//   node contact-finder.mjs --company "Stripe" --role "Engineering Manager"
//   node contact-finder.mjs --all    # Process all companies in applications.md

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

const ROOT         = process.cwd();
const CONTACTS_FILE = join(ROOT, 'data', 'contacts.md');
const TRACKER_FILE  = join(ROOT, 'data', 'applications.md');

function log(msg)  { process.stderr.write(`[contact-finder] ${msg}\n`); }
function ok(msg)   { process.stderr.write(`✅ ${msg}\n`); }
function warn(msg) { process.stderr.write(`⚠️  ${msg}\n`); }
function die(msg)  { process.stderr.write(`❌ ${msg}\n`); process.exit(1); }

// ── Snov.io Auth ──────────────────────────────────────────────────────────────

let _snovToken = null;
let _snovTokenExpiry = 0;

async function getSnovToken() {
  const clientId     = process.env.SNOV_CLIENT_ID;
  const clientSecret = process.env.SNOV_CLIENT_SECRET;

  if (!clientId || clientId === 'your_snov_client_id_here') {
    die('SNOV_CLIENT_ID and SNOV_CLIENT_SECRET must be set in .env — get free keys at https://app.snov.io/api-setting');
  }

  if (_snovToken && Date.now() < _snovTokenExpiry) return _snovToken;

  const res = await fetch('https://api.snov.io/v1/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error(`Snov.io auth failed: ${JSON.stringify(data)}`);

  _snovToken = data.access_token;
  _snovTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000 - 60_000;
  return _snovToken;
}

// ── Snov.io API Calls ─────────────────────────────────────────────────────────

async function findEmailsByDomain(domain, firstName = '', lastName = '') {
  const token = await getSnovToken();

  // If we have a name, use the profile-search endpoint (more precise)
  if (firstName || lastName) {
    const res = await fetch('https://api.snov.io/v1/get-emails-from-names', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ domain, firstName: firstName || '', lastName: lastName || '' }),
    });
    const data = await res.json();
    return Array.isArray(data.emails) ? data.emails : [];
  }

  // Otherwise domain-level search for key people
  const res = await fetch(`https://api.snov.io/v1/get-domain-emails-with-info?domain=${encodeURIComponent(domain)}&type=all&limit=10`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json();
  return Array.isArray(data.emails) ? data.emails : [];
}

async function verifyEmail(email) {
  const token = await getSnovToken();
  const res = await fetch(`https://api.snov.io/v1/get-emails-verification-status?emails[]=${encodeURIComponent(email)}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json();
  return data?.[email]?.status || 'unknown';
}

// ── Contacts Storage ──────────────────────────────────────────────────────────

function initContactsFile() {
  if (!existsSync(CONTACTS_FILE)) {
    writeFileSync(CONTACTS_FILE, [
      '# Contacts',
      '',
      'Hiring managers and recruiters found via contact-finder.',
      '',
      '| Company | Name | Email | Role | Verified | Found |',
      '|---------|------|-------|------|----------|-------|',
      '',
    ].join('\n'), 'utf8');
  }
}

function saveContact({ company, name, email, role, verified }) {
  initContactsFile();
  let content = readFileSync(CONTACTS_FILE, 'utf8');
  const date = new Date().toISOString().split('T')[0];
  const row = `| ${company} | ${name || '—'} | ${email} | ${role || '—'} | ${verified} | ${date} |`;
  // Avoid duplicates
  if (!content.includes(email)) {
    content = content.trimEnd() + '\n' + row + '\n';
    writeFileSync(CONTACTS_FILE, content, 'utf8');
    ok(`Contact saved: ${email} (${company})`);
  }
}

// ── Domain Resolution ─────────────────────────────────────────────────────────

function guessDomain(companyName) {
  // Very basic heuristic — works for most well-known companies
  return companyName
    .toLowerCase()
    .replace(/\s+(inc\.?|corp\.?|ltd\.?|llc\.?|co\.?)$/i, '')
    .replace(/[^a-z0-9]/g, '') + '.com';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const flags = { domain: null, name: null, company: null, role: null, all: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--domain' && args[i + 1])  flags.domain  = args[++i];
    if (args[i] === '--name' && args[i + 1])    flags.name    = args[++i];
    if (args[i] === '--company' && args[i + 1]) flags.company = args[++i];
    if (args[i] === '--role' && args[i + 1])    flags.role    = args[++i];
    if (args[i] === '--all') flags.all = true;
  }

  initContactsFile();

  if (flags.all) {
    // Process all companies in applications.md
    if (!existsSync(TRACKER_FILE)) die('data/applications.md not found');
    const tracker = readFileSync(TRACKER_FILE, 'utf8');
    const companyRe = /\|\s*\d+\s*\|[^|]*\|[^|]*\|\s*([^|]+?)\s*\|/g;
    const companies = new Set();
    let m;
    while ((m = companyRe.exec(tracker)) !== null) {
      const c = m[1].trim();
      if (c && c !== 'Empresa' && c !== 'Company') companies.add(c);
    }

    log(`Found ${companies.size} companies in tracker`);
    for (const company of companies) {
      const domain = guessDomain(company);
      log(`Searching contacts for ${company} (${domain})...`);
      try {
        const emails = await findEmailsByDomain(domain);
        for (const e of emails.slice(0, 3)) {
          saveContact({ company, name: `${e.firstName || ''} ${e.lastName || ''}`.trim(), email: e.email, role: e.position, verified: e.status || 'unverified' });
        }
        if (emails.length === 0) warn(`No contacts found for ${company}`);
      } catch (err) {
        warn(`Failed for ${company}: ${err.message}`);
      }
    }
  } else {
    const domain  = flags.domain || (flags.company ? guessDomain(flags.company) : null);
    const company = flags.company || domain;

    if (!domain) {
      console.log(`
Usage:
  node contact-finder.mjs --domain stripe.com
  node contact-finder.mjs --domain stripe.com --name "John Smith"
  node contact-finder.mjs --company "Stripe" --role "Engineering Manager"
  node contact-finder.mjs --all
`);
      process.exit(1);
    }

    let [firstName, ...rest] = (flags.name || '').split(' ');
    const lastName = rest.join(' ');

    log(`Searching contacts for ${domain}...`);
    const emails = await findEmailsByDomain(domain, firstName, lastName);

    if (emails.length === 0) {
      warn('No contacts found. Try a different domain or name.');
      return;
    }

    console.log(`\n📬 Contacts found for ${domain}:\n`);
    for (const e of emails.slice(0, 5)) {
      const status = await verifyEmail(e.email);
      console.log(`  • ${e.firstName || ''} ${e.lastName || ''} — ${e.email} (${e.position || 'unknown role'}) [${status}]`);
      saveContact({ company, name: `${e.firstName || ''} ${e.lastName || ''}`.trim(), email: e.email, role: e.position || flags.role, verified: status });
    }

    console.log(`\nContacts saved to ${CONTACTS_FILE}`);
  }
}

main().catch(err => die(err.message));
