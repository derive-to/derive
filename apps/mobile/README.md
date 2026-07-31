# @derive/mobile

The native shell. It hosts the existing web app (`apps/web`) in a web view and adds the
things a browser tab cannot do. **It is not a second front end**: there are no screens
here that exist on the web, and there should not be. A web deploy reaches phones with no
app release, which is the entire reason for this shape.

## Running it

You do **not** need Xcode or Android Studio to try this. Expo Go on your own phone is
enough:

```bash
cd apps/mobile
npm install
npm start        # scan the QR with the Camera app (iOS) or Expo Go (Android)
```

To point it at a local stack instead of production, change `extra.webOrigin` in
`app.json` to your machine's LAN address (not `localhost` — that resolves to the phone).

Xcode / Android Studio only become necessary for a **dev build**, which is what the
later phases need: push notifications and the share extension cannot run in Expo Go.

## Not a workspace member

`apps/mobile` is excluded from `pnpm-workspace.yaml` and keeps its own `package-lock.json`.
React Native wants a hoisted `node_modules`, and the usual fix (`node-linker=hoisted`) is
repo-wide: it would change resolution for the API and the web app to suit Metro. The
shell needs nothing from the workspace — it reaches the API over HTTP and loads the web
app over HTTPS — so isolating it costs nothing and keeps the monorepo's install strategy
untouched. Run `npm`, not `pnpm`, in this directory.

## Layout

| File | What |
| --- | --- |
| `app/_layout.tsx` | Root layout. One screen today. |
| `app/index.tsx` | The screen: the hosted web app, plus deep-link entry (cold start included). |
| `src/web-stage.tsx` | The web view host: external-link interception, boot timeout, failure and retry. |
| `src/links.ts` | Deep-link resolution. **Pure and security-relevant** — see below. |
| `src/config.ts` | Binds `links.ts` to the running app's config. |
| `src/theme.ts` | The colour tokens, mirrored from `apps/web/src/styles/globals.css`. |

## The two things to be careful about

**1. `ALLOWED_ORIGINS` is a security boundary, not a convenience.** A native web view has
no equivalent of the iframe `sandbox` attribute, so untrusted author HTML must never
share an origin with the app. Hosting the SPA preserves the containment the web already
has, because an artifact still renders inside the web app's own sandboxed iframe. **Do
not add a raw-artifact-bytes origin to that list.**

**2. A deep link is untrusted input** that decides what the frame shows. `links.ts`
refuses anything that does not resolve to an allowed origin, so
`derive://open?url=https://evil.example` and a `javascript:` payload are both ignored, as
is a suffix lookalike like `derive.to.evil.example`. That logic is deliberately pure and
Expo-free so it can be exercised directly. There is no test runner in this package yet;
add one with the first substantial screen and port those cases into it.

## Deliberately not built yet

- **The native tab bar.** It needs a device to get right, and the mechanism that keeps a
  tab switch from reading as a page load (driving the SPA's client-side router rather
  than reloading the web view) is something to try rather than reason about.
- **Push, deep-link association files, the share extension.** All need an Apple Developer
  account and EAS credentials.

## Sign-in

Google refuses OAuth from an embedded web view (`disallowed_useragent`), and Derive has
Google sign-in enabled in production, so a "Continue with Google" tap inside the web view
would be a dead end. Do **not** "fix" that by spoofing the web view's user agent: the
policy protects the person signing in, and defeating it violates Google's terms.

The flow, end to end:

1. A sign-in navigation is recognised (`isAuthNavigation`) and never loads in the web view.
2. The app generates a **nonce** and opens `/login?native=<nonce>` in a **real browser**
   (`openAuthSessionAsync`), which Google accepts.
3. The person signs in there by any method: Google, password, passkey, enterprise OIDC.
4. The web app sees `?native=`, mints a **single-use token** for the session it just
   created (Better Auth's `oneTimeToken` plugin), and bounces to
   `derive://auth-callback?token=…&state=<nonce>`.
5. The app checks the nonce is the one **it** generated, then injects a same-origin
   `fetch` into the **web view** that spends the token. Because the web view makes that
   request, the `Set-Cookie` lands in the jar that needs it.

**Why the nonce matters.** Any web page can fire a deep link. Without binding the round
trip to a value this app generated, a crafted `derive://auth-callback?token=…` would sign
the app into whoever minted that token. `tokenFromCallback` refuses a callback whose state
does not match, and that refusal is covered by tests.

**Why single-use matters.** The token rides in a URL for a moment. Verify goes through
`consumeVerificationValue`, so a replayed token finds nothing, and `storeToken: "hashed"`
means a leaked verification row is not a usable credential. Both are pinned by
`apps/api/test/native-handoff.test.ts` — if the plugin is ever swapped for a stateless
signed token, those tests are what should stop it.

**Residual risk, stated plainly.** A custom scheme is not exclusively ours: another app on
the device registering `derive://` could intercept the callback and spend the token. It is
single-use and expires in two minutes, which bounds the window, but the real fix is an
https callback on a verified associated domain. That needs the app-association files to be
served, which is Phase 4 and does not exist yet. Until then this carries the same exposure
every custom-scheme OAuth callback has.
