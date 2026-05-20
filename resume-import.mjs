#!/usr/bin/env node
// resume-import.mjs — Phase 2
// Imports a PDF resume and converts it into the JobForge cv.md format using Gemini.
//
// Usage:
//   node resume-import.mjs path/to/resume.pdf
//   node resume-import.mjs path/to/resume.pdf --output cv.md   (default output)
//   node resume-import.mjs path/to/resume.pdf --preview        (print without saving)
//
// Requirements: GEMINI_API_KEY in .env

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { resolve, extname, basename } from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg)  { process.stderr.write(`[resume-import] ${msg}\n`); }
function ok(msg)   { process.stderr.write(`✅ ${msg}\n`); }
function warn(msg) { process.stderr.write(`⚠️  ${msg}\n`); }
function die(msg)  { process.stderr.write(`❌ ${msg}\n`); process.exit(1); }

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = { preview: false, output: 'cv.md', help: false };
  let pdfPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--preview') flags.preview = true;
    else if (args[i] === '--help' || args[i] === '-h') flags.help = true;
    else if (args[i] === '--output' && args[i + 1]) { flags.output = args[++i]; }
    else if (!args[i].startsWith('--')) pdfPath = args[i];
  }
  return { pdfPath, ...flags };
}

function printHelp() {
  console.log(`
resume-import — Convert a PDF resume into JobForge cv.md format

Usage:
  node resume-import.mjs <path/to/resume.pdf> [options]

Options:
  --output <file>   Output file path (default: cv.md)
  --preview         Print generated cv.md to stdout without saving
  --help            Show this help message

Examples:
  node resume-import.mjs resume.pdf
  node resume-import.mjs ~/Downloads/my-resume.pdf --output cv.md
  node resume-import.mjs resume.pdf --preview
`);
}

// ── PDF Extraction via Playwright ─────────────────────────────────────────────

async function extractTextFromPDF(pdfPath) {
  log(`Extracting text from PDF: ${basename(pdfPath)}`);

  // Try Playwright first (most reliable for formatted PDFs)
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    const fileUrl = `file://${resolve(pdfPath)}`;
    await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 30_000 });

    // Give the PDF viewer a moment to render
    await page.waitForTimeout(2000);

    // Extract all visible text content
    const text = await page.evaluate(() => document.body?.innerText || document.documentElement?.innerText || '');
    await browser.close();

    if (text && text.trim().length > 100) {
      ok(`Extracted ${text.length} characters via Playwright`);
      return text;
    }
    warn('Playwright extracted minimal text — falling back to base64 method');
  } catch (err) {
    warn(`Playwright extraction failed: ${err.message} — falling back to base64`);
  }

  // Fallback: send PDF bytes directly to Gemini (supports inline PDFs)
  log('Using Gemini native PDF understanding (inline bytes)');
  return null; // signal to use inline PDF mode
}

// ── Gemini Conversion ─────────────────────────────────────────────────────────

const CV_MD_SYSTEM_PROMPT = `You are a precise resume parser. Convert the provided resume into a structured Markdown file following this exact format. Extract ALL information — do not omit or summarize anything.

Output ONLY the Markdown content — no explanation, no preamble, no code fences.

# [Full Name]

**[Professional Headline — 1 sentence, punchy, your positioning statement]**

📧 [email] | 📱 [phone] | 🌍 [location] | [linkedin_url] | [portfolio_url] | [github_url]

---

## Professional Summary

[2-4 sentences. First person. Highlights seniority, specialization, key achievements, and what you're optimizing for next. Include 1 quantified result if available.]

---

## Core Competencies

[List of 12-16 skills as a comma-separated inline list or a 3-column grid using bullet points. Group related skills.]

---

## Professional Experience

### [Job Title] — [Company Name]
**[Start Month Year] – [End Month Year or Present]** | [Location or Remote]

[1-sentence company context if not well-known: what they do, size, stage]

- [Achievement bullet — lead with a strong verb, include metric where possible]
- [Achievement bullet]
- [Achievement bullet]
- [Achievement bullet]
[3-6 bullets per role. Focus on impact, not just responsibilities.]

[Repeat for each role, newest first]

---

## Education

### [Degree] in [Field] — [University Name]
**[Year]** | [Location]

[Optional: GPA if strong, thesis if relevant, honors]

[Repeat for each degree]

---

## Projects & Open Source

### [Project Name]
[URL if available]
[1-2 sentences: what it is, tech stack, impact/stars/users]

---

## Certifications & Awards
- [Certification/Award — Issuing org — Year]

---

## Languages
- [Language]: [Native/Fluent/Professional]

---

*Note: Omit sections that have no content. Keep ALL details — do not truncate or summarize experience descriptions.*`;

async function convertWithGemini(text, pdfPath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    die('GEMINI_API_KEY not set in .env — get a free key at https://aistudio.google.com/apikey');
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const model = genAI.getGenerativeModel({ model: modelName });

  log(`Calling Gemini (${modelName}) to structure resume...`);

  let result;

  if (text) {
    // Text mode: extracted text → Gemini
    result = await model.generateContent([
      { text: CV_MD_SYSTEM_PROMPT },
      { text: `\n\n---\nRESUME TEXT:\n---\n\n${text}` },
    ]);
  } else {
    // Inline PDF mode: send raw PDF bytes to Gemini
    const pdfBytes = readFileSync(pdfPath);
    const base64 = pdfBytes.toString('base64');
    result = await model.generateContent([
      { text: CV_MD_SYSTEM_PROMPT },
      {
        inlineData: {
          mimeType: 'application/pdf',
          data: base64,
        },
      },
    ]);
  }

  const cvMd = result.response.text().trim();
  if (!cvMd || cvMd.length < 200) {
    die('Gemini returned an empty or too-short response. Check your API key and try again.');
  }

  return cvMd;
}

// ── Save with Backup ──────────────────────────────────────────────────────────

function saveWithBackup(outputPath, content) {
  if (existsSync(outputPath)) {
    const backupPath = `${outputPath}.backup-${Date.now()}`;
    copyFileSync(outputPath, backupPath);
    warn(`Existing ${outputPath} backed up → ${backupPath}`);
  }
  writeFileSync(outputPath, content, 'utf8');
  ok(`Saved to ${outputPath}`);
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateOutput(cvMd) {
  const checks = [
    { label: 'Has name heading',         pass: /^#\s+\S/.test(cvMd) },
    { label: 'Has Professional Summary', pass: /##\s+Professional Summary/i.test(cvMd) },
    { label: 'Has Experience section',   pass: /##\s+Professional Experience/i.test(cvMd) },
    { label: 'Has bullet points',        pass: /^-\s+/m.test(cvMd) },
    { label: 'Has sufficient length',    pass: cvMd.length > 500 },
  ];

  const failures = checks.filter(c => !c.pass);
  if (failures.length > 0) {
    warn('Validation warnings (cv.md may be incomplete):');
    failures.forEach(f => warn(`  • ${f.label}`));
  } else {
    ok('Output validation passed — cv.md looks well-structured');
  }
  return failures.length === 0;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { pdfPath, preview, output, help } = parseArgs(process.argv);

  if (help || !pdfPath) {
    printHelp();
    process.exit(pdfPath ? 0 : 1);
  }

  const absPath = resolve(pdfPath);

  if (!existsSync(absPath)) die(`File not found: ${absPath}`);
  if (extname(absPath).toLowerCase() !== '.pdf') die(`Expected a .pdf file, got: ${extname(absPath)}`);

  // Step 1: Extract text from PDF
  const text = await extractTextFromPDF(absPath);

  // Step 2: Convert with Gemini
  const cvMd = await convertWithGemini(text, absPath);

  // Step 3: Validate
  validateOutput(cvMd);

  // Step 4: Output
  if (preview) {
    console.log('\n' + '─'.repeat(60));
    console.log(cvMd);
    console.log('─'.repeat(60));
    console.log('\n(Preview mode — not saved. Remove --preview to save.)');
  } else {
    saveWithBackup(output, cvMd);
    console.log('\n✅ Resume imported successfully!');
    console.log(`\nNext steps:`);
    console.log(`  1. Review and edit ${output} to fine-tune the output`);
    console.log(`  2. Fill in config/profile.yml with your preferences`);
    console.log(`  3. Run: node scan.mjs to start discovering jobs`);
  }
}

main().catch(err => die(err?.message || String(err)));
