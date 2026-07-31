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
// WHAT IS STILL MISSING, deliberately. The browser that completes the flow has its OWN
// cookie jar: the session lands there, not in the web view's. Bridging the two needs a
// short-lived single-use token exchanged for a Set-Cookie on a request the WEB VIEW
// makes. That endpoint does not exist yet, it is security-sensitive, and it is not
// written here so that it can be built with tests and reviewed rather than guessed at.
// So: this module makes Google STOP REJECTING the flow, and the session hand-off is the
// remaining half. See apps/mobile/README.md.

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
