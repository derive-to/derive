// Where the shell points, and what its web view is allowed to navigate to.
//
// The shell hosts the EXISTING web app rather than reimplementing it, so almost all of
// "the app" is whatever WEB_ORIGIN serves. That is the whole design: a web deploy
// reaches phones with no app release.
//
// The link logic itself lives in ./links (pure, no Expo) so it can be exercised
// directly; this module only binds it to the running app's config.

import Constants from "expo-constants"
import { isInternal as isInternalIn, webUrlFromDeepLink as resolveLink } from "./links"

/** The web app the shell hosts. Overridable through app.json's `extra` so a dev build
 *  can point at a laptop without editing source; falls back to production. */
export const WEB_ORIGIN: string =
  (Constants.expoConfig?.extra?.webOrigin as string | undefined) ?? "https://derive.to"

/**
 * Origins the web view may navigate to IN PLACE. Anything else opens in the system
 * browser, so a link to someone's blog can never take over the app frame and a phishing
 * page can never wear our chrome.
 *
 * NOTE: artifact bytes are served from their own registrable domain when origin
 * isolation is configured, and that separation is a SECURITY boundary, not a
 * convenience. A native web view has no equivalent of the iframe `sandbox` attribute,
 * so untrusted author HTML must never share an origin with the app. Hosting the SPA
 * preserves the containment the web already has, because an artifact still renders
 * inside the web app's own sandboxed iframe. Do not add a raw-bytes origin here.
 */
export const ALLOWED_ORIGINS: readonly string[] = [WEB_ORIGIN]

/** Should the web view handle this navigation itself? */
export const isInternal = (url: string): boolean => isInternalIn(url, ALLOWED_ORIGINS)

/** The web url an incoming deep link should show, or null to ignore it. */
export const webUrlFromDeepLink = (link: string): string | null =>
  resolveLink(link, WEB_ORIGIN, ALLOWED_ORIGINS)
