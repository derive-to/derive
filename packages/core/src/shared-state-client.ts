/**
 * The deliberately tiny authoring surface for persistent mini-app state. It is
 * injected near the start of embedded artifact HTML so an artifact's own scripts
 * can call `derive.shared(...)` synchronously. Authentication stays in the host:
 * this opaque-origin client only speaks postMessage.
 */
import { prependArtifactHead } from "@aniraga/open-artifact-protocol/source"
import { SHARED_COLLECTION_CLIENT_JS } from "./shared-collection-client.gen"

export const SHARED_STATE_CLIENT_JS = `(function () {
  ${SHARED_COLLECTION_CLIENT_JS}
  var root = window.derive;
  if (!root || (typeof root !== "object" && typeof root !== "function")) root = {};
  if (typeof root.shared === "function") return;
  var queued = [];
  var ready = false;
  var contentReady = false;
  var reported = Object.create(null);
  var iframeStates = typeof WeakMap === "function" ? new WeakMap() : null;
  var watchedIframes = typeof WeakSet === "function" ? new WeakSet() : null;

  function setIframeState(element, state) {
    if (!element) return;
    if (iframeStates) iframeStates.set(element, state);
    else element.__deriveIframeState = state;
  }
  function iframeState(element) {
    return iframeStates ? iframeStates.get(element) : element.__deriveIframeState;
  }
  function watchIframe(element) {
    if (!element) return;
    var watched = watchedIframes ? watchedIframes.has(element) : element.__deriveIframeWatched;
    if (watched) return;
    if (watchedIframes) watchedIframes.add(element);
    else element.__deriveIframeWatched = true;
    element.addEventListener("load", function () {
      setIframeState(element, "loaded");
      announceReady();
    });
    element.addEventListener("error", function () {
      setIframeState(element, "failed");
    });
  }

  // The load event is too late to be the only readiness signal. Image error handlers run
  // while the document is still loading, after an app may already have painted a
  // complete table or dashboard. Treat an explicit author marker, visible rich content,
  // or a non-trivial visible body as meaningful so an optional failure cannot hide a
  // usable artifact behind the host's startup card. Hidden nodes and source text never
  // count: they give the viewer nothing usable to preserve.
  function isVisiblyRendered(element, allowUnpaintedMedia) {
    if (!element || element.hidden) return false;
    try {
      var elementRect = typeof element.getBoundingClientRect === "function"
        ? element.getBoundingClientRect() : null;
      var current = element;
      while (current) {
        if (current.hidden ||
            (current.getAttribute && current.getAttribute("aria-hidden") === "true")) return false;
        var tag = String(current.tagName || "").toLowerCase();
        if (tag === "details" && !current.open) {
          var summary = current.querySelector && current.querySelector(":scope > summary");
          if (!summary || (element !== summary && !(summary.contains && summary.contains(element))))
            return false;
        }
        if (typeof window.getComputedStyle === "function") {
          var style = window.getComputedStyle(current);
          if (style && (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            Number(style.opacity) <= 0
          )) return false;
          var clips = style && /hidden|clip|scroll|auto/.test(
            String(style.overflow || "") + " " +
            String(style.overflowX || "") + " " + String(style.overflowY || "")
          );
          if (clips && typeof current.getBoundingClientRect === "function") {
            var clipRect = current.getBoundingClientRect();
            if (Number(clipRect.width || 0) <= 0 || Number(clipRect.height || 0) <= 0)
              return false;
            if (elementRect && (
              elementRect.right <= clipRect.left || elementRect.left >= clipRect.right ||
              elementRect.bottom <= clipRect.top || elementRect.top >= clipRect.bottom
            )) return false;
          }
        }
        var rootNode = !current.parentElement && current.getRootNode
          ? current.getRootNode() : null;
        current = current.parentElement || (rootNode && rootNode.host) || null;
      }
      var mediaTag = String(element.tagName || "").toLowerCase();
      var optimisticMedia = !!allowUnpaintedMedia && (mediaTag === "img" || mediaTag === "svg");
      if (typeof element.getClientRects === "function") {
        var rects = element.getClientRects();
        if (!rects.length && !optimisticMedia) return false;
        var hasArea = false;
        for (var r = 0; r < rects.length; r += 1) {
          if (Number(rects[r].width || 0) > 0 && Number(rects[r].height || 0) > 0) {
            hasArea = true;
            break;
          }
        }
        if (!hasArea && !optimisticMedia) return false;
      }
      if (mediaTag === "img" && !optimisticMedia &&
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
  function watchRuntimeIframes() {
    var doc = window.document, body = doc && doc.body;
    if (!body) return;
    var roots = runtimeRoots(body);
    for (var r = 0; r < roots.length; r += 1) {
      var frames = roots[r].querySelectorAll ? roots[r].querySelectorAll("iframe") : [];
      for (var i = 0; i < Number(frames.length || 0); i += 1) watchIframe(frames[i]);
    }
  }
  function meaningfulSrcdoc(source) {
    var html = String(source || "");
    if (!html.trim()) return false;
    var withoutCode = html
      .replace(/<!--[\\s\\S]*?-->/g, "")
      .replace(/<(script|style)\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>/gi, "");
    var text = withoutCode
      .replace(/<!doctype[^>]*>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&(?:nbsp|#160|#xa0);/gi, "")
      .replace(/\\s+/g, "");
    if (/<(table|canvas|svg|video|img|iframe)\\b/i.test(withoutCode)) return true;
    if (/<(h[1-6]|p|article|main|section|pre|ul|ol|dl|form|button)\\b/i.test(withoutCode))
      return text.length > 0;
    return text.length >= 80;
  }
  function meaningfulEmbeddedDocument(element) {
    try {
      var embedded = element.contentDocument;
      if (!embedded || !embedded.body) return null;
      var body = embedded.body;
      var markers = body.querySelectorAll ? body.querySelectorAll("[data-derive-ready]") : [];
      for (var m = 0; m < Number(markers.length || 0); m += 1) {
        if (isVisiblyRendered(markers[m])) return true;
      }
      var rich = body.querySelectorAll
        ? body.querySelectorAll("table,canvas,svg,video,img,iframe") : [];
      for (var i = 0; i < Number(rich.length || 0); i += 1) {
        // Authored image/SVG markup is optimistic content even when one media
        // payload fails or reports unusual geometry. CSS-hidden descendants still
        // fail the ancestor checks above; this only prevents a media oddity from
        // suppressing the rest of an otherwise loadable document.
        if (isVisiblyRendered(rich[i], true)) return true;
      }
      var visibleText = typeof body.innerText === "string" ? body.innerText : "";
      var text = String(visibleText).replace(/\\s+/g, "");
      var semantic = body.querySelectorAll
        ? body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,article,main,section,pre,ul,ol,dl,form,button") : [];
      for (var s = 0; s < Number(semantic.length || 0); s += 1) {
        if (text.length && isVisiblyRendered(semantic[s])) return true;
      }
      return text.length >= 80;
    } catch (_) {
      return null;
    }
  }
  function meaningfulIframe(element) {
    try {
      var srcdoc = element.getAttribute("srcdoc");
      if (srcdoc !== null) {
        var srcdocContent = meaningfulEmbeddedDocument(element);
        if (srcdocContent !== null) return srcdocContent;
        return iframeState(element) === "loaded" && meaningfulSrcdoc(srcdoc);
      }
      var rawSrc = element.getAttribute("src");
      var src = rawSrc === null ? "" : String(rawSrc).trim();
      if (!src || /^about:blank(?:[?#]|$)/i.test(src))
        return meaningfulEmbeddedDocument(element) === true;
      if (/^javascript:/i.test(src)) return false;
      if (iframeState(element) !== "loaded") return false;

      // Resource Timing Level 3 exposes same-origin iframe response status in
      // modern browsers. A completed error document has geometry and a load event,
      // but it is not authored content and must not unlock Ready.
      try {
        var entries = window.performance && typeof window.performance.getEntriesByName === "function"
          ? window.performance.getEntriesByName(element.src) : [];
        var entry = entries && entries.length ? entries[entries.length - 1] : null;
        var status = entry && Number(entry.responseStatus || 0);
        if (status && (status < 200 || status >= 400)) return false;
      } catch (_) { /* opaque successful frames are still eligible after load */ }

      // Same-origin frames are inspectable. Apply the normal meaningful-content
      // threshold so a short browser/server error page cannot masquerade as the
      // authored visualization. Cross-origin frames remain opaque and are judged
      // by their non-blank source plus painted geometry.
      var embeddedMeaningful = meaningfulEmbeddedDocument(element);
      return embeddedMeaningful === null ? true : embeddedMeaningful;
    } catch (_) {
      return iframeState(element) === "loaded";
    }
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
          ? roots[r].querySelectorAll("table,canvas,svg,video,img,iframe") : [];
        for (var i = 0; i < Number(rich.length || 0); i += 1) {
          var tag = String(rich[i] && rich[i].tagName || "").toLowerCase();
          if (tag === "iframe" && !meaningfulIframe(rich[i])) continue;
          if (isVisiblyRendered(rich[i], true)) { richContent = true; break; }
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
  function isPlatformScript(source) {
    var value = String(source || "");
    try {
      var fallback = "https://raw.derive.page/";
      var base = window.location && window.location.href ? window.location.href : fallback;
      var currentOrigin = window.location && window.location.origin
        ? window.location.origin : new URL(base).origin;
      var parsed = new URL(value, base);
      var platformPath = parsed.pathname === "/raw/derive-shared.js" ||
        parsed.pathname === "/raw/derive-client.js";
      var cloudflare = parsed.protocol === "https:" &&
        parsed.hostname === "static.cloudflareinsights.com" &&
        (parsed.pathname === "/beacon.min.js" || parsed.pathname.indexOf("/beacon.min.js/") === 0);
      return (parsed.origin === currentOrigin && platformPath) || cloudflare;
    } catch (_) {
      return false;
    }
  }
  function announceReady() {
    if (contentReady || !hasMeaningfulContent()) return;
    contentReady = true;
    send({ type: "runtime-ready" });
  }
  function reportRuntimeError(error, message, target, filename) {
    var tag = target && typeof target.tagName === "string" ? target.tagName.toLowerCase() : "";
    var resource = target && target !== window && !!tag;
    // These scripts are injected by Derive or its hosting edge, not supplied by the
    // artifact. Their failure may affect viewer chrome, but it is never an author error.
    // In particular, do not put a healthy script-free document behind a repair banner.
    var source = resource && target && typeof target.src === "string" ? target.src : filename;
    if (isPlatformScript(source)) return;
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
    var target = event && event.target;
    if (target && String(target.tagName || "").toLowerCase() === "iframe")
      setIframeState(target, "failed");
    reportRuntimeError(event.error, event.message, event.target, event.filename);
  }, true);
  window.addEventListener("unhandledrejection", function (event) {
    reportRuntimeError(event.reason, "", null);
  });
  window.addEventListener("DOMContentLoaded", announceReady);
  window.addEventListener("load", announceReady);
  try {
    if (typeof MutationObserver === "function") {
      var observer = new MutationObserver(function (records) {
        for (var r = 0; r < Number(records && records.length || 0); r += 1) {
          var record = records[r];
          if (record && record.type === "attributes" && record.attributeName === "src" &&
              String(record.target && record.target.tagName || "").toLowerCase() === "iframe")
            setIframeState(record.target, "loading");
        }
        watchRuntimeIframes();
        announceReady();
        if (contentReady) observer.disconnect();
      });
      observer.observe(window.document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class", "hidden", "aria-hidden", "open", "src", "srcdoc"]
      });
      watchRuntimeIframes();
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
  __deriveCollections.installCollections(flush);
})();`

/** A URL reference, not inline code: artifact HTML is cached immutably, while
 * this client uses a short cache so runtime fixes reach already-published work. */
export const SHARED_STATE_SCRIPT = `<script src="/raw/derive-shared.js"></script>`

/** Insert platform scripts before authored CSP and after a leading charset. */
export const injectArtifactRuntimeScripts = prependArtifactHead

export const injectSharedStateScript = (html: string): string =>
  injectArtifactRuntimeScripts(html, SHARED_STATE_SCRIPT)
