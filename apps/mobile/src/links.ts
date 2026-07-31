// Deep-link resolution. Pure on purpose: no Expo, no React, no globals, so it can be
// exercised directly. This is the shell's one piece of security-relevant logic, because
// a deep link is an UNTRUSTED input that decides what the app frame shows.

/** Origin of a url, or null if it will not parse. */
export const originOf = (url: string): string | null => {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

/** May the web view navigate to `url` in place? Unknown or unparseable targets are
 *  external, which is the safe default: the worst case is a link opening in the system
 *  browser rather than in the frame. */
export const isInternal = (url: string, allowed: readonly string[]): boolean => {
  const origin = originOf(url)
  return origin !== null && allowed.includes(origin)
}

/**
 * Map an incoming deep link to the web url the shell should show, or null to ignore it.
 *
 * The web side hands over a WHOLE https url (`derive://open?url=<encoded>`) so routing
 * knowledge stays on the web and a new route needs no app release. A bare
 * `derive://artifacts/abc` is also accepted for hand-written links.
 *
 * The null cases are the point: anything that does not resolve to an allowed origin is
 * refused, so `derive://open?url=https://evil.example` cannot steer the frame, and a
 * `javascript:` payload cannot ride in on the `url` parameter.
 */
export const webUrlFromDeepLink = (
  link: string,
  webOrigin: string,
  allowed: readonly string[],
): string | null => {
  let parsed: URL
  try {
    parsed = new URL(link)
  } catch {
    return null
  }

  // An https link (a universal link the OS routed to us) is taken at face value, but
  // still only if we host that origin.
  if (parsed.protocol !== "derive:") return isInternal(link, allowed) ? link : null

  const passed = parsed.searchParams.get("url")
  if (passed) return isInternal(passed, allowed) ? passed : null

  // Bare form. `new URL` splits the remainder across host and pathname depending on how
  // many slashes followed the scheme, so join them and strip the separator.
  const path = `${parsed.host}${parsed.pathname}`.replace(/^\/+/, "")
  if (!path || path === "open") return webOrigin
  return `${webOrigin}/${path}`
}
