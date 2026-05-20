// @ts-check
// providers/adzuna.mjs — Phase 3
// Adzuna API provider — searches millions of real jobs across 20+ countries.
// Free tier: unlimited searches. Get keys at https://developer.adzuna.com/signup
//
// portals.yml entry format:
//
//   - name: "Adzuna Search"
//     provider: adzuna
//     keywords: "AI Engineer"        # required: search query
//     location: "London"             # optional: city/region
//     country: "gb"                  # optional: 2-letter ISO (default: us)
//     max_results: 20               # optional: jobs to fetch (default: 20, max: 50)
//     salary_min: 80000             # optional: minimum salary filter

/** @typedef {import('./_types.js').Provider} Provider */

const COUNTRY_CODES = new Set([
  'au','at','br','ca','de','fr','gb','in','it','mx','nl','nz','pl','ru','sg','us','za'
]);

/** @type {Provider} */
export default {
  id: 'adzuna',

  detect(entry) {
    if (entry.provider === 'adzuna') return { url: 'https://api.adzuna.com/v1/api/jobs' };
    return null;
  },

  async fetch(entry, ctx) {
    const appId  = process.env.ADZUNA_APP_ID;
    const apiKey = process.env.ADZUNA_API_KEY;

    if (!appId || !apiKey || appId === 'your_adzuna_app_id_here') {
      throw new Error('adzuna: ADZUNA_APP_ID and ADZUNA_API_KEY must be set in .env');
    }

    const keywords   = entry.keywords || entry.name;
    const country    = (entry.country || 'us').toLowerCase();
    const location   = entry.location || '';
    const maxResults = Math.min(Number(entry.max_results) || 20, 50);
    const salaryMin  = entry.salary_min ? Number(entry.salary_min) : null;

    if (!COUNTRY_CODES.has(country)) {
      throw new Error(`adzuna: unsupported country code "${country}". Use one of: ${[...COUNTRY_CODES].join(', ')}`);
    }

    const params = new URLSearchParams({
      app_id:   appId,
      app_key:  apiKey,
      results_per_page: String(maxResults),
      what:     keywords,
      content_type: 'application/json',
    });

    if (location) params.set('where', location);
    if (salaryMin) params.set('salary_min', String(salaryMin));
    // Always sort by date to get newest listings
    params.set('sort_by', 'date');
    // Only show jobs posted in the last 30 days
    params.set('max_days_old', '30');

    const url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params}`;
    const json = /** @type {any} */ (await ctx.fetchJson(url));

    const results = Array.isArray(json?.results) ? json.results : [];
    return results
      .filter(j => j.redirect_url && j.title)
      .map(j => ({
        title:    j.title.trim(),
        url:      j.redirect_url,
        company:  j.company?.display_name || entry.name,
        location: j.location?.display_name || location,
      }));
  },
};
