import { randomId } from "./random-id"
import { STORAGE_KEYS } from "./storage-keys"

// A stable, per-browser anonymous identity for realtime presence — generated once, kept in
// localStorage, and sent EXPLICITLY on every realtime call (the SSE connect `?g=`, the
// presence heartbeat, and cursor frames). This is the SOTA model (PartyKit/Liveblocks: the
// client fixes its own connection identity): because one browser carries ONE token across
// all of a page's concurrent requests, an anonymous viewer can never fan out into several
// phantom "viewing now" rows — which a server-minted cookie, set on one request but not yet
// echoed on the sibling requests it races, cannot guarantee. The token is opaque and
// non-authoritative: the server derives the display handle from it and the viewer's role
// from real auth, so choosing a token grants nothing. Signed-in viewers still show up by
// their account, so this only ever names an anonymous one.
let cached = ""

export function getGuestId(): string {
  if (cached) return cached
  // Prerender/SSR has no browser identity and never opens a realtime connection.
  if (typeof window === "undefined") return ""
  const fresh = () => `g_${randomId()}`
  try {
    // `||` not `??`: a stored empty string is corrupt, not an identity — regenerate it,
    // else we'd send `?g=` empty forever and fall back into the very cookie race this fixes.
    cached = localStorage.getItem(STORAGE_KEYS.guestId) || fresh()
    localStorage.setItem(STORAGE_KEYS.guestId, cached)
  } catch {
    // Storage blocked (private mode / hardened settings): fall back to an in-memory id.
    // Still ONE identity for this tab's lifetime, so it stays a single presence row.
    cached = fresh()
  }
  return cached
}

// The `?g=` fragment carrying this browser's guest token to a realtime endpoint. Empty
// when there's no browser identity (SSR) — the server then falls back to the view cookie.
export function guestQuery(): string {
  const id = getGuestId()
  return id ? `?g=${encodeURIComponent(id)}` : ""
}

// The server's `guestViewerId` transform (apps/api context.ts), mirrored byte-for-byte:
// strip everything outside [A-Za-z0-9_-], cap at 40, prefix `anon_`. Kept as a mirror rather
// than a shared import because the client bundle must not pull in server/core code at runtime
// (same convention as parse-ref.ts mirroring core's parseRef). Exported pure so a unit test
// can pin it against the server's own test without needing a DOM.
export function namespaceGuest(token: string): string {
  return `anon_${token.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)}`
}

// This browser's OWN row in the presence roster, so an anonymous viewer can recognise itself
// ("(you)") and be filtered out of "others viewing" — a signed-in viewer uses their user id
// instead. MUST byte-match what the server broadcasts (hence namespaceGuest above). Only
// possible at all because the client now owns the token — an httpOnly cookie id could never
// be read here, which is why anon self-recognition wasn't possible before.
export function guestPresenceId(): string {
  return namespaceGuest(getGuestId())
}
