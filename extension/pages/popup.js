/* global SBMatcher, SBSettings, SBWarnings */
'use strict';

const $ = (id) => document.getElementById(id);
const BLOCKED_PAGE = browser.runtime.getURL('pages/blocked.html');

let activeTab = null;
let blocking = true;   // is blocking currently in effect (for display only)
let managed = false;   // the Windows protection service is in charge

function formatDuration(seconds) {
  seconds = Math.max(0, Math.round(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function init() {
  [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  const protection = await browser.runtime.sendMessage({ type: 'getProtection' }).catch(() => null);
  managed = Boolean(protection && protection.available);
  if (managed) {
    blocking = protection.status.blocking;
    renderManaged(protection.status);
  } else {
    // Protection is always on; there is no off switch in the extension.
    blocking = true;
    renderOn();
  }
  await Promise.all([renderSite(), renderStats(), SBWarnings.render($('warnings'))]);
}

function renderOn() {
  $('statusText').textContent = 'Blocking distractions';
  $('logo').src = '../icons/shield.svg';
}

/** When the service manages Firefox, the popup shows status (and a countdown) from it. */
function renderManaged(status) {
  $('managedCard').hidden = false;
  document.body.classList.toggle('off', !status.blocking);
  $('logo').src = status.blocking ? '../icons/shield.svg' : '../icons/shield-off.svg';

  const waiting = status.requestStatus === 'waiting';
  $('managedCountdownLabel').hidden = !waiting;
  $('managedCountdown').hidden = !waiting;
  if (waiting) $('managedCountdown').textContent = formatDuration(status.remainingSeconds);

  let detail;
  if (status.status === 'active' && waiting) detail = 'Protection is on. A request to turn it off is counting down.';
  else if (status.status === 'active' && status.requestStatus === 'ready') detail = 'Protection is on. The waiting period is over - use the app to pause or turn it off.';
  else if (status.status === 'active') detail = 'Protection is on.';
  else if (status.status === 'paused') detail = `Protection is paused. It turns back on in ${formatDuration(status.pauseRemainingSeconds)}.`;
  else detail = 'Protection is turned off.';
  $('statusText').textContent = status.blocking ? 'Managed - protection on' : 'Managed - protection off';
  $('managedDetail').textContent = detail;

  const problems = (status.problems || []).concat(status.integrityOk === false && !status.problems.length
    ? ['Protection cannot be fully verified right now.'] : []);
  $('managedVerify').hidden = problems.length === 0;
  $('managedVerify').textContent = problems.join(' ');
}

function siteUrl() {
  try {
    const url = new URL(activeTab && activeTab.url);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

async function renderSite() {
  const host = $('siteHost');
  const status = $('siteState');
  $('blockSiteBtn').hidden = true;
  status.classList.remove('blocked');

  if (activeTab && activeTab.url && activeTab.url.startsWith(BLOCKED_PAGE)) {
    host.textContent = 'Blocked page';
    status.textContent = 'Study Mode stopped this page from loading.';
    return;
  }
  const url = siteUrl();
  if (!url) {
    host.textContent = 'No website open';
    status.textContent = 'Open a website to block it from here.';
    return;
  }
  host.textContent = url.hostname;
  const verdict = await browser.runtime.sendMessage({ type: 'checkUrl', url: url.href });
  if (verdict) {
    status.textContent = blocking ? 'Blocked' : 'Would be blocked (protection is off)';
    status.classList.add('blocked');
  } else {
    status.textContent = 'Not blocked';
    $('blockSiteBtn').hidden = false;
  }
}

async function renderStats() {
  const { stats } = await browser.storage.local.get('stats');
  const today = stats && stats.day === SBSettings.localDay() ? stats.today : 0;
  $('statToday').textContent = today.toLocaleString();
  $('statTotal').textContent = ((stats && stats.total) || 0).toLocaleString();
}

$('blockSiteBtn').addEventListener('click', async () => {
  const host = SBMatcher.normalizeHost(siteUrl().hostname);
  const settings = await SBSettings.getSettings();
  if (!settings.customBlock.includes(host)) {
    await SBSettings.saveSettings({ customBlock: [...settings.customBlock, host] });
  }
  // The background script moves open tabs on this site to the blocked page.
  $('blockSiteBtn').hidden = true;
  $('siteState').textContent = blocking ? 'Added to your block list' : 'Added to your block list (protection is off)';
  $('siteState').classList.add('blocked');
});

$('openProtectionApp').addEventListener('click', () => {
  // The extension can't launch a Windows app; point the user to it.
  $('openProtectionApp').textContent = 'Open "Study Mode Protection" from the Windows Start menu.';
});

$('openOptions').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

init();
