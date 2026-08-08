// The `?use=1` deferred-copy flag rides a shareable URL, and a copy that fired on
// any GET navigation would let a pasted link write into the clicker's workspace.
// The CLICK is what authorizes the copy — so the click leaves a same-tab marker
// here, and the artifact page fires only when the URL flag and the marker agree
// on the artifact. sessionStorage survives the login round-trip in the same tab
// (external OAuth hops included) and never travels with a shared link.

const KEY = "derive:use-intent"

export const markUseIntent = (shortId: string): void => {
  try {
    sessionStorage.setItem(KEY, shortId)
  } catch {
    // Storage unavailable (private modes, hardened settings): the flag then never
    // fires and the visitor simply lands on the page as a reader.
  }
}

/** Consume the marker. True only for the artifact the click was on. */
export const takeUseIntent = (shortId: string): boolean => {
  try {
    if (sessionStorage.getItem(KEY) !== shortId) return false
    sessionStorage.removeItem(KEY)
    return true
  } catch {
    return false
  }
}
