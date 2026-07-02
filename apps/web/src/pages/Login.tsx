import { getRouteApi, useNavigate } from "@tanstack/react-router"
import { Check } from "lucide-react"
import type { FormEvent } from "react"
import { useEffect, useState } from "react"
import { api } from "@/api"
import { Logo } from "@/components/shared/logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useAuth } from "@/ctx"

const FEATURES: [string, string][] = [
  ["Permanent URLs", "Every artifact gets a stable link with full version history."],
  ["Review in context", "Comments anchor to the text and survive every republish."],
  ["Publish from anywhere", "Ship from the CLI, the HTTP API, or an agent over MCP."],
  ["Yours to host", "Self-host the whole thing, or use the hosted tier."],
]

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

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-2">
      {/* Brand + value panel — desktop only; the form carries a compact brand on mobile.
          Flush on the canvas with a hairline divider — never a tinted well. */}
      <aside className="hidden flex-col justify-between border-r p-10 lg:flex">
        <div className="flex items-center gap-2.5">
          <Logo size={30} />
          <span className="font-serif text-xl font-medium tracking-tight">Derive</span>
        </div>
        <div className="flex max-w-md flex-col gap-6">
          <div className="flex flex-col gap-3">
            {/* The one voice moment on the page — serif, per the login headline rule. */}
            <h1 className="font-serif text-3xl font-medium tracking-tight text-balance text-foreground xl:text-4xl">
              The permanent home for your AI artifacts.
            </h1>
            <p className="text-base text-pretty text-muted-foreground">
              Give any HTML page, doc, or built site a lasting URL, version history, and a review
              loop your team and your agents can actually use.
            </p>
          </div>
          <ul className="flex flex-col gap-3">
            {FEATURES.map(([title, desc]) => (
              <li key={title} className="flex gap-2.5">
                {/* Amber checks are a sanctioned brand moment on this page. */}
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-foreground">{title}</span>
                  <span className="text-sm text-muted-foreground">{desc}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted-foreground">
          Open source. Self-host the whole thing, or use the hosted tier.
        </p>
      </aside>

      {/* Auth form — kept lean; profile setup (username + photo) happens on the home
          page once you're in, not as a gate here. */}
      <main className="flex items-center justify-center p-6">
        <div className="flex w-full max-w-xs flex-col gap-6">
          <div className="flex flex-col items-center gap-1.5 text-center lg:hidden">
            <div className="flex items-center gap-2">
              <Logo size={26} />
              <span className="font-serif text-lg font-medium tracking-tight">Derive</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Permanent URLs, versions, and review for your AI artifacts.
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{signup ? "Create your account" : "Welcome back"}</CardTitle>
              <CardDescription>
                {signup ? "Start publishing artifacts in seconds." : "Sign in to your workspace."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {(providers?.google || providers?.github) && (
                <>
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
                  <div className="flex items-center gap-3 py-0.5">
                    <span className="h-px flex-1 bg-border" />
                    <span className="font-mono text-2xs uppercase tracking-wide text-muted-foreground">
                      or
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                </>
              )}
              <form onSubmit={submit} className="flex flex-col gap-3">
                {err && (
                  <div
                    data-testid="login-error"
                    role="alert"
                    className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive ring-1 ring-inset ring-destructive/25"
                  >
                    {err}
                  </div>
                )}
                {signup && (
                  <label
                    htmlFor="login-name"
                    className="flex flex-col gap-1.5 text-sm font-medium text-foreground"
                  >
                    Name
                    <Input
                      id="login-name"
                      data-testid="login-name"
                      name="name"
                      autoComplete="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Your name"
                    />
                  </label>
                )}
                <label
                  htmlFor="login-email"
                  className="flex flex-col gap-1.5 text-sm font-medium text-foreground"
                >
                  Email
                  <Input
                    id="login-email"
                    data-testid="login-email"
                    type="email"
                    name="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com"
                  />
                </label>
                <label
                  htmlFor="login-password"
                  className="flex flex-col gap-1.5 text-sm font-medium text-foreground"
                >
                  Password
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
                </label>
                <Button
                  data-testid="login-submit"
                  variant="default"
                  size="lg"
                  type="submit"
                  disabled={busy || !email || !password}
                  className="mt-1 w-full"
                >
                  {busy ? "…" : signup ? "Create account" : "Sign in"}
                </Button>
              </form>

              <p className="text-sm text-muted-foreground">
                {signup ? "Have an account? " : "New here? "}
                <Button
                  data-testid="login-toggle"
                  variant="link"
                  type="button"
                  className="h-auto p-0 align-baseline text-sm font-medium"
                  onClick={() => setMode(signup ? "login" : "signup")}
                >
                  {signup ? "Sign in" : "Create an account"}
                </Button>
              </p>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  )
}
