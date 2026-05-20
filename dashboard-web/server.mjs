#!/usr/bin/env node
// dashboard-web/server.mjs — Phase 8
// Local web dashboard server for JobForge.
// Reads data/applications.md and exposes a REST API + serves the web UI.
//
// Usage:
//   node dashboard-web/server.mjs
//   Then open: http://localhost:3000

import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, extname } from 'path';
import { parse as parseUrl } from 'url';
import 'dotenv/config';

const ROOT           = resolve(process.cwd());
const PUBLIC_DIR     = join(ROOT, 'dashboard-web', 'public');
const TRACKER_FILE   = join(ROOT, 'data', 'applications.md');
const PIPELINE_FILE  = join(ROOT, 'data', 'pipeline.md');
const CONTACTS_FILE  = join(ROOT, 'data', 'contacts.md');
const REPORTS_DIR    = join(ROOT, 'reports');
const ATS_LOG        = join(ROOT, 'data', 'ats-scores.json');
const INTEL_FILE     = join(ROOT, 'data', 'company-intel.json');
const REFERRALS_FILE = join(ROOT, 'data', 'referrals.md');
const PREP_DIR       = join(ROOT, 'data', 'interview-prep');
const SALARY_FILE    = join(ROOT, 'data', 'salary-bench.json');
const GAP_DIR        = join(ROOT, 'data', 'skills-gap');
const APPLY_LOG      = join(ROOT, 'data', 'linkedin-apply-log.json');

const PORT = parseInt(process.env.DASHBOARD_PORT || '3000');

// ── Tracker Parser ────────────────────────────────────────────────────────────

function parseTrackerMarkdown(content) {
  const lines = content.split('\n');
  const rows = [];

  for (const line of lines) {
    if (!line.startsWith('|') || line.includes('---')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    // Skip header row
    if (cells[0] === '#' || cells[0] === 'Nº' || isNaN(parseInt(cells[0]))) continue;

    rows.push({
      id:      cells[0] || '',
      date:    cells[1] || '',
      company: cells[2] || '',
      role:    cells[3] || '',
      score:   parseFloat(cells[4]) || null,
      status:  cells[5] || '',
      pdf:     cells[6] || '',
      report:  cells[7] || '',
    });
  }
  return rows;
}

function parseContactsMarkdown(content) {
  const lines = content.split('\n');
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith('|') || line.includes('---')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 3 || cells[0] === 'Company') continue;
    rows.push({ company: cells[0], name: cells[1], email: cells[2], role: cells[3], verified: cells[4] });
  }
  return rows;
}

// ── Stats Computation ─────────────────────────────────────────────────────────

function computeStats(jobs) {
  const statuses = {};
  let scoreSum = 0; let scoreCount = 0;
  for (const j of jobs) {
    statuses[j.status] = (statuses[j.status] || 0) + 1;
    if (j.score) { scoreSum += j.score; scoreCount++; }
  }
  return {
    total:     jobs.length,
    applied:   statuses['Aplicado'] || statuses['Applied'] || 0,
    interviews: statuses['Entrevista'] || statuses['Interview'] || 0,
    offers:    statuses['Oferta'] || statuses['Offer'] || 0,
    rejected:  statuses['Rechazada'] || statuses['Rejected'] || 0,
    avgScore:  scoreCount ? Math.round((scoreSum / scoreCount) * 10) / 10 : null,
    byStatus:  statuses,
  };
}

// ── Pipeline Capture ──────────────────────────────────────────────────────────

function addToPipeline(jobInfo) {
  if (!existsSync(join(ROOT, 'data'))) mkdirSync(join(ROOT, 'data'), { recursive: true });

  let content = existsSync(PIPELINE_FILE) ? readFileSync(PIPELINE_FILE, 'utf8') : '# Pipeline\n\n';
  const entry = `- [ ] ${jobInfo.url} | ${jobInfo.title} at ${jobInfo.company} | Added: ${new Date().toISOString().split('T')[0]}\n`;

  if (!content.includes(jobInfo.url)) {
    content += entry;
    writeFileSync(PIPELINE_FILE, content, 'utf8');
    return true;
  }
  return false; // already in pipeline
}

// ── Request Router ────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function serveStatic(res, filePath) {
  if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  const ext = extname(filePath);
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
  res.end(readFileSync(filePath));
}

async function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
  });
}

async function handleRequest(req, res) {
  const { pathname } = parseUrl(req.url);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  // ── API Routes ──────────────────────────────────────────────────────────────
  if (pathname === '/api/ping') return json(res, { ok: true });

  if (pathname === '/api/jobs') {
    const content = existsSync(TRACKER_FILE) ? readFileSync(TRACKER_FILE, 'utf8') : '';
    return json(res, parseTrackerMarkdown(content));
  }

  if (pathname === '/api/stats') {
    const content = existsSync(TRACKER_FILE) ? readFileSync(TRACKER_FILE, 'utf8') : '';
    const jobs = parseTrackerMarkdown(content);
    return json(res, computeStats(jobs));
  }

  if (pathname === '/api/contacts') {
    const content = existsSync(CONTACTS_FILE) ? readFileSync(CONTACTS_FILE, 'utf8') : '';
    return json(res, parseContactsMarkdown(content));
  }

  if (pathname === '/api/pipeline' && req.method === 'GET') {
    const content = existsSync(PIPELINE_FILE) ? readFileSync(PIPELINE_FILE, 'utf8') : '';
    return json(res, { content });
  }

  if (pathname === '/api/capture' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, { error: 'Invalid JSON body' }, 400); }
    if (!body.url) return json(res, { error: 'URL required' }, 400);
    const added = addToPipeline(body);
    const content = existsSync(PIPELINE_FILE) ? readFileSync(PIPELINE_FILE, 'utf8') : '';
    const total = (content.match(/^- \[/gm) || []).length;
    return json(res, { added, total, message: added ? 'Added to pipeline' : 'Already in pipeline' });
  }

  if (pathname.startsWith('/api/job/') && req.method === 'PATCH') {
    // Update job status: PATCH /api/job/:id { status: "Applied" }
    const id = pathname.split('/').pop();
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, { error: 'Invalid JSON body' }, 400); }
    if (!body.status) return json(res, { error: 'Status required' }, 400);

    if (!existsSync(TRACKER_FILE)) return json(res, { error: 'Tracker not found' }, 404);
    let content = readFileSync(TRACKER_FILE, 'utf8');
    const lines = content.split('\n');
    let updated = false;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('|')) {
        const cells = lines[i].split('|');
        if (cells[1]?.trim() === id) {
          cells[6] = ` ${body.status} `;
          lines[i] = cells.join('|');
          updated = true;
          break;
        }
      }
    }

    if (updated) {
      writeFileSync(TRACKER_FILE, lines.join('\n'), 'utf8');
      return json(res, { updated: true });
    }
    return json(res, { error: 'Job not found' }, 404);
  }

  // ── ATS Scores ──────────────────────────────────────────────────────────────
  if (pathname === '/api/ats') {
    const data = existsSync(ATS_LOG) ? JSON.parse(readFileSync(ATS_LOG, 'utf8')) : [];
    return json(res, data);
  }

  // ── Company Intel ────────────────────────────────────────────────────────────
  if (pathname === '/api/intel') {
    const data = existsSync(INTEL_FILE) ? JSON.parse(readFileSync(INTEL_FILE, 'utf8')) : {};
    return json(res, data);
  }

  // ── Referrals ─────────────────────────────────────────────────────────────────
  if (pathname === '/api/referrals') {
    const content = existsSync(REFERRALS_FILE) ? readFileSync(REFERRALS_FILE, 'utf8') : '';
    // Parse referrals.md into a structured list of { company, connections[] }
    const sections = [];
    let current = null;
    for (const line of content.split('\n')) {
      if (line.startsWith('## ')) {
        if (current) sections.push(current);
        current = { company: line.replace('## ', '').trim(), connections: [] };
      } else if (current && line.startsWith('|') && !line.includes('---') && !line.includes('Name')) {
        const cells = line.split('|').map(c => c.trim()).filter(Boolean);
        if (cells.length >= 2) {
          current.connections.push({ name: cells[0], position: cells[1] || '' });
        }
      }
    }
    if (current) sections.push(current);
    return json(res, sections);
  }

  // ── Salary Benchmarks ─────────────────────────────────────────────────────────
  if (pathname === '/api/salary') {
    const data = existsSync(SALARY_FILE) ? JSON.parse(readFileSync(SALARY_FILE, 'utf8')) : {};
    return json(res, data);
  }

  // ── Skills Gap ────────────────────────────────────────────────────────────────
  if (pathname === '/api/gaps') {
    const { readdirSync: rd, readFileSync: rf } = await import('fs');
    if (!existsSync(GAP_DIR)) return json(res, []);
    const sheets = rd(GAP_DIR).filter(f => f.endsWith('.md')).map(f => {
      const content = rf(join(GAP_DIR, f), 'utf8');
      const fitMatch = content.match(/Overall Fit[^:]*:\s*(?:🟢|🟡|🔴)\s*(\d+)%/);
      const critMatch = content.match(/Critical Gaps\s*\n\n(?:.*\n)*?\| \*\*(.+?)\*\*/g);
      return {
        file: f,
        path: `data/skills-gap/${f}`,
        fit: fitMatch ? parseInt(fitMatch[1]) : null,
        criticalCount: content.match(/Critical Gaps/g) ? (content.match(/^\| \*\*/gm) || []).length : 0,
      };
    });
    return json(res, sheets);
  }

  // ── LinkedIn Apply Log ────────────────────────────────────────────────────────
  if (pathname === '/api/apply-log') {
    const data = existsSync(APPLY_LOG) ? JSON.parse(readFileSync(APPLY_LOG, 'utf8')) : [];
    return json(res, data);
  }

  // ── Interview Prep List ───────────────────────────────────────────────────────
  if (pathname === '/api/prep') {
    const { readdirSync: rd } = await import('fs');
    const sheets = existsSync(PREP_DIR)
      ? rd(PREP_DIR).filter(f => f.endsWith('.md')).map(f => ({ file: f, path: `data/interview-prep/${f}` }))
      : [];
    return json(res, sheets);
  }

  // ── Static Files ────────────────────────────────────────────────────────────
  if (pathname === '/' || pathname === '/index.html') return serveStatic(res, join(PUBLIC_DIR, 'index.html'));
  const safePath = join(PUBLIC_DIR, pathname);
  if (!safePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  return serveStatic(res, safePath);
}

// ── Start Server ──────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error(`[dashboard] Error: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  });
});

server.listen(PORT, () => {
  console.log(`\n✅ JobForge Dashboard running at http://localhost:${PORT}\n`);
  console.log('   Press Ctrl+C to stop\n');
});
