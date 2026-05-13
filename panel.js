/**
 * panel.js — DOM Canary Tracker
 *
 * This is the brain of the DevTools panel UI. It:
 *   1. Connects to the background script via a persistent port.
 *   2. Receives log batches and stores them in an in-memory log store.
 *   3. Renders logs into two tabs: DOM Events and Canary Flow.
 *   4. Handles search/filter, clear, pause/resume, export, and canary config.
 *   5. Renders collapsible stack traces per log entry.
 *
 * PERFORMANCE: We use a virtual rendering approach — only the visible slice
 * of the log array is rendered into the DOM. Scroll events trigger re-renders.
 * This keeps the panel responsive even with thousands of log entries.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

const state = {
  logs: [],
  paused: false,
  pausedDom: false,
  pausedCanary: false,
  canary: '',
  activeTab: 'dom',
  filter: { text: '', eventType: '', file: '' },
  maxLogs: 5000,
  port: null,
  framework: 'Unknown',
  connected: false,
};

// ─── Port connection to background ────────────────────────────────────────────
function connectToBackground() {
  const tabId = browser.devtools.inspectedWindow.tabId;
  state.port = browser.runtime.connect({
    name: `devtools-panel-${tabId}`,
  });

  state.port.onMessage.addListener(handleBackgroundMessage);

  state.port.onDisconnect.addListener(() => {
    state.connected = false;
    updateStatusBar();
    // Reconnect after a short delay
    setTimeout(connectToBackground, 1000);
  });

  state.connected = true;
  updateStatusBar();

  // Send a PING to get the current framework detection
  sendControlMessage({ action: 'PING' });
}

function sendControlMessage(payload) {
  if (!state.port) return;
  try {
    state.port.postMessage({ type: 'PANEL_CONTROL', payload });
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLING
// ═══════════════════════════════════════════════════════════════════════════

function handleBackgroundMessage(message) {
  if (!message || !message.payload) return;

  const payload = message.payload;

  switch (payload.type) {
    case 'LOG_BATCH':
      if (!state.paused && Array.isArray(payload.entries)) {
        addLogs(payload.entries);
      }
      break;
    case 'INJECTED':
    case 'PONG':
      state.framework = payload.framework || 'Unknown';
      state.connected = true;
      updateStatusBar();
      break;
  }
}

function addLogs(entries) {
  for (const entry of entries) {
    if (state.logs.length >= state.maxLogs) {
      state.logs.shift(); // Remove oldest
    }
    state.logs.push(entry);
  }
  scheduleRender();
  updateCounters();
}

// ═══════════════════════════════════════════════════════════════════════════
// FILTERING
// ═══════════════════════════════════════════════════════════════════════════

function getFilteredLogs() {
  const { text, eventType, file } = state.filter;
  const category = state.activeTab === 'dom' ? 'DOM' : 'CANARY';

  return state.logs.filter((entry) => {
    if (entry.category !== category) return false;

    if (eventType && entry.type !== eventType) return false;
    if (file && !entry.file.includes(file)) return false;

    if (text) {
      const searchTarget = [
        entry.type, entry.tag, entry.value, entry.fn,
        entry.file, String(entry.line),
      ].join(' ').toLowerCase();
      if (!searchTarget.includes(text.toLowerCase())) return false;
    }

    return true;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDERING
// ═══════════════════════════════════════════════════════════════════════════

let renderPending = false;

function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderLogs();
  });
}

const HIGHLIGHT_TAGS = new Set(['img', 'script', 'iframe', 'link', 'object', 'embed']);

function getRowClass(entry) {
  if (entry.category === 'CANARY') return 'row-canary';
  if (HIGHLIGHT_TAGS.has(entry.tag)) return 'row-highlight';
  if (entry.tag === 'script') return 'row-script';
  return '';
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Shows file + line info in a panel tooltip instead of navigating to debugger
function showFileInfo(fileUrl, line, anchorEl) {
  // Remove any existing tooltip
  const existing = document.getElementById('file-tooltip');
  if (existing) existing.remove();

  const tooltip = document.createElement('div');
  tooltip.id = 'file-tooltip';
  tooltip.className = 'file-tooltip';
  tooltip.innerHTML = `
    <div class="ft-header">📄 Source Location</div>
    <div class="ft-url">${escapeHtml(fileUrl)}</div>
    <div class="ft-line">Line <strong>${line}</strong></div>
    <div class="ft-hint">Copy path to open in editor</div>
    <button class="ft-copy" data-copy="${escapeHtml(fileUrl)}:${line}">Copy path:line</button>
    <button class="ft-close">✕</button>
  `;

  // Position near the clicked element
  document.body.appendChild(tooltip);
  const rect = anchorEl.getBoundingClientRect();
  tooltip.style.top = (rect.bottom + 4) + 'px';
  tooltip.style.left = Math.min(rect.left, window.innerWidth - 320) + 'px';

  tooltip.querySelector('.ft-copy').addEventListener('click', () => {
    const text = `${fileUrl}:${line}`;
    navigator.clipboard.writeText(text).catch(() => {});
    tooltip.querySelector('.ft-copy').textContent = '✓ Copied!';
    setTimeout(() => tooltip.remove(), 1200);
  });

  tooltip.querySelector('.ft-close').addEventListener('click', () => tooltip.remove());

  // Auto-close on outside click
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!tooltip.contains(e.target)) {
        tooltip.remove();
        document.removeEventListener('click', handler);
      }
    });
  }, 0);
}

function buildStackHtml(frames) {
  if (!frames || frames.length === 0) return '<em class="no-stack">No stack available</em>';
  return frames.map((f) => {
    const hasUrl = !!f.fileUrl;
    return `<div class="stack-frame">
      <span class="sf-fn">${escapeHtml(f.fn)}</span>
      <span class="sf-at">@</span>
      ${hasUrl
        ? `<span class="sf-file sf-link" data-url="${escapeHtml(f.fileUrl)}" data-line="${f.line}" title="Open in Debugger">${escapeHtml(f.file)}</span>`
        : `<span class="sf-file">${escapeHtml(f.file)}</span>`
      }
      <span class="sf-line">:${f.line}</span>
    </div>`;
  }).join('');
}

function renderLogs() {
  const tbody = document.getElementById('log-tbody');
  if (!tbody) return;

  const filtered = getFilteredLogs();

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">
      <div class="empty-state">
        <div class="empty-icon">🐦</div>
        <div class="empty-text">No events captured yet</div>
        <div class="empty-sub">Interact with the page to see DOM mutations and canary access.</div>
      </div>
    </td></tr>`;
    return;
  }

  // Virtual rendering: show last N entries for performance
  const RENDER_LIMIT = 500;
  const visibleLogs = filtered.slice(-RENDER_LIMIT);

  const rows = visibleLogs.map((entry, idx) => {
    const uniqueId = `entry-${entry.ts}-${idx}`;
    const rowClass = getRowClass(entry);
    const badge = entry.category === 'CANARY'
      ? `<span class="badge badge-canary">CANARY</span>`
      : `<span class="badge badge-dom">DOM</span>`;

    const tagOrValue = entry.category === 'DOM'
      ? `<span class="tag-chip tag-${escapeHtml(entry.tag)}">&lt;${escapeHtml(entry.tag || '?')}&gt;</span>`
      : `<span class="canary-value">${escapeHtml((entry.value || '').substring(0, 30))}</span>`;

    const fileCell = entry.fileUrl
      ? `<span class="file-name file-link" data-url="${escapeHtml(entry.fileUrl)}" data-line="${entry.line}" title="Open in Debugger: ${escapeHtml(entry.fileUrl)}">${escapeHtml(entry.file)} <span class="file-link-icon">↗</span></span>`
      : `<span class="file-name">${escapeHtml(entry.file)}</span>`;

    return `<tr class="log-row ${rowClass}" data-id="${uniqueId}" tabindex="0">
      <td class="col-type">${badge} <span class="event-type">${escapeHtml(entry.type)}</span></td>
      <td class="col-el">${tagOrValue}</td>
      <td class="col-fn"><code>${escapeHtml(entry.fn)}</code></td>
      <td class="col-file" title="${escapeHtml(entry.fileUrl)}">${fileCell}</td>
      <td class="col-line">${entry.line}</td>
      <td class="col-ts">${formatTimestamp(entry.ts)}</td>
      <td class="col-actions">
        <button class="btn-stack" data-id="${uniqueId}" title="Show stack trace">⚡</button>
      </td>
    </tr>
    <tr class="stack-row hidden" id="stack-${uniqueId}">
      <td colspan="7">
        <div class="stack-container">
          <div class="stack-header">
            <span>Stack Trace — ${escapeHtml(entry.fn)} @ ${escapeHtml(entry.file)}:${entry.line}</span>
            ${entry.context ? `<div class="stack-context">Context: <code>${escapeHtml(entry.context)}</code></div>` : ''}
          </div>
          <div class="stack-frames">${buildStackHtml(entry.stack)}</div>
        </div>
      </td>
    </tr>`;
  });

  tbody.innerHTML = rows.join('');
  attachRowListeners();
}

function attachRowListeners() {
  document.querySelectorAll('.btn-stack').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const stackRow = document.getElementById(`stack-${id}`);
      if (stackRow) {
        stackRow.classList.toggle('hidden');
        btn.textContent = stackRow.classList.contains('hidden') ? '⚡' : '▼';
      }
    });
  });

  // File name links in main table rows → show file info tooltip
  document.querySelectorAll('.file-link').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      showFileInfo(el.dataset.url, parseInt(el.dataset.line, 10) || 1, el);
    });
  });

  // Stack frame file links → show file info tooltip
  document.querySelectorAll('.sf-link').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      showFileInfo(el.dataset.url, parseInt(el.dataset.line, 10) || 1, el);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// UI UPDATES
// ═══════════════════════════════════════════════════════════════════════════

function syncPerTabButtons() {
  const isPaused = state.activeTab === 'dom' ? state.pausedDom : state.pausedCanary;
  const btn = document.getElementById('btn-pause');
  if (btn) {
    btn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
    btn.classList.toggle('active', isPaused);
  }
  const clearBtn = document.getElementById('btn-clear');
  if (clearBtn) {
    const label = state.activeTab === 'dom' ? 'DOM' : 'Canary';
    clearBtn.textContent = `🗑 Clear ${label}`;
  }
}

function updateStatusBar() {
  const el = document.getElementById('status-bar');
  if (!el) return;

  const connStatus = state.connected
    ? '<span class="status-dot status-green"></span> Connected'
    : '<span class="status-dot status-red"></span> Disconnected';

  const domPause = state.pausedDom ? '<span class="status-paused">⏸ DOM paused</span>' : '';
  const canaryPause = state.pausedCanary ? '<span class="status-paused">⏸ Canary paused</span>' : '';

  el.innerHTML = `${connStatus} &nbsp;·&nbsp; Framework: <strong>${escapeHtml(state.framework)}</strong> ${domPause}${canaryPause}`;
}

function updateCounters() {
  const domCount = state.logs.filter(e => e.category === 'DOM').length;
  const canaryCount = state.logs.filter(e => e.category === 'CANARY').length;

  const domEl = document.getElementById('tab-dom-count');
  const canaryEl = document.getElementById('tab-canary-count');
  if (domEl) domEl.textContent = domCount;
  if (canaryEl) canaryEl.textContent = canaryCount;
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

function setupEventHandlers() {
  // ── Tab switching ──────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.activeTab = btn.dataset.tab;
      syncPerTabButtons(); // update pause/clear button states for this tab
      scheduleRender();
    });
  });

  // ── Search / filter ────────────────────────────────────────────────────────
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', debounce(() => {
      state.filter.text = searchInput.value;
      scheduleRender();
    }, 200));
  }

  const filterType = document.getElementById('filter-type');
  if (filterType) {
    filterType.addEventListener('change', () => {
      state.filter.eventType = filterType.value;
      scheduleRender();
    });
  }

  const filterFile = document.getElementById('filter-file');
  if (filterFile) {
    filterFile.addEventListener('input', debounce(() => {
      state.filter.file = filterFile.value;
      scheduleRender();
    }, 200));
  }

  // ── Per-tab Clear ──────────────────────────────────────────────────────────
  document.getElementById('btn-clear')?.addEventListener('click', () => {
    const cat = state.activeTab === 'dom' ? 'DOM' : 'CANARY';
    state.logs = state.logs.filter(e => e.category !== cat);
    sendControlMessage({ action: state.activeTab === 'dom' ? 'CLEAR_DOM' : 'CLEAR_CANARY' });
    renderLogs();
    updateCounters();
  });

  // ── Per-tab Pause / Resume ─────────────────────────────────────────────────
  document.getElementById('btn-pause')?.addEventListener('click', () => {
    if (state.activeTab === 'dom') {
      state.pausedDom = !state.pausedDom;
      sendControlMessage({ action: 'SET_PAUSED_DOM', paused: state.pausedDom });
    } else {
      state.pausedCanary = !state.pausedCanary;
      sendControlMessage({ action: 'SET_PAUSED_CANARY', paused: state.pausedCanary });
    }
    syncPerTabButtons();
    updateStatusBar();
  });

  // ── Canary input ───────────────────────────────────────────────────────────
  const canaryInput = document.getElementById('canary-input');
  const canarySet = document.getElementById('btn-set-canary');
  const clearCanaryBtn = document.getElementById('btn-clear-canary');

  function applyCanary() {
    state.canary = canaryInput?.value?.trim() || '';
    sendControlMessage({ action: 'SET_CANARY', canary: state.canary });

    const indicator = document.getElementById('canary-indicator');
    if (indicator) {
      if (state.canary) {
        indicator.textContent = `🐦 Tracking: "${state.canary}"`;
        indicator.className = 'canary-indicator active';
      } else {
        indicator.textContent = 'No canary set';
        indicator.className = 'canary-indicator';
      }
    }
  }

  canarySet?.addEventListener('click', applyCanary);
  clearCanaryBtn?.addEventListener('click', () => {

  // Remove active canary
  state.canary = '';

  // Clear input field
  if (canaryInput) {
    canaryInput.value = '';
  }

  // Reset UI indicator
  const indicator = document.getElementById('canary-indicator');

  if (indicator) {
    indicator.textContent = 'No canary set';
    indicator.className = 'canary-indicator';
  }



  // Notify background/injected scripts
  sendControlMessage({
    action: 'SET_CANARY',
    canary: ''
  });

});
  canaryInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyCanary();
  });

  // ── Export logs ────────────────────────────────────────────────────────────
  document.getElementById('btn-export')?.addEventListener('click', () => {
    const filtered = getFilteredLogs();
    const exportData = {
      exportedAt: new Date().toISOString(),
      tabUrl: null,
      framework: state.framework,
      canary: state.canary,
      count: filtered.length,
      logs: filtered,
    };

    // Get current tab URL for metadata
    browser.devtools.inspectedWindow.eval(
      'window.location.href',
      (result) => {
        exportData.tabUrl = result;
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `dom-canary-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
    );
  });
}

// ─── Utility ────────────────────────────────────────────────────────────────
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  setupEventHandlers();
  connectToBackground();
  renderLogs();
  updateStatusBar();
});
