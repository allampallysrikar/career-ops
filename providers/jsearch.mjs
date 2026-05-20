// @ts-check
// providers/jsearch.mjs — Phase 3
// JSearch provider via RapidAPI — aggregates LinkedIn, Indeed, Glassdoor and more.
// Free tier: 200 requests/month. Get key at https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
//
// portals.yml entry format:
//
//   - name: "JSearch: AI Jobs"
//     provider: jsearch
//     keywords: "AI Engineer"           # required: search query
//     location: "New York"              # optional: city/region/remote
//     employment_type: "FULLTIME"       # optional: FULLTIME|PARTTIME|CONTRACTOR|INTERN
//     remote_only: true                 # optional: only remote jobs
//     max_results: 10                  # optional: jobs to fetch (default: 10, max: 20)

/** @typedef {import('./_types.js').Provider} Provider */

/** @type {Provider} */
export default {
  id: 'jsearch',

  detect(entry) {
    if (entry.provider === 'jsearch') return { url: 'https://jsearch.p.rapidapi.com/search' };
    return null;
  },

  async fetch(entry, ctx) {
    const apiKey = process.env.JSEARCH_API_KEY;
    if (!apiKey || apiKey === 'your_rapidapi_key_here') {
      throw new Error('jsearch: JSEARCH_API_KEY must be set in .env — get a free key at https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch');
    }

    const keywords      = entry.keywords || entry.name;
    const location      = entry.location || '';
    const maxResults    = Math.min(Number(entry.max_results) || 10, 20);
    const remoteOnly    = entry.remote_only === true;
    const employmentType = entry.employment_type || '';

    // Build query string — JSearch supports "keyword in location" format
    const query = location ? `${keywords} in ${location}` : keywords;

    const params = new URLSearchParams({
      query,
      page:       '1',
      num_pages:  '1',
      date_posted: 'month',
    });

    if (remoteOnly) params.set('remote_jobs_only', 'true');
    if (employmentType) params.set('employment_types', employmentType);

    const url = `https://jsearch.p.rapidapi.com/search?${params}`;
    const json = /** @type {any} */ (await ctx.fetchJson(url, {
      headers: {
        'X-RapidAPI-Key':  apiKey,
        'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
      },
    }));

    if (json?.status === 'ERROR') {
      throw new Error(`jsearch: API error — ${json?.error || 'unknown error'}`);
    }

    const data = Array.isArray(json?.data) ? json.data : [];
    return data
      .slice(0, maxResults)
      .filter(j => j.job_apply_link && j.job_title)
      .map(j => ({
        title:    j.job_title.trim(),
        url:      j.job_apply_link,
        company:  j.employer_name || '',
        location: j.job_city
          ? `${j.job_city}${j.job_state ? ', ' + j.job_state : ''}${j.job_is_remote ? ' (Remote)' : ''}`
          : j.job_is_remote ? 'Remote' : '',
      }));
  },
};
