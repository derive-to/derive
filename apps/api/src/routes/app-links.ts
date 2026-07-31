import { Hono } from "hono"

/**
 * App-association files: the two documents that let a derive.to link open the NATIVE app
 * instead of a browser tab.
 *
 * This is what "tap a Derive link in Slack and land in the app" actually needs. iOS
 * fetches `/.well-known/apple-app-site-association` and Android fetches
 * `/.well-known/assetlinks.json` at install time; without them a universal link is just a
 * web link. Both are served UNAUTHENTICATED as plain JSON, which is required — the OS
 * fetches them with no session and refuses anything that is not `application/json`.
 *
 * Both are OPT-IN and off by default. A self-host has no app of its own, and publishing an
 * association for someone else's bundle id would hand that app the right to claim this
 * domain's links. So each file appears only once its identifiers are configured, and 404s
 * otherwise — the honest answer for an instance that has no app.
 *
 * NOTE the Slack caveat this does NOT fix: tapping a link inside Slack's in-app browser
 * still will not reach the app, because iOS does not honour universal links from inside a
 * web view. That path is covered on the web side by the "Open in Derive" bar
 * (apps/web/src/components/shared/open-in-app-bar.tsx). These files cover every other
 * entry: Messages, Mail, Notes, Slack's desktop client, and Slack set to open in Safari.
 */
export const appLinkRoutes = (opts: { appleAppId?: string; androidFingerprints?: string }) => {
  const app = new Hono()

  // `<TeamID>.<bundle id>`, e.g. ABCDE12345.to.derive.app.
  const appleAppId = opts.appleAppId?.trim()
  // Comma-separated SHA-256 signing-cert fingerprints of the release keystore.
  const fingerprints = (opts.androidFingerprints ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  // Content-Type matters as much as the body: iOS rejects an AASA served as anything
  // other than application/json, and the failure is silent (links just stay web links),
  // so it is set explicitly rather than left to a default.
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: {
        "content-type": "application/json",
        // Cached by Apple's CDN and the device; short enough that adding an app id or
        // rotating a key is not a day-long wait.
        "cache-control": "public, max-age=3600",
      },
    })

  app.get("/.well-known/apple-app-site-association", (c) => {
    if (!appleAppId) return c.notFound()
    return json({
      applinks: {
        // `details[].appIDs` is the modern shape; `apps: []` stays for older iOS.
        apps: [],
        details: [
          {
            appIDs: [appleAppId],
            // Everything on the domain EXCEPT the raw artifact bytes and the API. Those
            // are fetched, not navigated to, and claiming them would send a background
            // asset request into the app. `?` and `*` are AASA wildcards.
            components: [
              { "/": "/raw/*", exclude: true, comment: "artifact bytes, never a navigation" },
              { "/": "/api/*", exclude: true, comment: "API surface" },
              { "/": "/.well-known/*", exclude: true, comment: "association files themselves" },
              { "/": "/*" },
            ],
          },
        ],
      },
    })
  })

  app.get("/.well-known/assetlinks.json", (c) => {
    if (fingerprints.length === 0) return c.notFound()
    // Android's shape is a LIST of statements; the package name is carried in the target.
    return json([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "to.derive.app",
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ])
  })

  return app
}
