/**
 * devtools.js — DOM Canary Tracker
 *
 * Runs inside the devtools page context (browser.devtools API available).
 * Creates the custom panel and establishes a persistent port to the background.
 *
 * DESIGN DECISION: We use a long-lived port (browser.runtime.connect) rather
 * than one-shot sendMessage so that the background can push events to us
 * without polling. Port name includes the inspected tab ID for routing.
 */

'use strict';

const inspectedTabId = browser.devtools.inspectedWindow.tabId;

// ─── Register the custom DevTools panel ────────────────────────────────────────
browser.devtools.panels.create(
  'Canary', // Panel title shown in DevTools tab bar
  'icons/icon16.png', // Small icon (16×16)
  'panel.html'        // Panel UI page
).then((panel) => {
  // The panel object allows us to listen for show/hide events if needed.
  // Currently unused but preserved for future pause-on-hide optimization.
  panel.onShown.addListener((_window) => {
    // Panel became visible — could resume logging here
  });
  panel.onHidden.addListener(() => {
    // Panel hidden — could pause logging here
  });
}).catch((err) => {
  console.error('[DOM Canary] Failed to create DevTools panel:', err);
});
