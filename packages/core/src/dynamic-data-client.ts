import { DYNAMIC_NAME_PATTERN } from "./dynamic-data"

/**
 * The in-frame half of a live dynamic-data update. The host (the app viewer) hears
 * `artifact.dynamic.updated` on its SSE stream, fetches the server-rendered fragment for
 * the shown version (the frame is an opaque origin and cannot read a gated artifact's
 * own data), and posts it here; this swaps the bound element's inner markup in place.
 * A leading authored `<caption>` is kept, matching the serve-time substitution, so the
 * page a reader sees after a swap is byte-for-byte what a fresh load would show.
 *
 * Only the parent window is trusted, only well-formed names are looked up, and the
 * markup comes from Derive's own renderer (already escaped), never from artifact code.
 */
export const DYNAMIC_DATA_CLIENT_JS = `;(() => {
  const NAME = new RegExp(${JSON.stringify(DYNAMIC_NAME_PATTERN)})
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return
    const d = event.data
    if (!d || d.source !== "derive-host" || d.type !== "dynamic-updated") return
    if (typeof d.name !== "string" || !NAME.test(d.name) || typeof d.html !== "string") return
    const attr = d.kind === "figure" ? "data-derive-figure" : "data-derive-table"
    const targets = document.querySelectorAll("[" + attr + "=\\"" + d.name + "\\"]")
    for (const el of targets) {
      const caption = attr === "data-derive-table" ? el.querySelector(":scope > caption") : null
      el.innerHTML = d.html
      if (caption) el.insertBefore(caption, el.firstChild)
    }
  })
})()
`

/** Short-cached like the other runtimes: published pages are immutable, runtimes are not. */
export const DYNAMIC_DATA_SCRIPT = '<script src="/raw/derive-dynamic.js"></script>'
