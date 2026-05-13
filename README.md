# DOM Canary Tracker

Runtime DOM mutation tracing and canary-based JavaScript access tracking for modern web applications.

DOM Canary Tracker is a Firefox DevTools extension designed for frontend debugging, runtime analysis, and security research. It provides real-time visibility into:

* Which JavaScript function created or modified a DOM element
* Which code accessed a specific user-controlled value
* Where runtime UI mutations originate
* How frontend frameworks manipulate the page internally

Unlike traditional DOM inspection tools, DOM Canary Tracker focuses on runtime attribution — identifying the exact file, function, and line number responsible for DOM activity and value access.

---

# Features

## Runtime DOM Mutation Tracking

Track JavaScript-created DOM activity in real time.

Monitored APIs include:

* `document.createElement`
* `appendChild`
* `prepend`
* `replaceChild`
* `removeChild`
* `insertAdjacentHTML`
* `innerHTML`
* `outerHTML`
* `setAttribute`

Every event includes:

* Element/tag name
* Action type
* File name
* Function name
* Line number
* Timestamp
* Stack trace

Example:

```txt
[DOM CREATE]

Tag:
iframe

Function:
injectAnalytics

File:
tracker.js

Line:
188
```

---

## Canary Runtime Access Tracking

Track when JavaScript accesses a specific user-controlled value.

Set a unique canary value:

```txt
__CANARY_TEST_123__
```

Then interact with the application normally.

Whenever JavaScript touches the value, the extension records:

* File name
* Function name
* Line number
* Stack trace
* Access type

This helps identify:

* Hidden input processing
* Validation logic
* Frontend transformation flows
* Runtime value consumption
* Potential DOM XSS paths
* Unexpected data handling

Example:

```txt
[CANARY ACCESS]

Value:
__CANARY_TEST_123__

Function:
validateInput

File:
forms.js

Line:
144
```

---

# DevTools Panel

DOM Canary Tracker adds a dedicated DevTools panel.

## DOM Events Tab

Tracks runtime DOM creation and modification.

Useful for:

* Finding dynamically injected elements
* Debugging React/Vue render storms
* Understanding third-party widget behavior
* Tracing unexpected DOM mutations
* Identifying unsafe rendering patterns

---

## Canary Flow Tab

Tracks runtime access to a specific canary value.

Useful for:

* Tracing input handling
* Understanding frontend logic
* Debugging data transformations
* Finding where user input is consumed
* Reverse engineering large JS applications

---

# Why This Exists

Modern frontend applications are difficult to analyze because:

* DOM is created dynamically
* Frameworks abstract rendering logic
* Bundled/minified code hides execution paths
* Traditional DevTools do not clearly show:

  * who created a node
  * who accessed a value
  * where a mutation originated

DOM Canary Tracker provides runtime attribution instead of static inspection.

---

# Architecture

## Components

```txt
manifest.json
background.js
content.js
injected.js
panel.html
panel.js
styles.css
```

---

## Injection Model

Monkey patches run inside the page context to capture accurate stack traces and runtime behavior.

The extension injects instrumentation hooks at `document_start`.

---

# Example Workflows

## Find Who Created a DOM Node

1. Open DevTools
2. Go to DOM Events tab
3. Interact with the page
4. See:

   * which function created the node
   * which file triggered it
   * the full stack trace

---

## Trace a User-Controlled Value

1. Set a canary value
2. Enter it into an input field
3. Use the application normally
4. Watch Canary Flow events appear in real time

---

# Current Capabilities

* Real-time DOM mutation tracing
* Runtime stack trace capture
* Canary access tracking
* DevTools integration
* Live event filtering
* Stack trace viewer
* Export logs to JSON
* Pause/resume logging
* Per-tab event filtering
* Runtime framework detection
* High-performance virtual rendering

---

# Planned Features

* Source map support
* React Fiber mapping
* Vue component mapping
* Element creator overlay
* Mutation replay timeline
* Network correlation
* Noise suppression
* Attribute diffing
* Right-click “Show Creator”
* Element flashing/highlighting

---

# Performance

The extension includes:

* Virtual rendering
* Event batching
* Stack deduplication
* Max log limits
* Mutation filtering
* Debounced rendering

Designed to remain responsive on large SPAs.

---

# Installation

## Firefox Developer Edition

1. Open:

```txt
about:debugging
```

2. Click:

```txt
This Firefox
```

3. Click:

```txt
Load Temporary Add-on
```

4. Select:

```txt
manifest.json
```

---

# Use Cases

## Frontend Debugging

* Find unexpected renders
* Trace component creation
* Analyze framework behavior

## Security Research

* Trace user-controlled values
* Investigate DOM mutation flows
* Study frontend runtime behavior
* Analyze client-side rendering logic

## Reverse Engineering

* Understand large bundled applications
* Discover hidden processing logic
* Identify internal rendering pipelines

---

# Disclaimer

This tool is intended for:

* debugging
* frontend analysis
* authorized security testing
* runtime observability
* educational research

Only use against applications you own or are authorized to test.

---

# License

MIT License