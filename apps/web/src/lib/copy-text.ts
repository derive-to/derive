/**
 * Copy text to the clipboard, on every origin the app can be served from.
 *
 * `navigator.clipboard` is SECURE-CONTEXT ONLY. On https and localhost it exists; on plain
 * http to a hostname or a LAN IP it is `undefined`. That is a real way to reach Derive: a
 * self-host on an internal network, or a phone pointed at a laptop. There, every copy in
 * the app either showed "Couldn't copy to clipboard" or did nothing at all.
 *
 * Doing nothing was the worse one, and it hid in plain sight:
 *
 *     navigator.clipboard?.writeText(url).then(ok).catch(fallback)
 *
 * reads like it degrades gracefully, but optional chaining short-circuits the WHOLE chain
 * — when `clipboard` is undefined the `.catch(fallback)` never runs. The fallback written
 * for exactly this case was unreachable.
 *
 * So this does not just report failure better, it succeeds: `execCommand("copy")` is
 * deprecated but is not secure-context gated and still works everywhere that matters.
 * Returns whether the text actually landed, so callers can say so honestly.
 */
export async function copyText(text: string): Promise<boolean> {
  // The modern path, wherever the browser will give it to us.
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied, or a non-user-gesture call. Fall through and try the old way.
    }
  }
  if (typeof document === "undefined") return false
  // The pre-Clipboard-API route: a selected textarea plus execCommand. Off-screen rather
  // than `display:none`, because a hidden element cannot hold a selection. `readOnly`
  // keeps the mobile keyboard from popping up on focus.
  const ta = document.createElement("textarea")
  ta.value = text
  ta.setAttribute("readonly", "")
  ta.style.position = "fixed"
  ta.style.top = "-9999px"
  ta.style.opacity = "0"
  document.body.appendChild(ta)
  try {
    ta.select()
    ta.setSelectionRange(0, text.length)
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    ta.remove()
  }
}
