import { getRouteApi, useNavigate } from "@tanstack/react-router"
import type { FormEvent } from "react"
import { useEffect, useState } from "react"
import { api } from "@/api"
import { FormField } from "@/components/shared/form-field"
import { Logo } from "@/components/shared/logo"
import { Eyebrow, LabeledDivider } from "@/components/shared/section-eyebrow"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAuth } from "@/ctx"

const loginRoute = getRouteApi("/login")

export function Login() {
  const { me, loading, setMe } = useAuth()
  const nav = useNavigate()
  const { signup: wantSignup, return_to: returnTo } = loginRoute.useSearch()
  const [mode, setMode] = useState<"login" | "signup">(wantSignup ? "signup" : "login")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  // Which social providers the server has configured (so we only show buttons
  // that actually work). Null while loading.
  const [providers, setProviders] = useState<{ google: boolean; github: boolean } | null>(null)
  useEffect(() => {
    api
      .authProviders()
      .then(setProviders)
      .catch(() => setProviders({ google: false, github: false }))
  }, [])

  // Hand off to the provider; afterwards Better Auth lands the user back where
  // sign-in was prompted (an OAuth authorize resume, a return_to, or home).
  const social = (provider: "google" | "github") => {
    const search = typeof window !== "undefined" ? window.location.search : ""
    const callbackURL = new URLSearchParams(search).has("client_id")
      ? `/login${search}`
      : typeof returnTo === "string"
        ? returnTo
        : "/"
    api.socialSignIn(provider, callbackURL).catch((e) => setErr((e as Error).message))
  }

  // If we arrived from an OAuth authorize request (the agent consent flow bounced
  // here to sign in), resume it by handing control back to the authorize endpoint
  // now that there's a session — it then renders the consent screen. Otherwise go
  // home. Captured from the raw query so it survives the route's search parsing.
  const afterAuth = () => {
    const search = typeof window !== "undefined" ? window.location.search : ""
    if (new URLSearchParams(search).has("client_id")) {
      window.location.href = `/api/auth/oauth2/authorize${search}`
    } else if (typeof returnTo === "string") {
      // Back to where sign-in was prompted (e.g. a shared artifact's "sign in to
      // comment"). Validated same-origin relative by the route, so this is safe.
      window.location.href = returnTo
    } else {
      nav({ to: "/" })
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: afterAuth reads nav (stable), the URL, and returnTo (stable from search); keyed to the auth state.
  useEffect(() => {
    if (!loading && me) afterAuth()
  }, [loading, me])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr("")
    setBusy(true)
    try {
      if (mode === "signup") await api.signup(email, password, name)
      else await api.login(email, password)
      const { user } = await api.me()
      setMe(user)
      afterAuth()
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  const signup = mode === "signup"

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

            {/* Login/signup headlines are voice moments (Inter display via the
                font-serif alias); this is also the page's one functional <h1>. */}
            <div className="flex flex-col gap-1.5">
              <h1 className="font-serif text-3xl font-medium tracking-tight text-balance text-foreground">
                {signup ? "Create your account" : "Welcome back"}
              </h1>
              <p className="text-sm text-pretty text-muted-foreground">
                {signup ? "Start publishing artifacts in seconds." : "Sign in to your workspace."}
              </p>
            </div>
          </div>

          {/* Action zone — the sign-in methods (OAuth + email/password) and the
              mode toggle, grouped tighter than the break above so the form reads as
              one considered unit rather than four equidistant pieces. */}
          <div className="flex flex-col gap-6">
            {(providers?.google || providers?.github) && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2">
                  {providers.google && (
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
                  {providers.github && (
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
                </div>
                <LabeledDivider>
                  <Eyebrow>or</Eyebrow>
                </LabeledDivider>
              </div>
            )}

            <form onSubmit={submit} className="flex flex-col gap-4">
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
                  autoComplete="email"
                  required
                  // First field in login mode takes focus on mount (signup leads with name).
                  autoFocus={!signup}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                />
              </FormField>
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
