// Escaping a host app's in-app browser.
//
// Tapping a derive.to link inside Slack, Teams, LinkedIn or an in-app Gmail view does
// NOT reach the Derive app, even with universal links configured on the domain. Apple
// is explicit that a link opened in a WKWebView or SFSafariViewController opens the
// SITE rather than the app, and Slack for iOS routes taps through its own in-app
// browser by default. So the most common way a Derive link is shared, pasted into a
// channel, is exactly the path where universal links cannot fire.
//
// A CUSTOM SCHEME still escapes a web view where a universal link does not, so the
// page offers the hop itself: detect the embedded browser, show one quiet bar, and
// hand the current URL to the native app. Nothing here can tell whether the app is
// actually installed (no web API exposes that), so the bar is an offer, not a
// redirect — an automatic jump would strand everyone without the app on a dead scheme.
//
// This lives in the WEB app on purpose: it ships on deploy, with no app release, and
// it covers the installed PWA and plain mobile Safari at the same time.

/** The custom scheme the native shell registers. One entry point (`open`) taking the
 *  full https URL, so the app routes by pathname exactly as the web does and a new web
 *  route needs no matching app release. */
export const APP_SCHEME = "derive"

/** Host apps whose in-app browser swallows universal links. Matched against the user
 *  agent, which is the only signal available: these web views do not otherwise announce
 *  themselves. Deliberately a known-list rather than a heuristic — false positives show
 *  a pointless bar in a real browser, which is worse than missing an exotic one. */
const EMBEDDED_UA = [
  "slack", // Slack for iOS/Android, the case this exists for
  "microsoftteams",
  "linkedinapp",
  "fban", // Facebook for iOS
  "fbav",
  "instagram",
  "twitter",
  "line/",
  "wv", // Android System WebView's own marker
  "gsa/", // Google Search App's in-app browser
]

/** Real mobile OSes. The bar is meaningless on a desktop, where there is no app to
 *  open, so both this and an embedded web view must hold. */
const MOBILE_UA = ["iphone", "ipad", "ipod", "android"]

const has = (ua: string, needles: string[]) => needles.some((n) => ua.includes(n))

/** Is this a mobile in-app browser, where a universal link cannot reach the app?
 *  Takes the user agent so it stays pure and testable; callers pass navigator.userAgent. */
export const isEmbeddedMobileBrowser = (userAgent: string): boolean => {
  const ua = userAgent.toLowerCase()
  // Safari's own view of an iPad can claim macOS; the embedded check carries the weight
  // either way, so a missed iPad only costs a bar we would have shown.
  if (!has(ua, MOBILE_UA)) return false
  // An installed PWA or a real browser tab is not embedded, whatever else the UA says.
  return has(ua, EMBEDDED_UA)
}

/** The deep link that hands `url` to the native app. The whole https URL rides as a
 *  query parameter (encoded, so its own path and query survive), which keeps routing
 *  knowledge on the app side and out of this module. */
export const appDeepLink = (url: string): string =>
  `${APP_SCHEME}://open?url=${encodeURIComponent(url)}`

/** Is this page already running as an installed app (Home Screen PWA or the native
 *  shell's web view)? Standalone means there is nothing to escape to. `standalone` is
 *  Apple's non-standard flag on navigator, still the only signal on iOS. */
export const isStandalone = (): boolean => {
  try {
    if (window.matchMedia("(display-mode: standalone)").matches) return true
    return (navigator as Navigator & { standalone?: boolean }).standalone === true
  } catch {
    return false
  }
}
