/*
 * Link to the optional "Study Mode Protection" Windows service, over native messaging.
 *
 * The service, when installed, owns the on/off decision and the 2h40m waiting period, so
 * protection can't be turned off impulsively from inside Firefox. This module polls the
 * service for its status; background.js makes the extension follow it.
 *
 * The service is optional. With no native host installed, sendNativeMessage rejects, we
 * mark the service "unavailable", and the extension runs exactly as it does standalone.
 * If the service was installed but looks unhealthy, we keep blocking (fail-safe) and let
 * the popup show that protection can't be verified.
 */
(function (root) {
  'use strict';

  const HOST = 'com.studymode.protection';
  let status = null;       // last status object from the service, or null
  let available = false;   // did the native host answer at all?
  const listeners = [];

  async function poll() {
    let next = null;
    let ok = false;
    try {
      next = await browser.runtime.sendNativeMessage(HOST, { type: 'getStatus' });
      ok = Boolean(next && next.type === 'status');
    } catch (error) {
      // No native host, or it is not registered: the service isn't managing this browser.
      ok = false;
    }
    const changed = ok !== available || JSON.stringify(next) !== JSON.stringify(status);
    available = ok;
    status = ok ? next : null;
    if (changed) listeners.forEach((fn) => { try { fn(getState()); } catch (e) { /* ignore */ } });
    return getState();
  }

  function getState() {
    return { available, status };
  }

  /**
   * Whether the extension should block, given the service.
   *  - no service: null (caller falls back to its own setting)
   *  - service healthy: follow its decision
   *  - service present but unhealthy (can't verify): true, so we err on the side of blocking
   */
  function blockingOverride() {
    if (!available || !status) return null;
    if (status.integrityOk === false && status.serviceAlive === false) return true;
    return Boolean(status.blocking);
  }

  function isManaged() {
    return available;
  }

  function onChange(fn) {
    listeners.push(fn);
  }

  root.SBProtection = { poll, getState, blockingOverride, isManaged, onChange };
})(globalThis);
