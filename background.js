/**
 * background.js — DOM Canary Tracker
 *
 * Acts as the central message router between:
 *   - content scripts (one per tab) ←→ devtools panels (one per inspected tab)
 *
 * DESIGN DECISION: We maintain a map of tabId → panel port connections so that
 * the devtools panel for tab 42 only receives events from tab 42's page.
 * This is essential for correctness when the user has multiple tabs open.
 */

'use strict';

// Map of tabId (number) → port connection to the devtools panel
const panelConnections = new Map();

// ─── DevTools panel connection lifecycle ───────────────────────────────────────
browser.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('devtools-panel-')) return;

  // Port name encodes the inspected tab ID: "devtools-panel-{tabId}"
  const tabId = parseInt(port.name.replace('devtools-panel-', ''), 10);
  if (isNaN(tabId)) return;

  panelConnections.set(tabId, port);

  // Relay control messages from the panel to the correct content script
  port.onMessage.addListener((message) => {
    if (!message || message.type !== 'PANEL_CONTROL') return;

    browser.tabs.sendMessage(tabId, {
      type: 'PANEL_CONTROL',
      payload: message.payload,
    }).catch(() => {
      // Tab may have navigated away — ignore
    });
  });

  port.onDisconnect.addListener(() => {
    panelConnections.delete(tabId);
  });
});

// ─── Page event relay ──────────────────────────────────────────────────────────
browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== 'PAGE_EVENT') return;

  const tabId = sender.tab && sender.tab.id;
  if (!tabId) return;

  const port = panelConnections.get(tabId);
  if (!port) return; // DevTools not open for this tab

  try {
    port.postMessage({
      type: 'PAGE_EVENT',
      payload: message.payload,
      tabId,
    });
  } catch (e) {
    // Port may be disconnected
    panelConnections.delete(tabId);
  }
});

// ─── Clean up connections on tab close ────────────────────────────────────────
browser.tabs.onRemoved.addListener((tabId) => {
  panelConnections.delete(tabId);
});
