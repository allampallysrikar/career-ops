// @ts-check
// providers/linkedin.mjs — Phase 3
// LinkedIn Jobs provider via Playwright — uses your logged-in Chrome session.
//
// ⚠️  IMPORTANT: LinkedIn's Terms of Service prohibit automated scraping.
//     This provider is provided for personal/research use only. Use responsibly:
//     - Set delays between requests (built-in 2-5s random delay)
//     - Do not run in bulk / at high frequency
//     - This is for your own job search, not commercial data collection
//
// portals.yml entry format:
//
//   - name: "LinkedIn: AI Jobs"
//     provider: linkedin
//     keywords: "AI Engineer"         # required: search query
//     location: "San Francisco"       # optional: city/region
//     remote: true                    # optional: filter to remote only
//     experience: "4"                 # optional: 1=Intern, 2=Entry, 3=Associate, 4=Mid-Senior, 5=Director, 6=Executive
//     max_results: 15                 # optional: jobs to fetch (default: 15, max: 25)
//
// LinkedIn session: The provider uses Playwright with a persistent profile.
// On first run it will open a browser for you to log in. After that,
// the session is saved to ~/.JobForge/linkedin-profile/ automatically.

/** @typedef {import('./_types.js').Provider} Provider */

import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';

const SESSION_DIR = join(homedir(), '.JobForge', 'linkedin-profile');
const LINKEDIN_BASE = 'https://www.linkedin.com';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay(minMs = 2000, maxMs = 5000) {
  return sleep(Math.floor(Math.random() * (maxMs - minMs)) + minMs);
}

/** @type {Provider} */
export default {
  id: 'linkedin',

  detect(entry) {
    if (entry.provider === 'linkedin') return { url: LINKEDIN_BASE + '/jobs' };
    return null;
  },

  async fetch(entry, _ctx) {
    // LinkedIn requires a real browser session — Playwright handles this
    const { chromium } = await import('playwright');

    const keywords   = entry.keywords || entry.name;
    const location   = entry.location || '';
    const remote     = entry.remote === true;
    const experience = entry.experience ? String(entry.experience) : '';
    const maxResults = Math.min(Number(entry.max_results) || 15, 25);

    // Ensure session directory exists
    if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });

    // Launch with persistent context to reuse login session
    const browser = await chromium.launchPersistentContext(SESSION_DIR, {
      headless: false, // LinkedIn detects headless — must run headed
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = browser.pages()[0] || await browser.newPage();

    try {
      // Check if we need to log in
      await page.goto(LINKEDIN_BASE, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await sleep(1000);

      const isLoggedIn = await page.$('[data-control-name="identity_profile_photo"], .global-nav__me-photo, .nav-item__profile-member-photo') !== null;

      if (!isLoggedIn) {
        process.stderr.write(`\n🔐 [linkedin] Please log in to LinkedIn in the browser window, then press ENTER here...\n`);
        await page.goto(`${LINKEDIN_BASE}/login`, { waitUntil: 'domcontentloaded' });
        // Wait for user to log in manually
        await new Promise(resolve => {
          process.stdin.once('data', resolve);
          process.stderr.write('Waiting for login confirmation... (press ENTER after you have logged in)\n');
        });
      }

      // Build LinkedIn jobs search URL
      const searchParams = new URLSearchParams({
        keywords,
        f_TPR: 'r2592000', // Last 30 days
        sortBy: 'DD',       // Sort by date
      });

      if (location) searchParams.set('location', location);
      if (remote) searchParams.set('f_WT', '2'); // Remote work type
      if (experience) searchParams.set('f_E', experience); // Experience level

      const searchUrl = `${LINKEDIN_BASE}/jobs/search?${searchParams}`;
      process.stderr.write(`[linkedin] Searching: ${searchUrl}\n`);

      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await randomDelay(2000, 4000);

      // Scroll to load more results
      const jobs = [];
      let attempts = 0;
      const maxAttempts = Math.ceil(maxResults / 5);

      while (jobs.length < maxResults && attempts < maxAttempts) {
        // Extract visible job cards
        const cards = await page.$$eval(
          'li.jobs-search-results__list-item, .job-card-container',
          (els) => els.map(el => {
            const titleEl = el.querySelector('.job-card-list__title, .job-card-container__link, h3 a');
            const companyEl = el.querySelector('.job-card-container__primary-description, .job-card-container__company-name');
            const locationEl = el.querySelector('.job-card-container__metadata-item, .job-card-container__secondary-description');
            const linkEl = el.querySelector('a[href*="/jobs/view/"]');

            const title = titleEl?.textContent?.trim() || '';
            const company = companyEl?.textContent?.trim() || '';
            const location = locationEl?.textContent?.trim() || '';
            const href = linkEl?.getAttribute('href') || '';
            const url = href.startsWith('http') ? href : 'https://www.linkedin.com' + href.split('?')[0];

            return { title, company, location, url };
          })
        );

        // Deduplicate by URL
        for (const card of cards) {
          if (card.title && card.url && !jobs.find(j => j.url === card.url)) {
            jobs.push(card);
          }
        }

        if (jobs.length >= maxResults) break;

        // Scroll down to load more
        await page.evaluate(() => window.scrollBy(0, 600));
        await randomDelay(1500, 3000);
        attempts++;
      }

      process.stderr.write(`[linkedin] Found ${jobs.length} jobs\n`);
      return jobs.slice(0, maxResults);

    } finally {
      await browser.close();
    }
  },
};
