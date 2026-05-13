/**
 * content.js — DOM Canary Tracker
 *
 * DESIGN DECISION: This script runs in the content-script isolated sandbox.
 * Its sole responsibilities are:
 *   1. Inject injected.js into the PAGE context (not the sandbox) so that
 *      our monkey-patches access the real native DOM APIs.
 *   2. Bridge messages from the page (window.postMessage) to the extension
 *      background script (browser.runtime.sendMessage).
 *   3. Bridge control commands from the panel back to the page context.
 *
 * We deliberately keep this file thin — no logic lives here that should
 * live in injected.js or panel.js.
 */

(function () {
  'use strict';

  // ─── Inject the page-context script ────────────────────────────────────────
  // We cannot simply call document.createElement here because the content script
  // sandbox has its own isolated document proxy. We must use a script tag to
  // break out into the real page context.
  function injectScript() {
    const scriptEl = document.createElement('script');
    scriptEl.src = browser.runtime.getURL('injected.js');
    scriptEl.async = false; // ensure it runs before DOMContentLoaded hooks

    // Clean up after injection — the script element is only needed transiently
    scriptEl.onload = () => {
      scriptEl.remove();
    };
    scriptEl.onerror = (err) => {
      console.error('[DOM Canary] Failed to inject page script:', err);
      scriptEl.remove();
    };

    // Append to <head> if available, otherwise <html> root or document root
    const target = document.head || document.documentElement || document;
    target.appendChild(scriptEl);
  }

  // ─── Message relay: page → background → devtools panel ─────────────────────
  window.addEventListener('message', (event) => {
    // Validate origin: only process messages from the same page (not iframes)
    if (event.source !== window) return;
    if (!event.data || !event.data.__domCanary) return;

    const msg = event.data;

    // Relay to background script
    try {
      browser.runtime.sendMessage({
        type: 'PAGE_EVENT',
        tabId: null, // background will fill this in
        payload: msg,
      });
    } catch (e) {
      // Extension may have been unloaded; fail silently
    }
  });

  // ─── Control message relay: background → page context ──────────────────────
  browser.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'PANEL_CONTROL') return;

    // Forward control commands into the page context via postMessage
    window.postMessage({
      __domCanaryControl: true,
      ...message.payload,
    }, '*');
  });

  // ─── Inject on document_start ───────────────────────────────────────────────
  // document_start means the DOM hasn't been parsed yet — ideal for patching
  // before any page scripts run.
  injectScript();

})();
