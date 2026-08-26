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
  var booting = true;

  function runtimeErrorCode(error, message) {
    var text = String(message || (error && error.message) || "").toLowerCase();
    return /localstorage|sessionstorage|indexeddb|cookie|browser storage/.test(text)
      ? "sandbox-storage"
      : "script-error";
  }
  function reportBootError(error, message) {
    if (!booting) return;
    send({ type: "runtime-error", code: runtimeErrorCode(error, message) });
  }
  window.addEventListener("error", function (event) {
    reportBootError(event.error, event.message);
  });
  window.addEventListener("unhandledrejection", function (event) {
    reportBootError(event.reason, "");
  });
  window.addEventListener("load", function () { booting = false; });

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
  function optimisticMine(state, slot, value) {
    var beforeValue = state.value;
    var beforeMine = state.mine;
    var token = {};
    var next = Array.isArray(state.value) ? state.value.slice() : [];
    var nextMine = Object.assign(Object.create(null), state.mine);
    var id = nextMine[slot];
    var at = -1;
    for (var i = 0; id && i < next.length; i++) {
      if (next[i] && next[i].id === id) { at = i; break; }
    }
    if (value === null) {
      if (at >= 0) next.splice(at, 1);
      delete nextMine[slot];
    } else {
      if (!id) id = "optimistic_" + Date.now().toString(36) + "_" + (++seq).toString(36);
      var item = Object.assign({}, value, { id: id });
      if (at >= 0) next[at] = item;
      else next.push(item);
      nextMine[slot] = id;
    }
    state.optimistic[slot] = token;
    state.value = next;
    state.mine = nextMine;
    notify(state);
    return {
      finish: function () {
        if (state.optimistic[slot] === token) delete state.optimistic[slot];
      },
      rollback: function () {
        if (state.optimistic[slot] !== token) return;
        delete state.optimistic[slot];
        state.value = beforeValue;
        state.mine = beforeMine;
        notify(state);
      }
    };
  }
  function accept(key, value, version, mine) {
    var state = states[key];
    if (!state || typeof version !== "number" || version < state.version) return;
    if (mine && typeof mine === "object" && !Array.isArray(mine)) state.mine = mine;
    if (version === state.version) return;
    state.value = value;
    state.version = version;
    notify(state);
  }
  function open(key) { return request("shared-open", key); }

  function shared(key, initial) {
    if (!keyPattern.test(key)) throw new Error("invalid shared-state key");
    if (states[key]) return states[key].handle;
    var state = { value: initial, version: 0, mine: Object.create(null), optimistic: Object.create(null), listeners: [], handle: null };
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
      setMine: function (slot, value) {
        if (typeof slot !== "string" || !slot.length || slot.length > 128)
          throw new Error("mine slot must be a 1-128 character string");
        if (value !== null && (!value || typeof value !== "object" || Array.isArray(value)))
          throw new Error("setMine value must be an object or null");
        var optimistic = optimisticMine(state, slot, value);
        return request("shared-mutate", key, {
          mutation: { op: "set_mine", initial: initial, slot: slot, value: value }
        }).then(function (result) {
          optimistic.finish();
          return result;
        }, function (error) {
          optimistic.rollback();
          open(key).catch(function () { /* a later resync can still recover */ });
          throw error;
        });
      },
      mine: function (slot) {
        var id = state.mine[slot];
        if (!id || !Array.isArray(state.value)) return null;
        for (var i = 0; i < state.value.length; i++) {
          if (state.value[i] && state.value[i].id === id) return state.value[i];
        }
        return null;
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
      accept(data.key, data.value, data.version, data.mine);
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
    if (data.version >= 0) accept(data.key, data.value, data.version, data.mine);
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
