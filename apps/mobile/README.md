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
- **The session hand-off** (half of auth is done; see below).
- **Push, deep-link association files, the share extension.** All need an Apple Developer
  account and EAS credentials.

## Sign-in: what works and what is missing

Google refuses OAuth from an embedded web view (`disallowed_useragent`), and Derive has
Google sign-in enabled in production, so a "Continue with Google" tap inside the web view
would be a dead end. `src/auth.ts` fixes that half: a sign-in navigation is recognised and
handed to a **real browser** through `WebBrowser.openAuthSessionAsync`, which Google
accepts, and which closes itself when it reaches `derive://auth-callback`.

Do **not** "fix" this by spoofing the web view's user agent. The policy exists to protect
the person signing in, and defeating it violates Google's terms.

**The remaining half is the session hand-off.** The browser that completes the flow has
its own cookie jar, so the session lands there and not in the web view's. On iOS these
are genuinely separate stores (`ASWebAuthenticationSession` shares with Safari, the web
view uses `NSHTTPCookieStorage`), so no client-side trick bridges them. The fix is a
small server endpoint:

1. When the flow starts from the app, the OAuth callback redirects to
   `derive://auth-callback?token=<one-time>`.
2. The app navigates the **web view** to `/api/auth/session-from-token?token=…`.
3. That request comes from the web view, so its `Set-Cookie` lands in the right jar.

The token must be single-use, short-lived, and bound to the session it represents. That
endpoint is deliberately **not** written yet: it is security-sensitive, it belongs in
`apps/api` with tests, and it should be reviewed rather than guessed at. Until it exists,
sign-in opens correctly in a browser and then does not carry back — a known gap, not a
bug to hunt.
