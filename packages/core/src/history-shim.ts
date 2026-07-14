// Back-button hygiene for ISOLATED per-artifact origins (the [Q1] capability
// grant): with `allow-same-origin`, an artifact's client-side router really can
// call history.pushState — which is exactly right when the artifact is open as
// its own top-level tab, and exactly wrong when it's EMBEDDED in someone's page:
// every in-iframe navigation would push onto the PARENT tab's history, so the
// reader's Back button walks the artifact's route stack instead of leaving the
// page they're on. The standard mitigation (what preview hosts converge on):
// inside a frame, downgrade pushState to replaceState — the app's routing keeps
// working (URL state, popstate handlers, its own in-page back links), it just
// stops growing the embedder's history. Top-level, nothing is touched.
//
// Injected at serve time only on isolated-origin responses (see serve-content.ts);
// a plain, unminified IIFE like MARKS_SCRIPT — no build step, no dependencies.
export const HISTORY_SHIM = `<script data-derive-history-shim>
(function () {
  if (window.top === window.self) return;
  var replace = history.replaceState.bind(history);
  history.pushState = function (state, title, url) {
    return replace(state, title, url);
  };
})();
</script>`
