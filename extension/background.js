/* global SBLists, SBMatcher, SBProtection, SBSettings */
'use strict';

const BLOCKED_PAGE = browser.runtime.getURL('pages/blocked.html');
const PROTECTION_ALARM = 'poll-protection';

// ---------------------------------------------------------------------------
// Built-in distraction list, read from the files packaged in extension/lists/ (no network needed).

let builtinList = null; // promise of { hosts, neverBlock, count, listDate }

function readPackagedFile(file) {
  return fetch(browser.runtime.getURL(file)).then((response) => {
    if (!response.ok) throw new Error(`Cannot read ${file}`);
    return response.text();
  });
}

function getBuiltinList() {
  if (!builtinList) {
    builtinList = SBLists.loadBuiltinList(readPackagedFile).catch((error) => {
      builtinList = null;
      throw error;
    });
  }
  return builtinList;
}

// ---------------------------------------------------------------------------
// Matching state, rebuilt whenever the settings change.

let state = null;   // { settings, matcher } once loaded
let loading = null; // in-flight load
let generation = 0; // bumped on every change so a load that raced a change is discarded

function ensureState() {
  if (state) return Promise.resolve(state);
  if (!loading) {
    const gen = generation;
    loading = loadState().then((loaded) => {
      if (gen === generation) {
        state = loaded;
        loading = null;
        updateActionIcon(blockingEnabled(loaded.settings));
      }
      return loaded;
    }, (error) => {
      if (gen === generation) loading = null;
      throw error;
    });
  }
  return loading;
}

function invalidateState() {
  generation++;
  state = null;
  loading = null;
  return ensureState();
}

async function loadState() {
  const { settings: stored } = await browser.storage.local.get('settings');
  const settings = SBSettings.withDefaults(stored);
  const lists = [];
  if (settings.useBuiltinList) lists.push({ id: 'builtin', hosts: (await getBuiltinList()).hosts });
  const matcher = SBMatcher.createMatcher({
    lists,
    customBlock: settings.customBlock,
    allow: settings.allow,
    keywords: settings.keywords,
    keywordBlocking: settings.keywordBlocking,
    searchBlocking: settings.searchBlocking,
  });
  return { settings, matcher };
}

function updateActionIcon(enabled) {
  browser.action.setIcon({ path: enabled ? '/icons/shield.svg' : '/icons/shield-off.svg' }).catch(() => {});
  browser.action.setTitle({ title: enabled ? 'Study Mode: blocking distractions' : 'Study Mode: paused' }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Request blocking. Listeners answer synchronously once the state is loaded.

function onBeforeRequest(details) {
  if (state) return decideRequest(state, details);
  return ensureState().then((loaded) => decideRequest(loaded, details), () => ({}));
}

/**
 * Whether blocking is on right now. Study Mode is always on and has no in-extension off
 * switch. The optional protection service, when present, is the one thing that can pause or
 * remove it (behind its waiting period); otherwise blocking is unconditionally on.
 */
function blockingEnabled(_settings) {
  const override = SBProtection.blockingOverride();
  return override === null ? true : override;
}

function decideRequest({ settings, matcher }, details) {
  if (!blockingEnabled(settings)) return {};
  const mainFrame = details.type === 'main_frame';
  const verdict = matcher.check(details.url, { mainFrame });
  if (!verdict) return {};
  if (!mainFrame) return { cancel: true };
  noteBlock(details.tabId, verdict);
  return { redirectUrl: BLOCKED_PAGE };
}

browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls: ['<all_urls>'] }, ['blocking']);

// Single-page apps (YouTube, Reddit, X) change the address without loading a new page.
browser.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const { settings, matcher } = await ensureState();
  if (!blockingEnabled(settings)) return;
  const verdict = matcher.check(details.url, { mainFrame: true });
  if (verdict) blockTab(details.tabId, verdict);
}, { url: [{ schemes: ['http', 'https'] }] });

// ---------------------------------------------------------------------------
// Block bookkeeping: what the blocked page shows, and the counters in the popup.

const blockInfo = new Map(); // tabId -> verdict
let statsQueue = Promise.resolve();

function noteBlock(tabId, verdict) {
  const info = { ...verdict, time: Date.now() };
  if (tabId >= 0) {
    blockInfo.set(tabId, info);
    browser.storage.session.set({ [`block:${tabId}`]: info }).catch(() => {});
  }
  statsQueue = statsQueue.then(bumpStats).catch(() => {});
}

async function bumpStats() {
  const { stats } = await browser.storage.local.get('stats');
  const day = SBSettings.localDay();
  const next = {
    total: ((stats && stats.total) || 0) + 1,
    today: (stats && stats.day === day ? stats.today : 0) + 1,
    day,
  };
  await browser.storage.local.set({ stats: next });
}

function blockTab(tabId, verdict) {
  noteBlock(tabId, verdict);
  return browser.tabs.update(tabId, { url: BLOCKED_PAGE, loadReplace: true }).catch(() => {});
}

/** Sends tabs that are already open on a now-blocked site to the blocked page. */
async function enforceOpenTabs() {
  const { settings, matcher } = await ensureState();
  if (!blockingEnabled(settings)) return;
  for (const tab of await browser.tabs.query({})) {
    const verdict = tab.url ? matcher.check(tab.url, { mainFrame: true }) : null;
    if (verdict) blockTab(tab.id, verdict);
  }
}

async function getBlockInfo(tabId) {
  if (blockInfo.has(tabId)) return blockInfo.get(tabId);
  const key = `block:${tabId}`;
  const stored = await browser.storage.session.get(key);
  return stored[key] || null;
}

browser.tabs.onRemoved.addListener((tabId) => {
  blockInfo.delete(tabId);
  browser.storage.session.remove(`block:${tabId}`).catch(() => {});
});

// ---------------------------------------------------------------------------
// Optional protection service: follow its on/off decision when it is installed.

// When the service's status changes, re-apply blocking to open tabs and update the icon.
SBProtection.onChange(() => {
  if (state) updateActionIcon(blockingEnabled(state.settings));
  enforceOpenTabs().catch(() => {});
});

async function scheduleProtectionPolling() {
  if (!(await browser.alarms.get(PROTECTION_ALARM))) browser.alarms.create(PROTECTION_ALARM, { periodInMinutes: 0.5 });
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PROTECTION_ALARM) SBProtection.poll();
});

// ---------------------------------------------------------------------------
// Lifecycle, storage changes and messages from the extension pages

function startup() {
  scheduleProtectionPolling();
  SBProtection.poll().finally(enforceOpenTabs);
}

browser.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') browser.tabs.create({ url: browser.runtime.getURL('pages/options.html#welcome') });
  startup();
});
browser.runtime.onStartup.addListener(startup);

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  invalidateState().then(enforceOpenTabs).catch(() => {});
});

browser.runtime.onMessage.addListener((message, sender) => {
  switch (message && message.type) {
    case 'getBlockInfo':
      return getBlockInfo(sender.tab ? sender.tab.id : -1);
    case 'checkUrl':
      return ensureState().then(({ matcher }) => matcher.check(message.url, { mainFrame: true }));
    case 'getListInfo':
      return getBuiltinList().then(({ count, listDate }) => ({ count, listDate }));
    case 'getProtection':
      // The popup asks on open: poll fresh, then hand back the service's state.
      return SBProtection.poll();
    default:
      return undefined;
  }
});

ensureState();
