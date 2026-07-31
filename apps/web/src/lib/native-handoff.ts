// Handing a signed-in session back to the native shell.
//
// The shell cannot run sign-in inside its own web view: Google refuses OAuth from an
// embedded user agent (`disallowed_useragent`), which is deliberate anti-phishing policy.
// So the app opens a REAL browser, and this page is what that browser lands on. The
// browser has its own cookie jar, so the session it just created would be stranded there
// unless something carries it back — that is what this module is.
//
// The app puts a one-time nonce in the URL (`?native=<state>`); we echo it back on the
// callback so the app can tell ITS flow apart from a crafted link. Without that binding a
// malicious page could fire `derive://auth-callback?token=…` at the app and sign it into
// an attacker's account.

/** The deep link the app is listening on. Custom scheme, because that is what an auth
 *  session can be told to watch for. */
const CALLBACK = "derive://auth-callback"

/** Nonces we will echo. Deliberately strict: the value goes straight into a URL we
 *  navigate to, and it arrives from the query string, so it is untrusted input. Anything
 *  that is not a plain opaque token is ignored rather than sanitised. */
const STATE_RE = /^[A-Za-z0-9_-]{8,128}$/

/** The app's nonce for this sign-in, or null if this is an ordinary web visit.
 *  `search` is passed in so this stays pure and testable. */
export const nativeState = (search: string): string | null => {
  const raw = new URLSearchParams(search).get("native")
  return raw && STATE_RE.test(raw) ? raw : null
}

/** Where to send the browser once the token is minted. The token is single-use and
 *  expires in two minutes (the oneTimeToken plugin), so its life in a URL is measured in
 *  the time it takes the app to spend it. */
export const nativeCallbackUrl = (token: string, state: string): string =>
  `${CALLBACK}?token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`
