/**
 * injected.js — DOM Canary Tracker
 *
 * DESIGN DECISION: This script runs in the actual PAGE context (not the isolated
 * content-script sandbox). This is critical because:
 *   1. We need to patch the real window.document methods, not proxy copies.
 *   2. Stack traces must originate from the page's own JS execution context,
 *      not from extension frames — otherwise file/line info is useless.
 *   3. Frameworks like React/Vue cache native DOM references early; we must
 *      patch before or alongside their initialization (run_at: document_start).
 *
 * Communication back to the DevTools panel happens via window.postMessage,
 * which the content.js script relays through the extension messaging system.
 */

(function () {
  'use strict';

  // ─── Guard: prevent double-injection ───────────────────────────────────────
  if (window.__domCanaryInjected) return;
  window.__domCanaryInjected = true;

  // ─── Configuration (updated from panel via postMessage) ────────────────────
  const config = {
    enabled: true,
    paused: false,
    pausedDom: false,
    pausedCanary: false,
    canary: '',
    maxLogs: 5000,
    batchIntervalMs: 100,
    ignoredExtensionFrames: [
      'moz-extension://',
      'dom-canary-tracker',
      'injected.js',
      'content.js',
    ],
  };

  // ─── Log buffer for batched delivery ───────────────────────────────────────
  let logBuffer = [];
  let flushTimer = null;
  let logCount = 0;

  // ─── Deduplication: suppress identical back-to-back events ─────────────────
  let lastEventKey = '';
  let lastEventCount = 0;

  // ─── Re-entrancy guards (prevent hooks from re-triggering themselves) ───────
  const guards = {
    domHook: false,
    canaryHook: false,
    jsonHook: false,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // STACK TRACE PARSER
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * parseStack — converts Error().stack into structured frame objects.
   * Handles Firefox's "@file:line:col" format.
   * Strips extension-internal frames and browser internals.
   */
  function parseStack(stackStr) {
    if (!stackStr) return [];

    const lines = stackStr.split('\n');
    const frames = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Skip our own injected frames
      if (config.ignoredExtensionFrames.some(f => trimmed.includes(f))) continue;
      // Skip Firefox internals
      if (trimmed.startsWith('self-hosted') || trimmed.startsWith('resource://')) continue;

      // Firefox format: "functionName@https://example.com/app.js:120:15"
      // Or anonymous:   "@https://example.com/app.js:120:15"
      const match = trimmed.match(/^([^@]*)@(.*):(\d+):(\d+)$/);
      if (match) {
        const [, rawFn, fileUrl, line, col] = match;
        const fn = rawFn.trim() || '(anonymous)';
        const file = fileUrl.split('/').pop().split('?')[0] || fileUrl;
        frames.push({
          fn,
          file,
          fileUrl,
          line: parseInt(line, 10),
          col: parseInt(col, 10),
          raw: trimmed,
        });
      } else if (trimmed.includes('@')) {
        // Partial match
        frames.push({ fn: '(unknown)', file: trimmed, fileUrl: trimmed, line: 0, col: 0, raw: trimmed });
      }
    }

    return frames;
  }

  /**
   * getCallerInfo — returns the first meaningful frame from the call stack,
   * skipping our own wrapper frames.
   */
  function getCallerInfo(skipExtra = 0) {
    const err = new Error();
    const frames = parseStack(err.stack);
    // Frame 0 = getCallerInfo itself; frame 1 = hook wrapper; frame N = actual caller
    const callerIndex = 1 + skipExtra;
    const frame = frames[callerIndex] || frames[0] || {};
    return {
      fn: frame.fn || '(anonymous)',
      file: frame.file || 'unknown',
      fileUrl: frame.fileUrl || '',
      line: frame.line || 0,
      col: frame.col || 0,
      stack: frames,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LOG EMISSION SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════

  function emitLog(entry) {
    if (!config.enabled || config.paused) return;
    if (entry.category === 'DOM' && config.pausedDom) return;
    if (entry.category === 'CANARY' && config.pausedCanary) return;
    if (logCount >= config.maxLogs) return;

    // Deduplication: collapse repeated identical events
    const key = `${entry.type}|${entry.tag || entry.value || ''}|${entry.fn}|${entry.file}|${entry.line}`;
    if (key === lastEventKey) {
      lastEventCount++;
      if (lastEventCount > 5) return; // suppress after 5 identical
    } else {
      lastEventKey = key;
      lastEventCount = 0;
    }

    logCount++;
    logBuffer.push(entry);

    if (!flushTimer) {
      flushTimer = setTimeout(flushLogs, config.batchIntervalMs);
    }
  }

  function flushLogs() {
    flushTimer = null;
    if (logBuffer.length === 0) return;

    const batch = logBuffer.splice(0, logBuffer.length);
    window.postMessage({
      __domCanary: true,
      type: 'LOG_BATCH',
      entries: batch,
    }, '*');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FRAMEWORK DETECTION
  // ═══════════════════════════════════════════════════════════════════════════

  function detectFramework() {
    if (window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return 'React';
    if (window.Vue) return 'Vue';
    if (window.angular || window.ng) return 'Angular';
    if (window.Ember) return 'Ember';
    return 'Vanilla';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOM TRACKING — Monkey-patch DOM mutation APIs
  // ═══════════════════════════════════════════════════════════════════════════

  const NativeNode = window.Node;
  const NativeElement = window.Element;
  const NativeDocument = window.Document;
  const NativeHTMLElement = window.HTMLElement;

  /**
   * wrapMethod — safely replaces an object's method with an instrumented version.
   * Preserves prototype chain and handles edge cases gracefully.
   */
  function wrapMethod(obj, methodName, wrapper) {
    const original = obj[methodName];
    if (typeof original !== 'function') return;

    obj[methodName] = function (...args) {
      return wrapper.call(this, original, args, methodName);
    };

    // Preserve .name and .length for devtools inspection
    Object.defineProperty(obj[methodName], 'name', { value: methodName });
    obj[methodName].__domCanaryOriginal = original;
  }

  function logDOMAction(actionType, tagName, callerInfo) {
    if (guards.domHook) return;
    guards.domHook = true;

    try {
      emitLog({
        category: 'DOM',
        type: actionType,
        tag: tagName,
        fn: callerInfo.fn,
        file: callerInfo.file,
        fileUrl: callerInfo.fileUrl,
        line: callerInfo.line,
        col: callerInfo.col,
        stack: callerInfo.stack,
        ts: Date.now(),
        framework: detectFramework(),
      });
    } finally {
      guards.domHook = false;
    }
  }

  // ── document.createElement ─────────────────────────────────────────────────
  wrapMethod(document, 'createElement', function (original, args, name) {
    const result = original.apply(this, args);
    const caller = getCallerInfo(1);
    logDOMAction('createElement', (args[0] || 'unknown').toLowerCase(), caller);
    return result;
  });

  // ── document.createElementNS ───────────────────────────────────────────────
  wrapMethod(document, 'createElementNS', function (original, args, name) {
    const result = original.apply(this, args);
    const caller = getCallerInfo(1);
    const tag = (args[1] || 'unknown').split(':').pop().toLowerCase();
    logDOMAction('createElementNS', tag, caller);
    return result;
  });

  // ── Node.prototype.appendChild ─────────────────────────────────────────────
  wrapMethod(NativeNode.prototype, 'appendChild', function (original, args, name) {
    const result = original.apply(this, args);
    const child = args[0];
    const tag = child && child.tagName ? child.tagName.toLowerCase() : 'node';
    const caller = getCallerInfo(1);
    logDOMAction('appendChild', tag, caller);
    return result;
  });

  // ── Node.prototype.insertBefore ────────────────────────────────────────────
  wrapMethod(NativeNode.prototype, 'insertBefore', function (original, args, name) {
    const result = original.apply(this, args);
    const child = args[0];
    const tag = child && child.tagName ? child.tagName.toLowerCase() : 'node';
    const caller = getCallerInfo(1);
    logDOMAction('insertBefore', tag, caller);
    return result;
  });

  // ── Node.prototype.removeChild ─────────────────────────────────────────────
  wrapMethod(NativeNode.prototype, 'removeChild', function (original, args, name) {
    const result = original.apply(this, args);
    const child = args[0];
    const tag = child && child.tagName ? child.tagName.toLowerCase() : 'node';
    const caller = getCallerInfo(1);
    logDOMAction('removeChild', tag, caller);
    return result;
  });

  // ── Node.prototype.replaceChild ────────────────────────────────────────────
  wrapMethod(NativeNode.prototype, 'replaceChild', function (original, args, name) {
    const result = original.apply(this, args);
    const newChild = args[0];
    const tag = newChild && newChild.tagName ? newChild.tagName.toLowerCase() : 'node';
    const caller = getCallerInfo(1);
    logDOMAction('replaceChild', tag, caller);
    return result;
  });

  // ── Element.prototype.prepend ──────────────────────────────────────────────
  wrapMethod(NativeElement.prototype, 'prepend', function (original, args, name) {
    const result = original.apply(this, args);
    const first = args[0];
    const tag = first && first.tagName ? first.tagName.toLowerCase() : 'text';
    const caller = getCallerInfo(1);
    logDOMAction('prepend', tag, caller);
    return result;
  });

  // ── Element.prototype.append ───────────────────────────────────────────────
  wrapMethod(NativeElement.prototype, 'append', function (original, args, name) {
    const result = original.apply(this, args);
    const first = args[0];
    const tag = first && first.tagName ? first.tagName.toLowerCase() : 'text';
    const caller = getCallerInfo(1);
    logDOMAction('append', tag, caller);
    return result;
  });

  // ── Element.prototype.insertAdjacentHTML ───────────────────────────────────
  wrapMethod(NativeElement.prototype, 'insertAdjacentHTML', function (original, args, name) {
    const result = original.apply(this, args);
    const caller = getCallerInfo(1);
    // Attempt to extract first tag from the HTML string
    const htmlStr = args[1] || '';
    const tagMatch = htmlStr.match(/<([a-zA-Z][a-zA-Z0-9]*)/);
    const tag = tagMatch ? tagMatch[1].toLowerCase() : 'html-fragment';
    logDOMAction('insertAdjacentHTML', tag, caller);
    return result;
  });

  // ── Element.prototype.setAttribute ────────────────────────────────────────
  wrapMethod(NativeElement.prototype, 'setAttribute', function (original, args, name) {
    const result = original.apply(this, args);
    const attrName = args[0] || '';
    // Only log security-relevant attribute sets
    const tracked = ['src', 'href', 'action', 'data', 'srcdoc', 'sandbox', 'integrity'];
    if (tracked.includes(attrName.toLowerCase())) {
      const caller = getCallerInfo(1);
      logDOMAction(`setAttribute[${attrName}]`, this.tagName ? this.tagName.toLowerCase() : 'element', caller);
    }
    return result;
  });

  // ── innerHTML / outerHTML property hooks via Object.defineProperty ─────────
  // These are property setters, not methods, so we use defineProperty.
  function hookHTMLProperty(proto, propName) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, propName);
    if (!descriptor || !descriptor.set) return;

    const originalSetter = descriptor.set;
    const originalGetter = descriptor.get;

    Object.defineProperty(proto, propName, {
      get() {
        return originalGetter.call(this);
      },
      set(value) {
        originalSetter.call(this, value);
        if (guards.domHook) return;
        const caller = getCallerInfo(1);
        logDOMAction(propName, this.tagName ? this.tagName.toLowerCase() : 'element', caller);

        // Canary check in HTML writes
        if (config.canary && typeof value === 'string' && value.includes(config.canary)) {
          logCanaryAccess('htmlWrite', config.canary, value.substring(0, 200), caller);
        }
      },
      configurable: true,
    });
  }

  hookHTMLProperty(NativeElement.prototype, 'innerHTML');
  hookHTMLProperty(NativeElement.prototype, 'outerHTML');

  // ═══════════════════════════════════════════════════════════════════════════
  // CANARY TRACKING — Hook network, storage, and serialization APIs
  // ═══════════════════════════════════════════════════════════════════════════

  function logCanaryAccess(accessType, canaryValue, context, callerInfo) {
    if (guards.canaryHook) return;
    guards.canaryHook = true;

    try {
      emitLog({
        category: 'CANARY',
        type: accessType,
        value: canaryValue,
        context: String(context || '').substring(0, 300),
        fn: callerInfo.fn,
        file: callerInfo.file,
        fileUrl: callerInfo.fileUrl,
        line: callerInfo.line,
        col: callerInfo.col,
        stack: callerInfo.stack,
        ts: Date.now(),
      });
    } finally {
      guards.canaryHook = false;
    }
  }

  /**
   * checkForCanary — tests a value for canary presence.
   * Handles strings, objects (stringified), and FormData entries.
   */
  function checkForCanary(value, accessType, contextLabel) {
    if (!config.canary || !config.enabled || config.paused || config.pausedCanary) return;
    if (guards.canaryHook) return;

    let strValue = '';
    try {
      if (typeof value === 'string') {
        strValue = value;
      } else if (value instanceof URLSearchParams) {
        strValue = value.toString();
      } else if (value !== null && value !== undefined) {
        strValue = String(value);
      }
    } catch (e) {
      return;
    }

    // Use indexOf (native, no prototype hook risk) instead of .includes()
    if (strValue.indexOf(config.canary) !== -1) {
      const caller = getCallerInfo(2);
      logCanaryAccess(accessType, config.canary, contextLabel || strValue.substring(0, 200), caller);
    }
  }

  // ── fetch ──────────────────────────────────────────────────────────────────
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    if (config.canary) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      checkForCanary(url, 'fetch:url', url);

      if (init) {
        checkForCanary(init.body, 'fetch:body', 'fetch body');
        if (init.headers) {
          try {
            const headerStr = JSON.stringify(init.headers);
            checkForCanary(headerStr, 'fetch:headers', 'fetch headers');
          } catch (e) {}
        }
      }
    }
    return originalFetch.apply(this, arguments);
  };

  // ── XMLHttpRequest ─────────────────────────────────────────────────────────
  const OrigXHR = window.XMLHttpRequest;
  const origXHROpen = OrigXHR.prototype.open;
  const origXHRSend = OrigXHR.prototype.send;
  const origXHRSetHeader = OrigXHR.prototype.setRequestHeader;

  OrigXHR.prototype.open = function (method, url, ...rest) {
    checkForCanary(url, 'xhr:open', url);
    this.__canaryUrl = url;
    return origXHROpen.apply(this, [method, url, ...rest]);
  };

  OrigXHR.prototype.send = function (body) {
    checkForCanary(body, 'xhr:send', `XHR body → ${this.__canaryUrl || '?'}`);
    return origXHRSend.apply(this, arguments);
  };

  OrigXHR.prototype.setRequestHeader = function (name, value) {
    checkForCanary(value, 'xhr:header', `header: ${name}`);
    return origXHRSetHeader.apply(this, arguments);
  };

  // ── WebSocket ──────────────────────────────────────────────────────────────
  const OrigWS = window.WebSocket;
  if (OrigWS) {
    const origWSSend = OrigWS.prototype.send;
    OrigWS.prototype.send = function (data) {
      checkForCanary(data, 'websocket:send', 'WebSocket data');
      return origWSSend.apply(this, arguments);
    };
  }

  // ── JSON.stringify ─────────────────────────────────────────────────────────
  const originalJSONStringify = JSON.stringify;
  JSON.stringify = function (value, replacer, space) {
    const result = originalJSONStringify.apply(JSON, arguments);
    if (!guards.jsonHook && config.canary && typeof result === 'string' && result.indexOf(config.canary) !== -1) {
      guards.jsonHook = true;
      const caller = getCallerInfo(1);
      logCanaryAccess('JSON.stringify', config.canary, result.substring(0, 200), caller);
      guards.jsonHook = false;
    }
    return result;
  };

  // ── FormData.append ────────────────────────────────────────────────────────
  const origFDAppend = FormData.prototype.append;
  FormData.prototype.append = function (name, value, ...rest) {
    checkForCanary(value, 'formdata:append', `FormData key: ${name}`);
    checkForCanary(name, 'formdata:append', `FormData key name: ${name}`);
    return origFDAppend.apply(this, [name, value, ...rest]);
  };

  // ── URLSearchParams ────────────────────────────────────────────────────────
  const origUSPAppend = URLSearchParams.prototype.append;
  const origUSPSet = URLSearchParams.prototype.set;

  URLSearchParams.prototype.append = function (name, value) {
    checkForCanary(value, 'urlparams:append', `param: ${name}`);
    return origUSPAppend.apply(this, arguments);
  };

  URLSearchParams.prototype.set = function (name, value) {
    checkForCanary(value, 'urlparams:set', `param: ${name}`);
    return origUSPSet.apply(this, arguments);
  };

  // ── localStorage / sessionStorage ─────────────────────────────────────────
  function hookStorage(storageObj, storageLabel) {
    const origGetItem = storageObj.getItem;
    const origSetItem = storageObj.setItem;

    storageObj.getItem = function (key) {
      const result = origGetItem.apply(this, arguments);
      checkForCanary(result, `${storageLabel}:getItem`, `key: ${key}`);
      return result;
    };

    storageObj.setItem = function (key, value) {
      checkForCanary(value, `${storageLabel}:setItem`, `key: ${key}`);
      return origSetItem.apply(this, arguments);
    };
  }

  try { hookStorage(window.localStorage, 'localStorage'); } catch (e) {}
  try { hookStorage(window.sessionStorage, 'sessionStorage'); } catch (e) {}

  // ── HTMLInputElement.value / HTMLTextAreaElement.value ─────────────────────
  // Hook BOTH getter (read) and setter (write) so we catch:
  //   - JS *reading* a field that contains the canary (e.g. validators, submit handlers)
  //   - JS *writing* the canary into a field programmatically
  function hookInputValue(proto, label) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (!descriptor) return;

    const origGetter = descriptor.get;
    const origSetter = descriptor.set;

    // Per-element read guard to prevent getter re-entry
    // (checkForCanary internally may trigger string ops that read .value again)
    const readingSet = new WeakSet();

    Object.defineProperty(proto, 'value', {
      get() {
        const val = origGetter ? origGetter.call(this) : undefined;
        // Only check if canary set, not already checking this element, and not in any hook
        if (config.canary && !guards.canaryHook && !readingSet.has(this)) {
          readingSet.add(this);
          try {
            if (typeof val === 'string' && val.indexOf(config.canary) !== -1) {
              const caller = getCallerInfo(1);
              logCanaryAccess(`${label}:read`, config.canary, `${label}.value read`, caller);
            }
          } finally {
            readingSet.delete(this);
          }
        }
        return val;
      },
      set(val) {
        if (origSetter) origSetter.call(this, val);
        if (config.canary && !guards.canaryHook) {
          if (typeof val === 'string' && val.indexOf(config.canary) !== -1) {
            const caller = getCallerInfo(1);
            logCanaryAccess(`${label}:write`, config.canary, `${label}.value write`, caller);
          }
        }
      },
      configurable: true,
    });
  }

  hookInputValue(HTMLInputElement.prototype, 'input');
  hookInputValue(HTMLTextAreaElement.prototype, 'textarea');

  // ── MutationObserver-based canary scan ─────────────────────────────────────
  // Instead of hooking String.prototype (which causes infinite recursion because
  // our own internal code calls string methods), we use a periodic scan of
  // the live DOM to detect when the canary value appears in text nodes or
  // attribute values. This is safe, loop-free, and catches framework rendering.
  let canaryDomScanTimer = null;
  function scheduleCanaryDomScan() {
    if (canaryDomScanTimer) return;
    canaryDomScanTimer = setTimeout(() => {
      canaryDomScanTimer = null;
      if (!config.canary || !config.enabled || config.paused || config.pausedCanary) return;
      scanDomForCanary();
    }, 300);
  }

  function scanDomForCanary() {
    if (guards.canaryHook) return;
    guards.canaryHook = true;
    try {
      // Walk text nodes
      const walker = document.createTreeWalker(
        document.body || document.documentElement,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        null
      );
      let node;
      let found = false;
      while ((node = walker.nextNode()) && !found) {
        let val = '';
        if (node.nodeType === Node.TEXT_NODE) {
          val = node.nodeValue || '';
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          val = (node.value !== undefined ? node.value : '') ||
                (node.getAttribute && node.getAttribute('value')) || '';
        }
        // Use raw indexOf to avoid re-triggering any hooked string methods
        if (val && val.indexOf(config.canary) !== -1) {
          found = true;
          const caller = getCallerInfo(0);
          emitLog({
            category: 'CANARY',
            type: 'dom:textNode',
            value: config.canary,
            context: val.substring(0, 200),
            fn: caller.fn,
            file: caller.file,
            fileUrl: caller.fileUrl,
            line: caller.line,
            col: caller.col,
            stack: caller.stack,
            ts: Date.now(),
          });
        }
      }
    } catch (e) {
      // Ignore walk errors
    } finally {
      guards.canaryHook = false;
    }
  }

  // Trigger DOM scan when DOM mutates (text content changes)
  const canaryMutObs = new MutationObserver(() => scheduleCanaryDomScan());
  canaryMutObs.observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, attributes: false,
  });

  // ── Safe Object.assign hook ────────────────────────────────────────────────
  const origObjectAssign = Object.assign;
  Object.assign = function (target, ...sources) {
    const result = origObjectAssign.apply(Object, [target, ...sources]);
    if (config.canary && !guards.canaryHook) {
      guards.canaryHook = true;
      try {
        for (const src of sources) {
          if (!src || typeof src !== 'object') continue;
          const keys = Object.keys(src);
          for (const k of keys) {
            const v = src[k];
            if (typeof v === 'string' && v.indexOf(config.canary) !== -1) {
              const caller = getCallerInfo(1);
              logCanaryAccess('Object.assign', config.canary, `key: ${k} = ${v.substring(0, 100)}`, caller);
              break;
            }
          }
        }
      } catch (e) {
      } finally {
        guards.canaryHook = false;
      }
    }
    return result;
  };

  // ─── clipboard API ─────────────────────────────────────────────────────────
  if (navigator.clipboard && navigator.clipboard.writeText) {
    const origClipWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = function (text) {
      checkForCanary(text, 'clipboard:write', 'clipboard writeText');
      return origClipWrite(text);
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION RECEIVER — Listen for updates from the DevTools panel
  // ═══════════════════════════════════════════════════════════════════════════

  window.addEventListener('message', (event) => {
    if (!event.data || !event.data.__domCanaryControl) return;

    const msg = event.data;
    switch (msg.action) {
      case 'SET_CANARY':
        config.canary = msg.canary || '';
        break;
      case 'SET_PAUSED':
        config.paused = !!msg.paused;
        break;
      case 'SET_PAUSED_DOM':
        config.pausedDom = !!msg.paused;
        break;
      case 'SET_PAUSED_CANARY':
        config.pausedCanary = !!msg.paused;
        break;
      case 'SET_ENABLED':
        config.enabled = !!msg.enabled;
        break;
      case 'CLEAR_LOGS':
        logBuffer = [];
        logCount = 0;
        lastEventKey = '';
        lastEventCount = 0;
        break;
      case 'CLEAR_DOM':
      case 'CLEAR_CANARY':
        // Panel handles the filtering; just reset counters
        logBuffer = logBuffer.filter(e =>
          msg.action === 'CLEAR_DOM' ? e.category !== 'DOM' : e.category !== 'CANARY'
        );
        logCount = Math.max(0, logCount - 100);
        lastEventKey = '';
        break;
      case 'RESET_COUNT':
        logCount = 0;
        break;
      case 'PING':
        window.postMessage({ __domCanary: true, type: 'PONG', framework: detectFramework() }, '*');
        break;
    }
  });

  // ─── Announce injection is complete ────────────────────────────────────────
  window.postMessage({
    __domCanary: true,
    type: 'INJECTED',
    framework: detectFramework(),
    ts: Date.now(),
  }, '*');

  // ─── Ensure any buffered logs are flushed on page unload ───────────────────
  window.addEventListener('beforeunload', flushLogs, { once: true });

})();
