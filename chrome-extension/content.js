// content.js — JobForge Chrome Extension content script
// Injected into job-related pages. Extracts job metadata and communicates
// with the popup and background service worker.

(function () {
  'use strict';

  // Extract job details from the current page DOM
  function extractJobDetails() {
    const title = (
      document.querySelector('h1')?.innerText ||
      document.querySelector('[class*="job-title"]')?.innerText ||
      document.querySelector('[class*="jobtitle"]')?.innerText ||
      document.querySelector('[class*="posting-headline"]')?.innerText ||
      document.querySelector('[data-job-title]')?.getAttribute('data-job-title') ||
      document.title
    )?.trim().replace(/\s+/g, ' ').slice(0, 120) || '';

    const company = (
      document.querySelector('[class*="company-name"]')?.innerText ||
      document.querySelector('[class*="employer-name"]')?.innerText ||
      document.querySelector('[class*="organization"]')?.innerText ||
      document.querySelector('[data-company]')?.getAttribute('data-company') ||
      ''
    )?.trim().replace(/\s+/g, ' ').slice(0, 80) || '';

    const location = (
      document.querySelector('[class*="location"]')?.innerText ||
      document.querySelector('[class*="workplace"]')?.innerText ||
      ''
    )?.trim().replace(/\s+/g, ' ').slice(0, 80) || '';

    return { title, company, location, url: window.location.href };
  }

  // Listen for messages from the popup
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_JOB_INFO') {
      sendResponse(extractJobDetails());
    }
  });

  // Badge the extension icon when on a job page
  const isJobPage = /\/(jobs?|careers?|opening|position|posting)\//i.test(window.location.pathname) ||
    document.querySelector('h1') !== null;

  if (isJobPage) {
    chrome.runtime.sendMessage({ type: 'ON_JOB_PAGE', url: window.location.href });
  }
})();
