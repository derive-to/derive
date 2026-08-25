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
    request("shared-open", key).catch(function () { /* initial remains usable offline */ });
    return handle;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.source !== "derive-host") return;
    if (data.type === "shared-ready") { flush(); return; }
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
export const injectSharedStateScript = (html: string): string => {
  const points = [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype[^>]*>/i]
  for (const pattern of points) {
    const match = pattern.exec(html)
    if (match?.index !== undefined) {
      const at = match.index + match[0].length
      return `${html.slice(0, at)}${SHARED_STATE_SCRIPT}${html.slice(at)}`
    }
  }
  return SHARED_STATE_SCRIPT + html
}
