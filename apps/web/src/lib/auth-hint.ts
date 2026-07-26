import { STORAGE_KEYS } from "./storage-keys"

// A per-browser, NON-authoritative hint of whether the last resolved session was
// signed in. The server + the me() query are the only real authority; this steers
// ONLY the pre-paint boot frame (rail vs chrome-light) so a returning user's cold
// load reserves the right shape and doesn't pop when me() resolves. Stale at worst
// (a since-expired session) → one self-correcting frame, never an access decision.
export const readAuthHint = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEYS.authed) === "1"
  } catch {
    return false
  }
}

export const writeAuthHint = (authed: boolean): void => {
  try {
    if (authed) localStorage.setItem(STORAGE_KEYS.authed, "1")
    else localStorage.removeItem(STORAGE_KEYS.authed)
  } catch {
    /* private mode / storage full — the hint just won't persist; boot falls back to bare */
  }
}
