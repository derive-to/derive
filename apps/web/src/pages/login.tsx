import { getRouteApi, Link } from "@tanstack/react-router"
import type { FormEvent } from "react"
import { useEffect, useRef, useState } from "react"
import { type AuthCapabilities, api } from "@/api"
import { FormField } from "@/components/shared/form-field"
import { Logo } from "@/components/shared/logo"
import { Eyebrow, LabeledDivider } from "@/components/shared/section-eyebrow"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  REGEXP_ONLY_DIGITS,
} from "@/components/ui/input-otp"
import { useAuth } from "@/ctx"
import { authClient } from "@/lib/auth-client"
import { nativeCallbackUrl, nativeState } from "@/lib/native-handoff"
import { needsOnboarding } from "@/lib/route-guards"
import { useDocumentTitle } from "@/lib/use-document-title"

const loginRoute = getRouteApi("/login")

export function Login() {
  useDocumentTitle("Sign in")
  const { me, loading, setMe } = useAuth()
  const { signup: wantSignup, return_to: returnTo, reset: didReset } = loginRoute.useSearch()
  const [mode, setMode] = useState<"login" | "signup">(wantSignup ? "signup" : "login")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const [pkBusy, setPkBusy] = useState(false)
  // Set when a password sign-in needs a second factor (the account has 2FA on); swaps the
  // form for a TOTP/backup-code prompt. `useBackup` toggles between the two code types.
  const [twoFactorPending, setTwoFactorPending] = useState(false)
  const [code, setCode] = useState("")
  const [useBackup, setUseBackup] = useState(false)
  // What sign-in methods this instance actually has (so we only render buttons that
  // work here — the capability-adaptive contract). Null while loading.
  const [caps, setCaps] = useState<AuthCapabilities | null>(null)
  useEffect(() => {
    api
      .capabilities()
      .then(setCaps)
      .catch(() => setCaps(null))
  }, [])

  // Where a provider round-trip should land afterwards: back into an OAuth authorize
  // resume (agent consent bounced us here to sign in), else the return_to, else home.
  const oauthCallbackURL = () => {
    const search = typeof window !== "undefined" ? window.location.search : ""
    // The native shell's nonce has to survive the provider round-trip, or afterAuth
    // comes back with no way to tell this was the app's sign-in. Same reasoning as the
    // client_id case below: land back on /login with the query intact.
    return new URLSearchParams(search).has("client_id") || nativeState(search)
      ? `/login${search}`
      : typeof returnTo === "string"
        ? returnTo
        : "/"
  }
  // Hand off to a provider; afterwards Better Auth lands the user back where sign-in
  // was prompted (an OAuth authorize resume, a return_to, or home).
  const social = (provider: "google" | "github") =>
    api.socialSignIn(provider, oauthCallbackURL()).catch((e) => setErr((e as Error).message))
  const sso = (providerId: string) =>
    api.ssoSignIn(providerId, oauthCallbackURL()).catch((e) => setErr((e as Error).message))

  // If we arrived from an OAuth authorize request (the agent consent flow bounced
  // here to sign in), resume it by handing control back to the authorize endpoint
  // now that there's a session — it then renders the consent screen. Otherwise go
  // home. Captured from the raw query so it survives the route's search parsing.
  //
  // Every branch is a HARD navigation, not an SPA nav — this is load-bearing for the
  // home case. A client nav to "/" runs the onboarding beforeLoad guard while /login
  // is still in the router tree; the guard redirects a new user to /welcome before
  // "/" commits, so /login never unmounts, remounts, and re-enters here — looping
  // / ⇄ /welcome. A full load lands on the right place (home, or /welcome for a new
  // user) with no /login left to re-trigger it. The one-shot latch guards the brief
  // pre-navigation window where the effect below can fire more than once.
  const redirected = useRef(false)
  const afterAuth = (who?: Parameters<typeof needsOnboarding>[0] | null) => {
    if (redirected.current) return
    redirected.current = true
    const search = typeof window !== "undefined" ? window.location.search : ""
    const native = nativeState(search)
    if (native) {
      // The native shell opened this page in a REAL browser, because Google refuses
      // OAuth from an embedded web view. The session now lives in THIS browser's cookie
      // jar, which is not the one the app's web view reads — so hand it over: mint a
      // single-use token and bounce to the app's callback, echoing the app's nonce so it
      // can tell its own flow from a crafted link.
      //
      // If minting fails there is nothing useful to fall back to (the app is waiting on
      // the callback, and landing on the web home inside an auth browser is a dead end),
      // so surface it and let the person retry rather than stranding them silently.
      api
        .nativeHandoffToken()
        .then(({ token }) => {
          window.location.href = nativeCallbackUrl(token, native)
        })
        .catch((e) => {
          redirected.current = false
          setErr((e as Error).message)
        })
    } else if (new URLSearchParams(search).has("client_id")) {
      window.location.href = `/api/auth/oauth2/authorize${search}`
    } else if (typeof returnTo === "string") {
      // Back to where sign-in was prompted (e.g. a shared artifact's "sign in to
      // comment"). Validated same-origin relative by the route, so this is safe.
      window.location.href = returnTo
    } else if (who && needsOnboarding(who)) {
      // A user who still needs onboarding goes straight to /welcome. Routing to "/" first
      // boots the whole app shell (rail skeleton + a blank pane) only for the same gate to
      // redirect here — so the user's very first post-signup frame is a loading flash. Skip
      // the detour by reusing the app-shell gate's exact predicate (needsOnboarding), so a
      // returning pre-flag user is never wrongly sent to /welcome. The gate still covers any
      // path that doesn't come through here.
      window.location.href = "/welcome"
    } else {
      window.location.href = "/"
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: afterAuth reads window.location + returnTo (stable from search); keyed to the auth state.
  useEffect(() => {
    if (!loading && me) afterAuth(me)
  }, [loading, me])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr("")
    setBusy(true)
    try {
      if (mode === "signup") {
        await api.signup(email, password, name)
      } else {
        const res = (await api.login(email, password)) as { twoFactorRedirect?: boolean } | null
        // The account has 2FA on: sign-in returned no session, just a redirect flag —
        // switch to the code prompt instead of trying to read a (nonexistent) session.
        if (res?.twoFactorRedirect) {
          setTwoFactorPending(true)
          setBusy(false)
          return
        }
      }
      // Seed the auth cache from the one identity read (session cookie is set now).
      const session = await api.session()
      setMe(session)
      afterAuth(session)
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  // Complete a 2FA sign-in with the entered TOTP (or backup) code.
  const verifyCode = async (e?: FormEvent) => {
    e?.preventDefault()
    if (busy) return
    setErr("")
    setBusy(true)
    try {
      const res = useBackup
        ? await authClient.twoFactor.verifyBackupCode({ code })
        : await authClient.twoFactor.verifyTotp({ code })
      if (res?.error) throw new Error(res.error.message ?? "That code didn't work.")
      const session = await api.session()
      setMe(session)
      afterAuth(session)
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  // The OAuth-authorize resume path (agent consent bounced here). Conditional-UI passkey
  // autofill shouldn't fire there — that flow drives its own navigation.
  const oauthResume =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("client_id")

  // Passkey (WebAuthn) sign-in via the Better Auth client. `autoFill` is the conditional-UI
  // prime: the browser offers saved passkeys inline on the email field, resolving only if
  // the user picks one — so on that path we stay silent on error. The explicit button
  // (autoFill=false) surfaces failures.
  const passkeySignIn = async (autoFill = false) => {
    if (!autoFill) setPkBusy(true)
    try {
      const res = await authClient.signIn.passkey({ autoFill })
      if (res?.data) {
        const session = await api.session()
        setMe(session)
        afterAuth(session)
      } else if (res?.error && !autoFill) {
        setErr(res.error.message ?? "Passkey sign-in failed.")
      }
    } catch (e) {
      if (!autoFill) setErr((e as Error).message)
    } finally {
      if (!autoFill) setPkBusy(false)
    }
  }

  // Prime conditional-UI autofill once, when passkeys are available and we're in the plain
  // sign-in flow. A no-op where the browser doesn't support it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: one-shot autofill prime keyed to capability availability.
  useEffect(() => {
    if (caps?.passkey && !oauthResume && mode === "login") void passkeySignIn(true)
  }, [caps?.passkey])

  const signup = mode === "signup"
  // SSO is capability-gated; capture as a const so the click closure keeps the
  // non-null narrowing (a const can't be reassigned, so TS carries it in).
  const oidc = caps?.oidc ?? null

  // The auth screen is a calm gateway, not a landing page: one focused column,
  // centered on a solid canvas (the login-surface rule — white in light, the deep
  // canvas in dark, never light-tinted paper under a card-less form). No marketing
  // panel; the brand carries in the monochrome, the type, and the wordmark. The
  // ONE ink moment on the page is the primary CTA. Onboarding/reassurance lives on
  // /welcome after signup — this page just authenticates.
  return (
    <div className="flex min-h-dvh flex-col bg-card dark:bg-background">
      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="flex w-full max-w-xs flex-col gap-8">
          <div className="flex flex-col items-center gap-5 text-center">
            {/* Wordmark — this page is chrome-less (no rail), so the mark stands in as
                the brand anchor. Non-interactive: "/" is auth-walled, so linking it
                would just bounce back here. */}
            <div className="flex items-center gap-2">
              <Logo size={26} />
              <span className="font-serif text-lg font-medium tracking-tight">Derive</span>
            </div>

            {/* Login/signup headlines are voice moments (Geist display via the
                font-serif alias); this is also the page's one functional <h1>. */}
            <div className="flex flex-col gap-1.5">
              <h1 className="font-serif text-3xl font-medium tracking-tight text-balance text-foreground">
                {twoFactorPending
                  ? "Two-step verification"
                  : signup
                    ? "Create your account"
                    : "Welcome back"}
              </h1>
              <p className="text-sm text-pretty text-muted-foreground">
                {twoFactorPending
                  ? useBackup
                    ? "Enter one of your saved backup codes."
                    : "Enter the code from your authenticator app."
                  : signup
                    ? "Start publishing artifacts in seconds."
                    : "Sign in to your workspace."}
              </p>
            </div>
          </div>

          {/* 2FA code prompt — swapped in for the whole action zone once a password
              sign-in reports the account has two-factor on. */}
          {twoFactorPending ? (
            <form onSubmit={verifyCode} className="flex flex-col gap-4">
              {err && (
                <div data-testid="login-error">
                  <StatusPanel tone="danger" layout="inline" title={err} />
                </div>
              )}
              <FormField
                label={useBackup ? "Backup code" : "Authenticator code"}
                htmlFor="login-2fa"
              >
                {useBackup ? (
                  <Input
                    id="login-2fa"
                    data-testid="login-2fa"
                    name="one-time-code"
                    inputMode="text"
                    autoComplete="one-time-code"
                    autoFocus
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="xxxxxxxxxx"
                  />
                ) : (
                  <InputOTP
                    id="login-2fa"
                    data-testid="login-2fa"
                    maxLength={6}
                    pattern={REGEXP_ONLY_DIGITS}
                    inputMode="numeric"
                    autoFocus
                    value={code}
                    onChange={setCode}
                    // Auto-verify on the sixth digit — verifyCode guards against a re-entrant
                    // submit while a verify is already in flight.
                    onComplete={() => verifyCode()}
                  >
                    <InputOTPGroup>
                      {[0, 1, 2, 3, 4, 5].map((i) => (
                        <InputOTPSlot key={i} index={i} />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                )}
              </FormField>
              <Button
                data-testid="login-2fa-submit"
                variant="default"
                size="lg"
                type="submit"
                loading={busy}
                disabled={useBackup ? !code : code.length !== 6}
                className="w-full"
              >
                {busy ? "Verifying…" : "Verify"}
              </Button>
              <Button
                data-testid="login-2fa-toggle"
                variant="link"
                type="button"
                className="h-auto p-0 text-sm font-normal text-muted-foreground"
                onClick={() => {
                  setUseBackup((b) => !b)
                  setCode("")
                  setErr("")
                }}
              >
                {useBackup ? "Use your authenticator app instead" : "Use a backup code instead"}
              </Button>
            </form>
          ) : (
            <div className="flex flex-col gap-6">
              {(caps?.google || caps?.github || oidc || (caps?.passkey && !signup)) && (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-2">
                    {/* Passkey is promoted by POSITION (top) + conditional-UI autofill on the
                      email field — kept in the outline register so the email/password submit
                      stays the page's one ink moment. Sign-in only (passkeys are added
                      post-auth, never at sign-up). */}
                    {caps?.passkey && !signup && (
                      <Button
                        data-testid="login-passkey"
                        variant="outline"
                        size="lg"
                        type="button"
                        className="w-full"
                        loading={pkBusy}
                        onClick={() => passkeySignIn(false)}
                      >
                        {pkBusy ? "Waiting for passkey…" : "Sign in with a passkey"}
                      </Button>
                    )}
                    {caps?.google && (
                      <Button
                        data-testid="login-google"
                        variant="outline"
                        size="lg"
                        type="button"
                        className="w-full"
                        onClick={() => social("google")}
                      >
                        Continue with Google
                      </Button>
                    )}
                    {caps?.github && (
                      <Button
                        data-testid="login-github"
                        variant="outline"
                        size="lg"
                        type="button"
                        className="w-full"
                        onClick={() => social("github")}
                      >
                        Continue with GitHub
                      </Button>
                    )}
                    {oidc && (
                      <Button
                        data-testid="login-sso"
                        variant="outline"
                        size="lg"
                        type="button"
                        className="w-full"
                        onClick={() => sso(oidc.providerId)}
                      >
                        Continue with {oidc.label}
                      </Button>
                    )}
                  </div>
                  <LabeledDivider>
                    <Eyebrow>or</Eyebrow>
                  </LabeledDivider>
                </div>
              )}

              <form onSubmit={submit} className="flex flex-col gap-4">
                {/* Landed here from a completed password reset — every other session was
                  revoked, so sign in fresh with the new password. */}
                {didReset && !err && (
                  <StatusPanel
                    tone="success"
                    layout="inline"
                    title="Password updated. Sign in with your new password."
                  />
                )}
                {err && (
                  <div data-testid="login-error">
                    {/* StatusPanel (tone="danger") announces via role="alert" and bakes in
                    the inline padding — no wrapper role, no p-* override. */}
                    <StatusPanel tone="danger" layout="inline" title={err} />
                  </div>
                )}
                {signup && (
                  <FormField label="Name" htmlFor="login-name">
                    <Input
                      id="login-name"
                      data-testid="login-name"
                      name="name"
                      autoComplete="name"
                      // First field in signup mode takes focus on mount.
                      autoFocus
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Your name"
                    />
                  </FormField>
                )}
                <FormField label="Email" htmlFor="login-email">
                  <Input
                    id="login-email"
                    data-testid="login-email"
                    type="email"
                    name="email"
                    // "webauthn" lets the browser offer saved passkeys inline (conditional UI),
                    // primed by passkeySignIn(true) on mount — the seamless one-tap path.
                    autoComplete={caps?.passkey && !signup ? "username webauthn" : "email"}
                    required
                    // First field in login mode takes focus on mount (signup leads with name).
                    autoFocus={!signup}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                  />
                </FormField>
                <div className="flex flex-col gap-1.5">
                  <FormField label="Password" htmlFor="login-password">
                    <Input
                      id="login-password"
                      data-testid="login-password"
                      type="password"
                      name="password"
                      autoComplete={signup ? "new-password" : "current-password"}
                      required
                      minLength={8}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="At least 8 characters"
                    />
                  </FormField>
                  {/* Self-serve recovery — only in sign-in mode, and only where a mail
                    transport can actually deliver the link (capability-gated). */}
                  {!signup && caps?.passwordReset && (
                    <Button
                      asChild
                      variant="link"
                      data-testid="login-forgot"
                      className="h-auto self-end p-0 text-xs font-normal text-muted-foreground"
                    >
                      <Link to="/reset-password">Forgot password?</Link>
                    </Button>
                  )}
                </div>
                <Button
                  data-testid="login-submit"
                  variant="default"
                  size="lg"
                  type="submit"
                  // Busy uses the Button `loading` recipe (auto-disables + current-ink
                  // spinner) while we keep the verb label; the value guard stays the
                  // house convention (matches password-gate, workspace invite, etc.).
                  loading={busy}
                  disabled={!email || !password}
                  className="w-full"
                >
                  {busy
                    ? signup
                      ? "Creating account…"
                      : "Signing in…"
                    : signup
                      ? "Create account"
                      : "Sign in"}
                </Button>
              </form>

              <p className="text-center text-sm text-muted-foreground">
                {signup ? "Have an account? " : "New here? "}
                <Button
                  data-testid="login-toggle"
                  variant="link"
                  type="button"
                  className="h-auto p-0 align-baseline"
                  onClick={() => setMode(signup ? "login" : "signup")}
                >
                  {signup ? "Sign in" : "Create an account"}
                </Button>
              </p>
            </div>
          )}
        </div>
      </main>

      {/* One quiet brand line grounds the bottom — the single voice note besides the
          wordmark, kept in the muted register so it never competes with the form. */}
      <footer className="px-6 pb-8 text-center">
        <p className="text-sm text-pretty text-muted-foreground">
          Open source. Self-host the whole thing, or use the hosted tier.
        </p>
      </footer>
    </div>
  )
}
