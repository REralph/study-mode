/* Optional password guarding the settings page and turning protection off. */
(function (root) {
  'use strict';

  const ITERATIONS = 250000;

  const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
  const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

  async function derive(password, salt, iterations) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
    return toBase64(new Uint8Array(bits));
  }

  async function getLock() {
    const { lock } = await browser.storage.local.get('lock');
    return lock && lock.hash ? lock : null;
  }

  async function isSet() {
    return Boolean(await getLock());
  }

  async function verify(password) {
    const lock = await getLock();
    if (!lock) return true;
    return (await derive(password, fromBase64(lock.salt), lock.iterations)) === lock.hash;
  }

  /** Sets a new password, or removes the lock when `password` is empty. */
  async function set(password) {
    if (!password) {
      await browser.storage.local.remove('lock');
      return;
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derive(password, salt, ITERATIONS);
    await browser.storage.local.set({ lock: { salt: toBase64(salt), iterations: ITERATIONS, hash } });
  }

  root.SBLock = { isSet, verify, set };
})(globalThis);
