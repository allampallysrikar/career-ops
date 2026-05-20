// background.js — JobForge Chrome Extension service worker

// Badge the icon when on a job-related page
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  const jobPatterns = ['/jobs/', '/careers/', '/job/', '/opening/', '/position/', 'linkedin.com/jobs', 'greenhouse.io', 'lever.co', 'ashbyhq.com'];
  const isJobPage = jobPatterns.some(p => tab.url.includes(p));
  if (isJobPage) {
    chrome.action.setBadgeText({ text: '⚡', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#6366f1', tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
});

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, _sender) => {
  if (message.type === 'ON_JOB_PAGE') {
    // Content script detected a job page — could update badge or storage here
    return;
  }

  if (message.type === 'JOB_CAPTURED') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'JobForge — Job Captured!',
      message: `"${message.title}" has been added to your pipeline for AI evaluation.`,
    });
  }
});
