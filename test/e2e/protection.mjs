// End-to-end test of the extension <-> protection-service link.
//
// Registers a fake native-messaging host (HKCU, no admin) whose reply the test controls via
// a status file, launches headless Firefox with the extension, and checks that the extension
// follows the service: blocks when it says active, stops when it says removed, fails safe
// when the service looks unhealthy, and shows the countdown in the popup.
//
//   npm run test:e2e:protection

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Bidi, connect, launchFirefox, cleanupProfile, EXT_ID, EXT_BASE } from './bidi.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_NAME = 'com.studymode.protection';
const REG_KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;
const BLOCKED_PAGE = `${EXT_BASE}/pages/blocked.html`;
const PORT = Number(process.env.BIDI_PORT || 9335);

const work = mkdtempSync(path.join(tmpdir(), 'sb-host-'));
const statusPath = path.join(work, 'status.json');
const manifestPath = path.join(work, 'manifest.json');
const batPath = path.join(work, 'host.bat');

function setStatus(status) {
  writeFileSync(statusPath, JSON.stringify({ type: 'status', ...status }));
}

const ACTIVE = { blocking: true, status: 'active', requestStatus: null, remainingSeconds: null,
  pauseRemainingSeconds: null, requiredSeconds: 9600, serviceAlive: true, integrityOk: true, problems: [], warnings: [] };

const results = [];
const consoleErrors = [];
let bidi; let context; let proc; let profile; let registered = false;

async function check(name, fn) {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`); }
  catch (e) { results.push(false); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

async function currentUrl() {
  const { contexts } = await bidi.send('browsingContext.getTree', { root: context, maxDepth: 0 });
  return contexts[0].url;
}
async function go(url) {
  try { await bidi.send('browsingContext.navigate', { context, url, wait: 'complete' }); } catch { /* proxy dead-end */ }
  await delay(250);
  return currentUrl();
}
async function evaluate(body) {
  const expression = `(async () => { ${body} })().then((v) => JSON.stringify(v === undefined ? null : v))`;
  const r = await bidi.send('script.evaluate', { expression, target: { context }, awaitPromise: true });
  if (r.type === 'exception') throw new Error(r.exceptionDetails.text);
  return JSON.parse(r.result.value);
}
async function openExt(page) { await go(`${EXT_BASE}/pages/${page}`); await delay(200); }

/** Push a new status, then force the background to poll it (the popup asks on open). */
async function applyStatus(status) {
  setStatus(status);
  await openExt('options.html');
  const polled = await evaluate(`return await browser.runtime.sendMessage({ type: 'getProtection' });`);
  await delay(300); // let onChange -> enforceOpenTabs settle
  return polled;
}

try {
  setStatus(ACTIVE);
  writeFileSync(manifestPath, JSON.stringify({
    name: HOST_NAME,
    description: 'Fake Study Mode protection host (test)',
    path: batPath,
    type: 'stdio',
    allowed_extensions: [EXT_ID],
  }));
  // Relies on python being on PATH in Firefox's environment, as elsewhere in these tests.
  writeFileSync(batPath, `@echo off\r\npython "${path.join(HERE, 'fake-host', 'responder.py')}" "${statusPath}"\r\n`);
  execFileSync('reg', ['add', REG_KEY, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'ignore' });
  registered = true;

  ({ proc, profile } = launchFirefox(PORT));
  bidi = new Bidi(await connect(`ws://127.0.0.1:${PORT}/session`));
  await bidi.send('session.new', { capabilities: {} });
  await bidi.send('session.subscribe', { events: ['log.entryAdded'] });
  bidi.onEvent = (m) => { if (m.method === 'log.entryAdded' && m.params.level === 'error') consoleErrors.push(m.params.text); };
  await bidi.send('webExtension.install', { extensionData: { type: 'path', path: path.join(HERE, '..', '..', 'extension') } });
  ({ context } = await bidi.send('browsingContext.create', { type: 'tab' }));

  console.log('Extension follows the protection service');
  await check('the native host is reachable and reports managed', async () => {
    const polled = await applyStatus(ACTIVE);
    assert(polled && polled.available === true, `not managed: ${JSON.stringify(polled)}`);
    assert(polled.status.status === 'active', 'status not active');
  });
  await check('service says active -> distracting site is blocked', async () => {
    const url = await go('https://www.tiktok.com/');
    assert(url.startsWith(BLOCKED_PAGE), `expected blocked page, got ${url}`);
  });
  await check('service says removed -> the same site is not blocked', async () => {
    await applyStatus({ ...ACTIVE, blocking: false, status: 'removed' });
    const url = await go('https://www.tiktok.com/');
    assert(!url.startsWith(BLOCKED_PAGE), `was blocked: ${url}`);
  });
  await check('service says paused -> not blocked, then active again -> blocked', async () => {
    await applyStatus({ ...ACTIVE, blocking: false, status: 'paused', pauseRemainingSeconds: 1800 });
    assert(!(await go('https://www.tiktok.com/')).startsWith(BLOCKED_PAGE), 'paused should not block');
    await applyStatus(ACTIVE);
    assert((await go('https://www.tiktok.com/')).startsWith(BLOCKED_PAGE), 'active should block');
  });
  await check('unhealthy service (cannot verify) still blocks (fail-safe)', async () => {
    await applyStatus({ ...ACTIVE, blocking: false, status: 'active', serviceAlive: false, integrityOk: false,
      problems: ['The protection service is not running.'] });
    const url = await go('https://www.tiktok.com/');
    assert(url.startsWith(BLOCKED_PAGE), `fail-safe did not block: ${url}`);
  });

  console.log('Popup shows the managed status and countdown');
  await check('popup shows the managed panel and the waiting countdown', async () => {
    await applyStatus({ ...ACTIVE, requestStatus: 'waiting', remainingSeconds: 9600 });
    await openExt('popup.html');
    const info = await evaluate(`
      await new Promise((r) => setTimeout(r, 400));
      return {
        managedShown: !document.getElementById('managedCard').hidden,
        noToggle: document.getElementById('enabledToggle') === null,
        countdown: document.getElementById('managedCountdown').textContent,
        countdownShown: !document.getElementById('managedCountdown').hidden };`);
    assert(info.managedShown && info.noToggle, `panel/toggle wrong: ${JSON.stringify(info)}`);
    assert(info.countdownShown && info.countdown === '2:40:00', `countdown was ${info.countdown}`);
  });
  await check('no script errors on extension pages', () => assert(consoleErrors.length === 0, consoleErrors.join(' | ')));
} catch (error) {
  results.push(false);
  console.error(error);
} finally {
  try { await bidi?.send('browser.close', {}, 10000); } catch { /* ignore */ }
  proc?.kill();
  if (registered) { try { execFileSync('reg', ['delete', REG_KEY, '/f'], { stdio: 'ignore' }); } catch { /* ignore */ } }
  await delay(1500);
  if (profile) await cleanupProfile(profile);
  try { execFileSync('cmd', ['/c', 'rmdir', '/s', '/q', work], { stdio: 'ignore' }); } catch { /* ignore */ }
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
