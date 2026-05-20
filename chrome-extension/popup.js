// popup.js — career-ops Chrome Extension

const DASHBOARD_URL = 'http://localhost:3000';

const $ = id => document.getElementById(id);

async function checkServerAlive() {
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/ping`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function loadStats() {
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/stats`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return;
    const stats = await res.json();
    $('statCaptured').textContent = stats.total || '0';
    $('statApplied').textContent  = stats.applied || '0';
    $('statScore').textContent    = stats.avgScore ? stats.avgScore.toFixed(1) : '—';
  } catch {}
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function extractJobInfo(tab) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // Try to extract job details from the page
        const title = (
          document.querySelector('h1')?.innerText ||
          document.querySelector('[class*="job-title"]')?.innerText ||
          document.querySelector('[class*="jobtitle"]')?.innerText ||
          document.querySelector('[data-job-title]')?.getAttribute('data-job-title') ||
          document.title
        )?.trim().slice(0, 100);

        const company = (
          document.querySelector('[class*="company-name"]')?.innerText ||
          document.querySelector('[class*="employer"]')?.innerText ||
          document.querySelector('[data-company]')?.getAttribute('data-company') ||
          ''
        )?.trim().slice(0, 60);

        return { title, company, url: location.href };
      },
    });
    return results?.[0]?.result || { title: tab.title, company: '', url: tab.url };
  } catch {
    return { title: tab.title, company: '', url: tab.url };
  }
}

function setStatus(type, msg) {
  const el = $('status');
  el.className = `status ${type}`;
  el.textContent = msg;
  el.style.display = 'block';
}

async function captureJob(jobInfo) {
  setStatus('loading', '⏳ Sending to career-ops pipeline...');
  $('captureBtn').disabled = true;

  try {
    const res = await fetch(`${DASHBOARD_URL}/api/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jobInfo),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error(err.message);
    }

    const result = await res.json();
    setStatus('success', `✅ Added to pipeline! (${result.total || '?'} total)`);

    // Update captured count
    const current = parseInt($('statCaptured').textContent) || 0;
    $('statCaptured').textContent = current + 1;

    // Save to extension storage
    const { capturedJobs = [] } = await chrome.storage.local.get('capturedJobs');
    capturedJobs.unshift({ ...jobInfo, capturedAt: Date.now() });
    await chrome.storage.local.set({ capturedJobs: capturedJobs.slice(0, 200) });

    // Notify background to show desktop notification
    chrome.runtime.sendMessage({ type: 'JOB_CAPTURED', title: jobInfo.title });

  } catch (err) {
    setStatus('error', `❌ ${err.message}`);
    $('captureBtn').disabled = false;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const tab = await getCurrentTab();

  // Check if dashboard server is running
  const serverAlive = await checkServerAlive();
  if (!serverAlive) {
    $('serverWarning').style.display = 'block';
    $('captureBtn').disabled = true;
    $('jobTitle').textContent = 'Dashboard server not running';
    $('jobCompany').textContent = '';
    return;
  }

  // Load dashboard link
  $('dashboardLink').href = DASHBOARD_URL;
  $('dashboardLink').addEventListener('click', e => {
    e.preventDefault();
    chrome.tabs.create({ url: DASHBOARD_URL });
  });

  // Extract job info from current page
  const jobInfo = await extractJobInfo(tab);

  $('jobTitle').textContent   = jobInfo.title || 'Unknown job title';
  $('jobCompany').textContent = jobInfo.company || 'Unknown company';
  $('jobUrl').textContent     = jobInfo.url;

  // Enable capture button if we have a URL
  if (jobInfo.url) {
    $('captureBtn').disabled = false;
    $('captureBtn').addEventListener('click', () => captureJob(jobInfo));
  }

  // Load stats from dashboard
  await loadStats();
}

init();
