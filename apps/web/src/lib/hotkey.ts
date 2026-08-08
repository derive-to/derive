/**
 * May a BARE key (no modifier) act as a page shortcut right now?
 *
 * Every page-level hotkey has the same four ways to be wrong, and each call site
 * that spelled the guard by hand got a different one of them wrong: firing while
 * someone types (form fields AND contentEditable — the comment composer, the
 * CodeMirror source editor and the inline editor are all contentEditable, so a
 * tagName test alone lets "c" toggle the comments panel mid-sentence), firing
 * underneath an open dialog, double-firing on key repeat, and re-running an action a
 * layer above already handled (Radix binds Escape on document with capture and calls
 * preventDefault WITHOUT stopping propagation, so `defaultPrevented` is the only
 * signal that a dialog already consumed the press).
 *
 * Modifier chords (⌘S, ⌘K) are a different contract — they are meant to work while
 * typing — so they check what they need themselves rather than coming through here.
 *
 * An open dropdown menu or listbox blocks bare keys the same way a dialog does:
 * Radix menus typeahead on printable characters, so a bare key pressed "into" a
 * menu belongs to the menu, not the page.
 */
export const bareHotkey = (e: KeyboardEvent): boolean => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return false
  const el = e.target as HTMLElement | null
  if (el && (/^(input|textarea|select)$/i.test(el.tagName) || el.isContentEditable)) return false
  if (document.querySelector('[role="dialog"],[role="menu"],[role="listbox"]')) return false
  return true
}
