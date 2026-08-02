// THE CONSUMER SIDE OF THE HEAD-START.
//
// A cold signed-in boot could not issue its first API request until the JS bundle had
// downloaded, parsed and hydrated: measured on the preview, /api/auth/get-session left
// the browser at 269ms and the library list at 297ms, on a document whose TTFB was 45ms.
// The list then took ~477ms, so first-card landed at ~790ms — with the network idle for
// the first third of it.
//
// So __root inlines a script in <head> (sibling to THEME_BOOT / BOOT_FRAME) that starts
// the boot's requests immediately, before any module loads, and parks the in-flight
// promises on `window.__deriveBoot` keyed by absolute URL. This module hands them to the
// api layer, which takes one INSTEAD of opening its own.
//
// It is a handoff of a real in-flight promise, not a cache hint: nothing here depends on
// the browser choosing to reuse a preload, which is the failure mode that made
// <link rel=prefetch> worthless for the artifact viewer (it re-downloaded every byte).
//
// WHEN AN ENTRY EXISTS (the head script's rules, mirrored by boot-fetch.test.ts):
//
//   auth hint | path            | search | /v1/bootstrap | the home list
//   ----------|-----------------|--------|---------------|---------------
//   absent    | any             | any    | no            | no
//   "1"       | chromeless      | any    | no            | no
//   "1"       | /               | ""     | yes           | yes
//   "1"       | /               | ?tag=x | yes           | no
//   "1"       | /favorites, …   | any    | yes           | no
//   "1"       | /artifacts/:ref | any    | yes           | no
//
// A stale hint (a session that expired since the last visit) makes the started requests
// 401 — which is exactly what the app's own requests would have done, and the route
// guard redirects to /login off the session read either way.
//
// The list is started only for the bare home URL because that is the one request whose
// URL is knowable before the router exists. Any search param means a narrowed list, and
// guessing its URL wrong would cost a wasted request and buy nothing.

type BootMap = Record<string, Promise<Response> | undefined>

declare global {
  interface Window {
    __deriveBoot?: BootMap
  }
}

/** Take the head-started response for `url`, or null if there is none. Consumes the
 *  entry, so a refetch of the same key always opens a fresh request — a boot response
 *  is a point-in-time answer, and serving it twice would silently pin stale data.
 *
 *  GET only, and only for a request that carries no body/method of its own: the head
 *  script starts plain credentialed GETs, so anything else is a different request that
 *  merely shares a URL. */
export function takeBootResponse(url: string, init?: RequestInit): Promise<Response> | null {
  if (typeof window === "undefined") return null
  const map = window.__deriveBoot
  if (!map) return null
  if (init?.method && init.method !== "GET") return null
  if (init?.body) return null
  const hit = map[url]
  if (!hit) return null
  delete map[url]
  // A started request that failed at the network layer must not become the caller's
  // error — fall through to a normal fetch, which is what would have happened anyway.
  return hit.catch(() => fetch(url, init))
}

/** Drop whatever the app never claimed. An unconsumed entry means the head script's URL
 *  and the api client's URL disagree (boot-fetch.test.ts is there to catch that before
 *  it ships); releasing the Response keeps a mismatch from also being a leak. */
export function releaseUnclaimedBootResponses(): void {
  if (typeof window === "undefined") return
  window.__deriveBoot = undefined
}
