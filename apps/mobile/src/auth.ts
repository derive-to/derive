// Signing in from the shell.
//
// THE PROBLEM. Google refuses OAuth from an embedded web view: since 2023 an
// authorization request whose user agent is a WKWebView or an Android WebView comes
// back as `disallowed_useragent`. It is deliberate anti-phishing policy, not a bug, and
// it is not something to work around by spoofing the user agent — that would defeat a
// control that exists to protect the person signing in, and it violates Google's terms.
// Derive has Google sign-in enabled in production, so a "Continue with Google" tap
// inside the shell's web view is a dead end unless it leaves the web view.
//
// THE FIX. Recognise a sign-in navigation and hand the WHOLE flow to a real browser
// (ASWebAuthenticationSession on iOS, Custom Tabs on Android) via
// `WebBrowser.openAuthSessionAsync`. Google accepts that agent, and the session closes
// itself when the browser reaches our return URL.
//
// THE HAND-OFF. The browser that completes the flow has its OWN cookie jar, so the
// session lands there and not in the web view's — on iOS those are genuinely separate
// stores and no client-side trick bridges them. So the browser mints a single-use token
// (Better Auth's one-time-token plugin), hands it back through the deep link, and the WEB
// VIEW spends it: because the web view makes that request, the Set-Cookie lands in the
// jar that needs it. Works for every sign-in method, not just the one that forced it.
//
// The nonce is what makes it safe to accept. A deep link can be fired by any web page, so
// without binding the round trip to a value THIS app generated, a crafted
// `derive://auth-callback?token=…` could sign the app into someone else's account. We
// generate a nonce, pass it in, and refuse any callback that does not echo it back.
//
// RESIDUAL RISK, stated plainly: a custom scheme is not exclusively ours. Another app on
// the device that registers `derive://` could intercept the callback and spend the token
// itself. The token is single-use and expires in two minutes, which bounds it, but the
// real fix is an https callback on a verified associated domain — available once the
// app-association files are actually served (they are not yet). Until then this is the
// same exposure every custom-scheme OAuth callback has carried.

/** Where the auth browser sends the user when it is done. Matching this closes the
 *  browser automatically instead of stranding it on a blank page. */
export const AUTH_RETURN_URL = "derive://auth-callback"

/** The deep-link host that means "the auth browser finished", as opposed to a link to
 *  content. Never a page to navigate the web view to. */
export const AUTH_CALLBACK_HOST = "auth-callback"

/** Same-origin paths that BEGIN a sign-in flow. Better Auth mounts social sign-in and
 *  the OAuth authorize endpoint under /api/auth; catching it at the start means the
 *  whole redirect chain happens in the real browser, rather than starting in the web
 *  view and being intercepted mid-flight at the provider. */
const AUTH_START_PATHS = [
  "/api/auth/sign-in/social",
  "/api/auth/signin",
  "/api/auth/oauth2/authorize",
  "/api/auth/callback",
]

/** Identity-provider hosts, as a safety net for a flow that reaches a provider without
 *  passing a path above (a provider-initiated login, or a redirect shape that changes).
 *  Being wrong here is cheap in one direction only: a missed host means the old dead
 *  end, an extra host just means sign-in opens in a browser, which is where it belongs. */
const IDP_HOSTS = [
  "accounts.google.com",
  "github.com",
  "login.microsoftonline.com",
  "appleid.apple.com",
]

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return null
  }
}

/** Does this navigation belong in a real browser rather than the app's web view?
 *
 *  `isOwn` says whether the url is on the origin we host, which the caller already
 *  knows; passing it keeps this module free of app config. */
export const isAuthNavigation = (url: string, isOwn: boolean): boolean => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (isOwn) {
    const path = parsed.pathname.replace(/\/+$/, "")
    return AUTH_START_PATHS.some((p) => path === p || path.startsWith(`${p}/`))
  }
  const host = parsed.host.toLowerCase()
  return IDP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

/** Is this deep link the auth browser reporting back, rather than a link to content? */
export const isAuthCallback = (link: string): boolean => hostOf(link) === AUTH_CALLBACK_HOST

/** A fresh nonce for one sign-in attempt. Shape matches what the web side will echo
 *  (`STATE_RE` in apps/web/src/lib/native-handoff.ts); keep the two in step. */
export const newAuthState = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

/** Where the shell sends the browser to sign in, carrying the nonce so the web side can
 *  echo it back on the callback. */
export const signInUrl = (webOrigin: string, state: string): string =>
  `${webOrigin}/login?native=${encodeURIComponent(state)}`

/**
 * The token to spend, from a callback deep link — or null to ignore the link.
 *
 * Null is the security-relevant answer: a callback whose nonce does not match the one
 * this app generated is not ours, and acting on it would sign the app into whatever
 * account minted the token. Missing token, missing state, or a mismatch all refuse.
 */
export const tokenFromCallback = (link: string, expectedState: string | null): string | null => {
  if (!expectedState) return null
  let parsed: URL
  try {
    parsed = new URL(link)
  } catch {
    return null
  }
  if (parsed.protocol !== "derive:" || parsed.host !== AUTH_CALLBACK_HOST) return null
  const token = parsed.searchParams.get("token")
  const state = parsed.searchParams.get("state")
  if (!token || !state) return null
  return state === expectedState ? token : null
}

/**
 * Script that spends the token from INSIDE the web view, which is the entire point: the
 * request has to come from the jar that needs the cookie.
 *
 * Same-origin fetch, so the response's Set-Cookie applies here; then a replace() so the
 * signed-in app loads without leaving the pre-auth page in history. The token is
 * JSON-encoded rather than interpolated raw, so a hostile value cannot break out of the
 * string literal.
 */
export const claimScript = (token: string, landing: string): string => `
(function () {
  fetch("/api/auth/one-time-token/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token: ${JSON.stringify(token)} })
  })
    .then(function (r) { if (!r.ok) throw new Error("handoff rejected: " + r.status) })
    .then(function () { window.location.replace(${JSON.stringify(landing)}) })
    .catch(function (e) {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: "auth-handoff-failed", message: String(e && e.message) })
      )
    })
})();
true;
`
