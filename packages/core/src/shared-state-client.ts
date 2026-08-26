/**
 * The deliberately tiny authoring surface for persistent mini-app state. It is
 * injected near the start of embedded artifact HTML so an artifact's own scripts
 * can call `derive.shared(...)` synchronously. Authentication stays in the host:
 * this opaque-origin client only speaks postMessage.
 */
import { SHARED_STATE_KEY_PATTERN } from "./shared-state"

export const SHARED_STATE_CLIENT_JS = `(function () {
  var root = window.derive;
  if (!root || (typeof root !== "object" && typeof root !== "function")) root = {};
  if (typeof root.shared === "function") return;
  var states = Object.create(null), pending = Object.create(null), queued = [], seq = 0;
  var keyPattern = new RegExp(${JSON.stringify(SHARED_STATE_KEY_PATTERN)});
  var ready = false;
  var contentReady = false;
  var reported = Object.create(null);

  // The load event is too late to be the only readiness signal. Image error handlers run
  // while the document is still loading, after an app may already have painted a
  // complete table or dashboard. Treat an explicit author marker, visible rich content,
  // or a non-trivial visible body as meaningful so an optional failure cannot hide a
  // usable artifact behind the host's startup card. Hidden nodes and source text never
  // count: they give the viewer nothing usable to preserve.
  function isVisiblyRendered(element) {
    if (!element || element.hidden) return false;
    try {
      if (element.getAttribute && element.getAttribute("aria-hidden") === "true") return false;
      if (typeof window.getComputedStyle === "function") {
        var style = window.getComputedStyle(element);
        if (style && (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          style.opacity === "0"
        )) return false;
      }
      if (typeof element.getClientRects === "function") {
        var rects = element.getClientRects();
        if (!rects.length) return false;
        var hasArea = false;
        for (var r = 0; r < rects.length; r += 1) {
          if (Number(rects[r].width || 0) > 0 && Number(rects[r].height || 0) > 0) {
            hasArea = true;
            break;
          }
        }
        if (!hasArea) return false;
      }
      if (String(element.tagName || "").toLowerCase() === "img" &&
          (!element.complete || Number(element.naturalWidth || 0) <= 0 ||
           Number(element.naturalHeight || 0) <= 0)) return false;
    } catch (_) { /* structural checks and visible text remain as fallbacks */ }
    return true;
  }
  function runtimeRoots(body) {
    var roots = [body];
    for (var at = 0; at < roots.length; at += 1) {
      var root = roots[at];
      var elements = root && root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (var i = 0; i < Number(elements.length || 0); i += 1) {
        var shadow = elements[i] && elements[i].shadowRoot;
        if (shadow && roots.indexOf(shadow) < 0) roots.push(shadow);
      }
    }
    return roots;
  }
  function hasMeaningfulContent() {
    try {
      var doc = window.document, body = doc && doc.body;
      if (!body) return false;
      var richContent = false;
      var roots = runtimeRoots(body);
      for (var r = 0; r < roots.length && !richContent; r += 1) {
        var markers = roots[r].querySelectorAll
          ? roots[r].querySelectorAll("[data-derive-ready]") : [];
        for (var m = 0; m < Number(markers.length || 0); m += 1) {
          if (isVisiblyRendered(markers[m])) return true;
        }
        var rich = roots[r].querySelectorAll
          ? roots[r].querySelectorAll("table,canvas,svg,video,img") : [];
        for (var i = 0; i < Number(rich.length || 0); i += 1) {
          if (isVisiblyRendered(rich[i])) { richContent = true; break; }
        }
      }
      // innerText is layout-aware and omits script/style/hidden descendants. Falling
      // back to textContent made a long inline script look like visible authored copy.
      var visibleText = typeof body.innerText === "string" ? body.innerText : "";
      var text = String(visibleText).replace(/\\s+/g, "");
      return Number(body.childElementCount || 0) > 0 && (richContent || text.length >= 80);
    } catch (_) {
      return false;
    }
  }

  function runtimeErrorCode(error, message) {
    var text = String(message || (error && error.message) || "").toLowerCase();
    return /localstorage|sessionstorage|indexeddb|cookie|browser storage/.test(text)
      ? "sandbox-storage"
      : "script-error";
  }
  function announceReady() {
    if (contentReady || !hasMeaningfulContent()) return;
    contentReady = true;
    send({ type: "runtime-ready" });
  }
  function reportRuntimeError(error, message, target) {
    var tag = target && typeof target.tagName === "string" ? target.tagName.toLowerCase() : "";
    var resource = target && target !== window && !!tag;
    // A required external script that never loaded is a bootstrap failure. Other
    // resource failures are non-critical by default; if they truly prevent paint,
    // the host's no-content timeout still supplies the blocking recovery state.
    var code = resource
      ? (tag === "script" ? "script-error" : "resource-error")
      : runtimeErrorCode(error, message);
    announceReady();
    var phase = contentReady ? "ready" : "loading";
    var key = code + ":" + phase;
    if (reported[key]) return;
    reported[key] = true;
    send({ type: "runtime-error", code: code, phase: phase });
  }
  window.addEventListener("error", function (event) {
    reportRuntimeError(event.error, event.message, event.target);
  }, true);
  window.addEventListener("unhandledrejection", function (event) {
    reportRuntimeError(event.reason, "", null);
  });
  window.addEventListener("DOMContentLoaded", announceReady);
  window.addEventListener("load", announceReady);
  try {
    if (typeof MutationObserver === "function") {
      var observer = new MutationObserver(function () {
        announceReady();
        if (contentReady) observer.disconnect();
      });
      observer.observe(window.document.documentElement, { childList: true, subtree: true });
    }
  } catch (_) { /* the lifecycle events remain as the compatibility path */ }

  function send(message) {
    message.source = "derive";
    if (ready) parent.postMessage(message, "*");
    else queued.push(message);
  }
  function flush() {
    ready = true;
    while (queued.length) parent.postMessage(queued.shift(), "*");
  }
  function request(type, key, data) {
    return new Promise(function (resolve, reject) {
      var requestId = "shared_" + Date.now().toString(36) + "_" + (++seq).toString(36);
      pending[requestId] = { resolve: resolve, reject: reject };
      send(Object.assign({ type: type, requestId: requestId, key: key }, data || {}));
    });
  }
  function notify(state) {
    state.listeners.slice().forEach(function (listener) {
      try { listener(state.value); } catch (_) { /* one view cannot break the others */ }
    });
  }
  function accept(key, value, version) {
    var state = states[key];
    if (!state || typeof version !== "number" || version <= state.version) return;
    state.value = value;
    state.version = version;
    notify(state);
  }
  function open(key) { return request("shared-open", key); }

  function shared(key, initial) {
    if (!keyPattern.test(key)) throw new Error("invalid shared-state key");
    if (states[key]) return states[key].handle;
    var state = { value: initial, version: 0, listeners: [], handle: null };
    var handle = {
      onChange: function (listener) {
        if (typeof listener !== "function") throw new Error("onChange requires a function");
        state.listeners.push(listener);
        listener(state.value);
        return function () {
          var at = state.listeners.indexOf(listener);
          if (at >= 0) state.listeners.splice(at, 1);
        };
      },
      add: function (value) {
        return request("shared-mutate", key, {
          mutation: { op: "add", initial: initial, value: value }
        });
      },
      update: function (id, patch) {
        return request("shared-mutate", key, {
          mutation: { op: "update", initial: initial, id: id, patch: patch }
        });
      },
      activity: function () { return request("shared-activity", key); }
    };
    Object.defineProperty(handle, "value", { get: function () { return state.value; } });
    state.handle = handle;
    states[key] = state;
    var readyRequest = open(key);
    Object.defineProperty(handle, "ready", { value: readyRequest, enumerable: true });
    // Keep the local initial value usable when nobody awaits readiness, while still
    // exposing the original rejected promise to apps that want an honest error state.
    readyRequest.catch(function () {});
    return handle;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.source !== "derive-host") return;
    if (data.type === "shared-ready") { flush(); return; }
    if (data.type === "shared-resync") {
      Object.keys(states).forEach(function (key) {
        open(key).catch(function () { /* the next resync or interaction can recover */ });
      });
      return;
    }
    if (data.type === "shared-updated") {
      accept(data.key, data.value, data.version);
      return;
    }
    if (data.type !== "shared-result" || !pending[data.requestId]) return;
    var call = pending[data.requestId];
    delete pending[data.requestId];
    if (!data.ok) {
      call.reject(new Error(data.error || "shared-state request failed"));
      return;
    }
    if (Array.isArray(data.activity)) {
      call.resolve(data.activity);
      return;
    }
    if (data.version > 0) accept(data.key, data.value, data.version);
    call.resolve(states[data.key] ? states[data.key].value : data.value);
  });

  root.shared = shared;
  root.increment = function (by) {
    if (typeof by !== "number" || !Number.isFinite(by)) throw new Error("increment requires a number");
    return { __derive_increment: by };
  };
  window.derive = root;
  window.dispatchEvent(new CustomEvent("derive-ready", { detail: root }));
})();`

/** A URL reference, not inline code: artifact HTML is cached immutably, while
 * this client uses a short cache so runtime fixes reach already-published work. */
export const SHARED_STATE_SCRIPT = `<script src="/raw/derive-shared.js"></script>`

/** Put the SDK before an artifact's own scripts without moving the existing
 * end-of-document anchor client (which needs the DOM to be fully parsed). */
const openingTagEnd = (html: string, name: "head" | "html"): number => {
  const source = html.toLowerCase()
  const token = `<${name}`
  for (let start = source.indexOf(token); start >= 0; start = source.indexOf(token, start + 1)) {
    const boundary = start + token.length
    const next = html.charCodeAt(boundary)
    if (next === 62) return boundary + 1 // >
    if (next !== 9 && next !== 10 && next !== 12 && next !== 13 && next !== 32) continue
    const end = html.indexOf(">", boundary + 1)
    return end < 0 ? -1 : end + 1
  }
  return -1
}

const doctypeEnd = (html: string): number => {
  const token = "<!doctype"
  const start = html.toLowerCase().indexOf(token)
  if (start < 0) return -1
  const end = html.indexOf(">", start + token.length)
  return end < 0 ? -1 : end + 1
}

export const injectSharedStateScript = (html: string): string => {
  const points = [openingTagEnd(html, "head"), openingTagEnd(html, "html"), doctypeEnd(html)]
  for (const at of points) {
    if (at >= 0) return `${html.slice(0, at)}${SHARED_STATE_SCRIPT}${html.slice(at)}`
  }
  return SHARED_STATE_SCRIPT + html
}
