# @derive/mobile

The native shell. It hosts the existing web app (`apps/web`) in a web view and adds the
things a browser tab cannot do. **It is not a second front end**: there are no screens
here that exist on the web, and there should not be. A web deploy reaches phones with no
app release, which is the entire reason for this shape.

## Running it

You do **not** need Xcode or Android Studio to try this. Expo Go on your own phone is
enough.

**The SDK is pinned to 54, and this is not a lag you can wait out.**

Expo stopped shipping new Expo Go versions to the App Store: SDK 55 went into Apple review
limbo with no timeline, and Expo pivoted to other delivery. **SDK 54 is the last Expo Go on
the App Store** (54.0.2, September 2025, identical across storefronts), so on a physical
phone with no Apple Developer account, 54 is the only thing that can run. A newer SDK fails
with "Project is incompatible with this version of Expo Go", and no amount of updating
fixes it because there is nothing newer to update to.

SDK 55+ on a real device needs one of:

- **`eas go`** — builds your own Expo Go, delivered over TestFlight. Requires the Apple
  Developer Program.
- **iOS Simulator** — Expo CLI can install any SDK's Expo Go there. Requires Xcode.
- **A development build** — Expo's actual recommendation, and where this app is headed
  anyway: push notifications and the share extension cannot run in Expo Go at all.

So the SDK bump and the Apple Developer enrolment are the same unlock, not two. Until then,
stay on 54. Check what the store actually ships before touching the SDK version:

```bash
curl -s "https://itunes.apple.com/lookup?id=982107779" | grep -o '"version":"[^"]*"' | head -1
```

npm's `latest` tag is the wrong source of truth while Expo Go is the delivery mechanism.


```bash
cd apps/mobile
npm install
npm start        # scan the QR with the Camera app (iOS) or Expo Go (Android)
```

To point it at a local stack instead of production, set the origin as an env var rather
than editing `app.json` (a LAN address must never reach a commit):

```bash
EXPO_PUBLIC_DERIVE_WEB_ORIGIN=http://<your-lan-ip>:3090 npm start
```

Use the machine's LAN address, not `localhost` — on the phone that resolves to the phone.
The API needs `DERIVE_WEB_ORIGIN` set to the same origin, or Better Auth's CSRF check
rejects sign-in with `INVALID_ORIGIN`.

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
| `app/_layout.tsx` | Root layout. |
| `app/index.tsx` | The screen: the hosted web app, plus deep-link entry (cold start included). |
| `src/web-stage.tsx` | The web view host: external-link interception, boot timeout, failure and retry. |
| `src/links.ts` | Deep-link resolution. **Pure and security-relevant** — see below. |
| `src/config.ts` | Binds `links.ts` to the running app's config. |
| `src/theme.ts` | Colour tokens (mirrored from `globals.css`) + the injected background probe. |
| `src/tabs.ts` | The tab model: which tab owns a path, and the script that moves the app. |
| `src/tab-bar.tsx` | The native tab bar. |

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
Expo-free so it can be exercised directly.

## What is tested, and what a phone still has to find

```bash
npm test        # vitest, jsdom
```

44 tests over the parts that can be checked without a device: deep-link resolution and its
refusals, the auth nonce binding and the injected claim script's escaping, the background
probe (run in a real document, because it is a script that runs in one), and the tab
bar's path mapping. CI runs these — apps/mobile is outside the pnpm workspace, so `pnpm -r` never reaches it and
the workflow installs and tests it separately, or these would pass locally and run nowhere.

### App Review status

Every row below was **exercised end to end** at phone size against a real stack, not
confirmed by finding a button. The distinction earned its keep: the delete-account control
is present for any signed-in user, but completing the flow needs a password AND typing
"delete", and a brand-new account is held on /welcome until onboarding is skipped. A
presence check would have reported all of that as fine.

| Requirement | Verified how |
| --- | --- |
| 5.1.1(v) account deletion | Created an account, deleted it through the UI. User row gone, re-sign-in refused, and **zero orphaned sessions, accounts, passkeys or memberships**. |
| 1.2 report user content | Submitted a real report. Dialog confirms "flagged for review" and the row lands in the database with its reason. |
| 2.1 comments | Post, react, and the resolve/edit/delete menu, on the mobile sheet. |
| 2.1 sign out | Clicked it; lands on /login. |
| 2.1 no dead ends | Missing artifact and unknown route both render real states, not blanks. |
| 4.2 native tab bar | All four tabs drive the SPA router with zero full page loads. |
| Export compliance | Declared, so submission stops asking. |
| 4.2 push notifications | **Blocked on an Apple Developer account.** |
| 4.8 Sign in with Apple | **Blocked** — required because Google sign-in is offered. |

The two blocked rows are the whole remaining gap, and both need credentials rather than
code.

**The ceiling is real and worth stating.** None of this exercises a web view. Scroll feel,
pull-to-refresh, cookie jars, the auth browser hand-off, the keyboard, safe areas and
gestures are all invisible here. Every bug this shell has actually shipped was in that
set: an unpainted safe-area strip, then a strip painted from the wrong source, then
comments failing on a non-secure origin. A green suite means the logic holds, not that the
app works. Run it on a phone.

## The tab bar

Four native tabs (Library, Favorites, Following, Settings) that drive the hosted app's
**client-side router** rather than reloading the web view — `history.pushState` plus a
`popstate` event, injected through a handle so a tab press never re-renders the frame.
Verified against the running app: every tab lands on the right screen with **zero full
page loads**.

It is also the shell's main answer to Guideline 4.2, which names a native tab bar and push
as what separates an app from a repackaged website.

Two things the mapping gets right, both pinned by tests because both fail silently:
`/settings` redirects to `/settings/profile`, so tabs own their sub-routes or Settings goes
dark the moment you tap it; and an artifact or profile selects **nothing**, because
falling back to Library would say you are somewhere you are not.

Labels, no icons. An icon set is a dependency, a bundle cost and a design decision, and
four short words read unambiguously at that size.

## Deliberately not built yet

- **Push and the share extension.** Both need an Apple Developer account and EAS
  credentials. Push is the other half of the 4.2 answer, so it should be first once
  enrolment clears.

## Turning on universal links

The association files are already served by the API, but **off by default**: an instance
with no app of its own must not publish one, because naming a bundle id hands that app the
right to claim this domain's links. Switch them on by setting, on the API:

| Var | Value |
| --- | --- |
| `DERIVE_IOS_APP_ID` | `<TeamID>.to.derive.app` |
| `DERIVE_ANDROID_CERT_FINGERPRINTS` | SHA-256 fingerprints of the release keystore, comma separated |

Both come from the Apple Developer account and the Android release keystore, so this is
the one step gated on credentials rather than code. Once they are set, a derive.to link
opens the app from Messages, Mail, Notes, the Slack desktop client, and Slack configured to
open in Safari.

It still will **not** work from inside Slack's own in-app browser — iOS does not honour
universal links from a web view, and no configuration changes that. That path is covered
on the web side by the "Open in Derive" bar.

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
