/* Settings storage shared by the background script and the extension pages. */
(function (root) {
  'use strict';

  function withDefaults(stored) {
    return Object.assign(structuredClone(root.SBDefaults.DEFAULT_SETTINGS), stored || {});
  }

  async function getSettings() {
    const { settings } = await browser.storage.local.get('settings');
    return withDefaults(settings);
  }

  async function saveSettings(patch) {
    const next = Object.assign(await getSettings(), patch);
    await browser.storage.local.set({ settings: next });
    return next;
  }

  /** Today's date in local time as YYYY-MM-DD, used to reset the daily block counter. */
  function localDay() {
    return new Date().toLocaleDateString('en-CA');
  }

  root.SBSettings = { withDefaults, getSettings, saveSettings, localDay };
})(globalThis);
