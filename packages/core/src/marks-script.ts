import { LANDMARK_TAGS } from "./doc-text"

// The "marked" render overlay: numbered badges on a page's top-level landmark
// regions, so an agent's visual read (the render rung) lines up with the SAME @N
// refs its page map and `read(section:"@N")` already use — see doc-text.ts's
// landmarkMap/landmarkSlice. The tag list is IMPORTED from there (LANDMARK_TAGS),
// not hand-duplicated, so the two numberings cannot drift apart; only the "top-level,
// fold nested" walk is reimplemented here, necessarily, as a DOM traversal (layout
// only exists client-side) rather than the server's string tokenizer.
//
// Query-param gated at serve time (never baked into a normal page load — zero cost
// or risk to a human viewer or an og:image unfurl); a plain, unminified IIFE, no
// build step, no dependency on the (unrelated) comment-anchor client.
const TAGS_JSON = JSON.stringify(LANDMARK_TAGS.map((t) => t.toUpperCase()))
export const MARKS_SCRIPT = `<script>
(function () {
  var TAGS = ${TAGS_JSON};
  if (!document.body) return;
  var all = document.body.querySelectorAll(TAGS.join(","));
  var n = 0;
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    // Skip a landmark nested inside another landmark — folded into its nearest
    // top-level ancestor, matching the server's region map exactly.
    var p = el.parentElement, nested = false;
    while (p) {
      if (TAGS.indexOf(p.tagName) !== -1) { nested = true; break; }
      p = p.parentElement;
    }
    if (nested) continue;
    n++;
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    var badge = document.createElement("div");
    badge.textContent = "@" + n;
    badge.setAttribute(
      "style",
      "position:absolute;top:4px;left:4px;z-index:2147483647;" +
        "background:#111;color:#fff;font:700 12px/1.4 monospace;" +
        "padding:1px 6px;border-radius:3px;pointer-events:none;opacity:.9;"
    );
    el.insertBefore(badge, el.firstChild);
  }
})();
</script>`
