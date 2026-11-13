// End-to-end test: loads Study Mode into a headless Firefox via WebDriver BiDi and
// checks real navigations. All web traffic goes to a dead proxy, so the test is fully
// offline and no request ever reaches a real website, blocked or not.
//
//   npm run test:e2e
//   FIREFOX_BIN=path\to\firefox.exe  SCREENSHOT_DIR=some\folder  npm run test:e2e

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXT_DIR = path.join(ROOT, 'extension');
const EXT_ID = 'study-mode@desktop.local';
const EXT_UUID = '5b1e5f43-4d0a-4c4e-9a37-1f2e3d4c5b6a';
const EXT_BASE = `moz-extension://${EXT_UUID}`;
const BLOCKED_PAGE = `${EXT_BASE}/pages/blocked.html`;
const FIREFOX = process.env.FIREFOX_BIN || 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const BIDI_PORT = Number(process.env.BIDI_PORT || 9333);
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR;

const PREFS = {
  'extensions.webextensions.uuids': JSON.stringify({ [EXT_ID]: EXT_UUID }),
  // Dead proxy for all web traffic, so the test runs fully offline; localhost is never proxied.
  'network.proxy.type': 1,
  'network.proxy.http': '127.0.0.1',
  'network.proxy.http_port': 9,
  'network.proxy.ssl': '127.0.0.1',
  'network.proxy.ssl_port': 9,
  'network.proxy.no_proxies_on': '',
  'network.dns.disablePrefetch': true,
  'network.prefetch-next': false,
  'network.http.speculative-parallel-limit': 0,
  'browser.urlbar.speculativeConnect.enabled': false,
  'browser.shell.checkDefaultBrowser': false,
  'datareporting.policy.dataSubmissionEnabled': false,
  'toolkit.telemetry.reportingpolicy.firstRun': false,
  'browser.aboutwelcome.enabled': false,
};

// ---------------------------------------------------------------------------
// Minimal WebDriver BiDi client

class Bidi {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.onEvent = () => {};
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'event') return this.onEvent(msg);
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.type === 'error') waiter.reject(new Error(`${msg.error}: ${msg.message}`));
      else waiter.resolve(msg.result);
    };
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }
}

async function connect(url) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      return await new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.onopen = () => resolve(ws);
        ws.onerror = () => reject(new Error('connect failed'));
      });
    } catch {
      await delay(300);
    }
  }
  throw new Error(`Could not reach Firefox's WebDriver BiDi server at ${url}`);
}

// ---------------------------------------------------------------------------
// Local test site (never proxied): a normal page and a single-page-app navigation.

const server = http.createServer((req, res) => {
  const page = (title, script = '') => `<!doctype html><title>${title}</title><h1>${title}</h1><script>${script}</script>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/spa') {
    res.end(page('SPA', "setTimeout(() => history.pushState({}, '', '/members/area'), 300);"));
  } else {
    res.end(page('OK page'));
  }
});

// ---------------------------------------------------------------------------

const profile = mkdtempSync(path.join(tmpdir(), 'study-mode-e2e-'));
writeFileSync(
  path.join(profile, 'user.js'),
  Object.entries(PREFS).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'),
);

// System access lets automation open and script the extension's own pages: Firefox 160+ reads it from the
// MOZ_REMOTE_ALLOW_SYSTEM_ACCESS environment variable, older versions from --remote-allow-system-access.
const firefox = spawn(FIREFOX, [
  '-headless', '-no-remote', '-wait-for-browser', '-profile', profile,
  '--remote-debugging-port', String(BIDI_PORT), '--remote-allow-system-access',
], { stdio: 'ignore', env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } });

const results = [];
const consoleErrors = [];
let bidi;
let context;

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function currentUrl() {
  const { contexts } = await bidi.send('browsingContext.getTree', { root: context, maxDepth: 0 });
  return contexts[0].url;
}

/** Navigates and returns the final URL. Proxy errors (unblocked sites) are expected and ignored. */
async function go(url) {
  try {
    await bidi.send('browsingContext.navigate', { context, url, wait: 'complete' });
  } catch {
    // Unblocked sites fail at the dead proxy; the address bar still shows where we ended up.
  }
  await delay(250);
  return currentUrl();
}

async function waitForUrl(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let url;
  while (Date.now() < deadline) {
    url = await currentUrl();
    if (predicate(url)) return url;
    await delay(150);
  }
  return url;
}

/** Runs an async function body in the current page and returns its JSON-able result. */
async function evaluate(body) {
  const expression = `(async () => { ${body} })().then((v) => JSON.stringify(v === undefined ? null : v))`;
  const result = await bidi.send('script.evaluate', { expression, target: { context }, awaitPromise: true });
  if (result.type === 'exception') throw new Error(`Page script failed: ${result.exceptionDetails.text}`);
  return JSON.parse(result.result.value);
}

async function screenshot(name) {
  if (!SCREENSHOT_DIR) return;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  // BiDi won't capture extension pages, but the extension can capture its own visible tab.
  try {
    const dataUrl = await evaluate(`return browser.tabs.captureVisibleTab(null, { format: 'png' });`);
    writeFileSync(path.join(SCREENSHOT_DIR, `${name}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
  } catch (error) {
    console.log(`      (screenshot ${name} skipped: ${error.message})`);
  }
}

async function openExtensionPage(page) {
  await go(`${EXT_BASE}/pages/${page}`);
  await delay(300);
}

async function saveSettings(patch) {
  await evaluate(`await SBSettings.saveSettings(${JSON.stringify(patch)}); return true;`);
  await delay(400); // background rebuilds its matcher
}

async function expectBlocked(url, reasonText) {
  const finalUrl = await go(url);
  assert(finalUrl.startsWith(BLOCKED_PAGE), `expected blocked page, got ${finalUrl}`);
  if (reasonText) {
    const reason = await evaluate(`await new Promise((r) => setTimeout(r, 200)); return document.getElementById('reason').textContent;`);
    assert(reason.includes(reasonText), `reason was "${reason}"`);
  }
}

async function expectNotBlocked(url) {
  const finalUrl = await go(url);
  assert(!finalUrl.startsWith(BLOCKED_PAGE), `${url} was blocked`);
  return finalUrl;
}

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const LOCAL = `http://127.0.0.1:${server.address().port}`;

  bidi = new Bidi(await connect(`ws://127.0.0.1:${BIDI_PORT}/session`));
  await bidi.send('session.new', { capabilities: {} });
  await bidi.send('session.subscribe', { events: ['log.entryAdded'] });
  bidi.onEvent = (msg) => {
    if (msg.method === 'log.entryAdded' && msg.params.level === 'error') consoleErrors.push(msg.params.text);
  };
  await bidi.send('webExtension.install', { extensionData: { type: 'path', path: EXT_DIR } });
  ({ context } = await bidi.send('browsingContext.create', { type: 'tab' }));
  await bidi.send('browsingContext.setViewport', { context, viewport: { width: 1100, height: 1400 } });

  console.log('Built-in distraction list (no network access at all)');
  await openExtensionPage('options.html');
  await check('settings page shows the packaged list and defaults', async () => {
    const info = await evaluate(`
      for (let i = 0; i < 40 && !/\\d/.test(document.getElementById('builtinCount').textContent); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return {
        main: !document.getElementById('main').hidden,
        count: Number(document.getElementById('builtinCount').textContent.replace(/\\D/g, '')),
        date: document.getElementById('builtinDate').textContent,
        toggles: Object.fromEntries([...document.querySelectorAll('[data-setting]')].map((i) => [i.dataset.setting, i.checked])) };`);
    assert(info.main, 'main section hidden');
    assert(info.count >= 30, `built-in count ${info.count}`);
    assert(/list from/.test(info.date), `date text "${info.date}"`);
    assert(Object.values(info.toggles).every(Boolean), `toggles ${JSON.stringify(info.toggles)}`);
    console.log(`      ${info.count.toLocaleString()} sites, ${info.date.trim()}`);
  });
  await screenshot('options');

  await saveSettings({ customBlock: ['example.com', '127.0.0.1/members', 'youtube.com/shorts'], allow: [] });

  console.log('Blocking');
  await check('built-in list blocks tiktok.com', () => expectBlocked('https://www.tiktok.com/', 'built-in distraction list'));
  await screenshot('blocked');
  await check('www. and subdomains are blocked', async () => {
    await expectBlocked('https://vm.tiktok.com/abc/');
    await expectBlocked('https://www.instagram.com/explore/');
  });
  await check('keyword in the address blocks a look-alike site', () => expectBlocked('https://tiktok-viewer.example/', 'blocked keyword'));
  await check('custom rule blocks example.com and subdomains', async () => {
    await expectBlocked('https://example.com/', 'your block list');
    await expectBlocked('https://sub.example.com/page');
  });
  await check('custom path rule blocks YouTube Shorts but not ordinary videos', async () => {
    await expectBlocked('https://www.youtube.com/shorts/abc123', 'your block list');
    await expectNotBlocked('https://www.youtube.com/watch?v=abc123');
  });
  await check('distraction search on Google is blocked', () => expectBlocked('https://www.google.com/search?q=tiktok+trends', 'Google'));
  await check('ordinary study site is not blocked', async () => {
    const url = await expectNotBlocked('https://en.wikipedia.org/wiki/Photosynthesis');
    assert(url === 'https://en.wikipedia.org/wiki/Photosynthesis', `URL changed to ${url}`);
  });
  await check('ordinary search is not blocked or rewritten', async () => {
    const url = await expectNotBlocked('https://www.google.com/search?q=weather');
    assert(url === 'https://www.google.com/search?q=weather', `URL changed to ${url}`);
  });
  await check('local page loads normally', async () => {
    await expectNotBlocked(`${LOCAL}/ok`);
    assert((await evaluate('return document.title;')) === 'OK page', 'title mismatch');
  });
  await check('path rule does not over-match (/membership vs /members)', () => expectNotBlocked(`${LOCAL}/membership`));
  await check('path rule blocks a single-page-app navigation (pushState)', async () => {
    await go(`${LOCAL}/spa`);
    const url = await waitForUrl((u) => u.startsWith(BLOCKED_PAGE));
    assert(url.startsWith(BLOCKED_PAGE), `stayed on ${url}`);
  });

  console.log('Exception priority rules');
  await check('an exception unblocks a listed site needed for a course', async () => {
    await openExtensionPage('options.html');
    await saveSettings({
      allow: ['twitch.tv', 'tie-test.example'],
      customBlock: ['example.com', '127.0.0.1/members', 'youtube.com/shorts', 'tie-test.example'],
    });
    await expectNotBlocked('https://www.twitch.tv/directory');
    await expectBlocked('https://www.tiktok.com/', 'built-in distraction list');
  });
  await check('your block list wins an exact tie with an exception', () => expectBlocked('https://tie-test.example/', 'your block list'));
  await openExtensionPage('options.html');
  await saveSettings({ allow: [], customBlock: ['example.com', '127.0.0.1/members', 'youtube.com/shorts'] });

  console.log('Settings changes');
  await check('protection is always on: a stored off-setting is ignored', async () => {
    await openExtensionPage('options.html');
    // There is no off switch; even an old enabled:false left in storage must not unblock.
    await saveSettings({ enabled: false });
    await expectBlocked('https://example.com/');
  });
  await check('newly blocked site is closed in already-open tabs', async () => {
    await go(`${LOCAL}/ok`);
    const optionsTab = (await bidi.send('browsingContext.create', { type: 'tab', background: true })).context;
    const testTab = context;
    context = optionsTab;
    await openExtensionPage('options.html');
    await saveSettings({ customBlock: ['example.com', '127.0.0.1/members', 'youtube.com/shorts', '127.0.0.1'] });
    await bidi.send('browsingContext.close', { context: optionsTab });
    context = testTab;
    const url = await waitForUrl((u) => u.startsWith(BLOCKED_PAGE));
    assert(url.startsWith(BLOCKED_PAGE), `tab stayed on ${url}`);
  });

  console.log('Popup and settings lock');
  const mainContext = context;
  // Viewport changes are refused on extension pages, so size a blank tab first.
  ({ context } = await bidi.send('browsingContext.create', { type: 'tab' }));
  await bidi.send('browsingContext.setViewport', { context, viewport: { width: 360, height: 440 } });
  await check('popup shows block counts and has no on/off switch', async () => {
    await openExtensionPage('popup.html');
    const info = await evaluate(`await new Promise((r) => setTimeout(r, 300)); return {
      today: document.getElementById('statToday').textContent,
      total: document.getElementById('statTotal').textContent,
      status: document.getElementById('statusText').textContent,
      hasToggle: Boolean(document.getElementById('enabledToggle')) };`);
    await screenshot('popup');
    assert(info.hasToggle === false, 'the on/off toggle should be gone');
    assert(/distraction/i.test(info.status), `status text was "${info.status}"`);
    assert(Number(info.today) >= 10, `today=${info.today}`);
    assert(Number(info.total) >= 10, `total=${info.total}`);
  });
  await bidi.send('browsingContext.close', { context });
  context = mainContext;
  await check('settings page can be locked with a password', async () => {
    await openExtensionPage('options.html');
    await evaluate(`await SBLock.set('test-password'); return true;`);
    await openExtensionPage('options.html'); // reload -> now locked
    const locked = await evaluate(`return { lock: !document.getElementById('lockScreen').hidden, main: !document.getElementById('main').hidden };`);
    assert(locked.lock && !locked.main, JSON.stringify(locked));
    await screenshot('locked');
    const unlocked = await evaluate(`
      document.getElementById('unlockPassword').value = 'test-password';
      document.getElementById('unlockForm').requestSubmit();
      await new Promise((r) => setTimeout(r, 800));
      return { lock: !document.getElementById('lockScreen').hidden, main: !document.getElementById('main').hidden };`);
    assert(!unlocked.lock && unlocked.main, JSON.stringify(unlocked));
    await evaluate(`await SBLock.set(''); return true;`);
  });

  await check('no script errors on extension pages', () => {
    assert(consoleErrors.length === 0, consoleErrors.join(' | '));
  });
} catch (error) {
  results.push({ name: 'test harness', ok: false, error });
  console.error(error);
} finally {
  server.close();
  try {
    await bidi?.send('browser.close', {}, 10000);
  } catch {
    // fall through to kill
  }
  firefox.kill();
  await delay(1500);
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(profile, { recursive: true, force: true });
      break;
    } catch {
      await delay(1000);
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
