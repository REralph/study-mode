// Minimal WebDriver BiDi client and headless-Firefox launcher, shared by the e2e tests.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const FIREFOX = process.env.FIREFOX_BIN || 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
export const EXT_ID = 'study-mode@desktop.local';
export const EXT_UUID = '5b1e5f43-4d0a-4c4e-9a37-1f2e3d4c5b6a';
export const EXT_BASE = `moz-extension://${EXT_UUID}`;

export class Bidi {
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }
}

export async function connect(url) {
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

const BASE_PREFS = {
  'extensions.webextensions.uuids': JSON.stringify({ [EXT_ID]: EXT_UUID }),
  // Dead proxy for all web traffic: the tests run fully offline.
  'network.proxy.type': 1,
  'network.proxy.http': '127.0.0.1',
  'network.proxy.http_port': 9,
  'network.proxy.ssl': '127.0.0.1',
  'network.proxy.ssl_port': 9,
  'network.proxy.no_proxies_on': '',
  'network.dns.disablePrefetch': true,
  'network.prefetch-next': false,
  'network.http.speculative-parallel-limit': 0,
  'browser.shell.checkDefaultBrowser': false,
  'datareporting.policy.dataSubmissionEnabled': false,
  'toolkit.telemetry.reportingpolicy.firstRun': false,
  'browser.aboutwelcome.enabled': false,
};

/** Launches headless Firefox with a throwaway profile. Returns { proc, profile, port }. */
export function launchFirefox(port, extraPrefs = {}) {
  const profile = mkdtempSync(path.join(tmpdir(), 'study-mode-e2e-'));
  const prefs = { ...BASE_PREFS, ...extraPrefs };
  writeFileSync(path.join(profile, 'user.js'),
    Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'));
  const proc = spawn(FIREFOX, [
    '-headless', '-no-remote', '-wait-for-browser', '-profile', profile,
    '--remote-debugging-port', String(port), '--remote-allow-system-access',
  ], { stdio: 'ignore', env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } }); // Firefox 160+ wants the variable
  return { proc, profile };
}

export async function cleanupProfile(profile) {
  for (let i = 0; i < 5; i++) {
    try { rmSync(profile, { recursive: true, force: true }); return; } catch { await delay(1000); }
  }
}
