import { getRouteApi, useNavigate } from "@tanstack/react-router"
import { Camera, Check } from "lucide-react"
import type { FormEvent } from "react"
import { useEffect, useRef, useState } from "react"
import { ApiError, api } from "@/api"
import { Logo } from "@/components/shared/logo"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useAuth } from "@/ctx"
import { usernameError } from "@/lib/username"
import { cn } from "@/lib/utils"

const FEATURES: [string, string][] = [
  ["Permanent URLs", "Every artifact gets a stable link with full version history."],
  ["Review in context", "Comments anchor to the text and survive every republish."],
  ["Publish from anywhere", "Ship from the CLI, the HTTP API, or an agent over MCP."],
  ["Yours to host", "Self-host the whole thing, or use the hosted tier."],
]

const loginRoute = getRouteApi("/login")

// Live availability of the typed handle, so a clash is caught before submit.
type HandleStatus = "idle" | "invalid" | "checking" | "available" | "taken"

export function Login() {
  const { me, loading, setMe } = useAuth()
  const nav = useNavigate()
  const { signup: wantSignup } = loginRoute.useSearch()
  const [mode, setMode] = useState<"login" | "signup">(wantSignup ? "signup" : "login")
  const [name, setName] = useState("")
  const [username, setUsername] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [avatar, setAvatar] = useState<File | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [uStatus, setUStatus] = useState<HandleStatus>("idle")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const avatarInput = useRef<HTMLInputElement>(null)

  const signup = mode === "signup"
  const handle = username.trim().toLowerCase()

  // If we arrived from an OAuth authorize request (the agent consent flow bounced
  // here to sign in), resume it by handing control back to the authorize endpoint
  // now that there's a session — it then renders the consent screen. Otherwise go
  // home. Captured from the raw query so it survives the route's search parsing.
  const afterAuth = () => {
    const sp = typeof window !== "undefined" ? window.location.search : ""
    if (new URLSearchParams(sp).has("client_id")) {
      window.location.href = `/api/auth/oauth2/authorize${sp}`
    } else {
      nav({ to: "/" })
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: afterAuth only reads nav (stable) + the URL; keyed to the auth state.
  useEffect(() => {
    if (!loading && me) afterAuth()
  }, [loading, me])

  // Debounced handle availability (signup only): client shape check first, then a
  // public profile lookup — 404 means free, 200 means taken.
  useEffect(() => {
    if (!signup || !handle) {
      setUStatus("idle")
      return
    }
    if (usernameError(handle)) {
      setUStatus("invalid")
      return
    }
    setUStatus("checking")
    const t = setTimeout(async () => {
      try {
        await api.profile(handle)
        setUStatus("taken")
      } catch (e) {
        setUStatus(e instanceof ApiError && e.status === 404 ? "available" : "idle")
      }
    }, 350)
    return () => clearTimeout(t)
  }, [handle, signup])

  // Preview the chosen photo locally; the upload itself happens after the account
  // exists (on submit). Revoke the old object URL when it changes / on unmount.
  const pickAvatar = (f: File | null) => {
    setAvatarUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return f ? URL.createObjectURL(f) : null
    })
    setAvatar(f)
  }
  useEffect(() => {
    return () => {
      if (avatarUrl) URL.revokeObjectURL(avatarUrl)
    }
  }, [avatarUrl])

  const handleError = signup && handle ? usernameError(handle) : null
  const handleBlocked = signup && (!handle || !!handleError || uStatus === "taken")

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr("")
    setBusy(true)
    try {
      if (signup) {
        await api.signup(email, password, name)
        // Account exists now; claim the handle + upload the photo against the new
        // session. A rare handle clash (someone took it since the check) is
        // non-fatal — the in-app onboarding gate will prompt for another.
        await api.setUsername(handle).catch(() => {})
        if (avatar) await api.uploadAvatar(avatar).catch(() => {})
      } else {
        await api.login(email, password)
      }
      const { user } = await api.me()
      setMe(user)
      afterAuth()
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  const initials = (name.trim() || email.trim() || "?").slice(0, 1).toUpperCase()

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand + value panel — desktop only; the form carries a compact brand on mobile. */}
      <aside className="hidden flex-col justify-between bg-secondary p-10 text-secondary-foreground lg:flex">
        <div className="flex items-center gap-2.5">
          <Logo size={30} />
          <span className="font-display text-xl font-semibold">Dock</span>
        </div>
        <div className="max-w-md">
          <h1 className="font-display text-3xl font-semibold leading-tight text-foreground">
            The permanent home for your AI artifacts.
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Give any HTML page, doc, or built site a lasting URL, version history, and a review loop
            your team and your agents can actually use.
          </p>
          <ul className="mt-6 flex flex-col gap-3">
            {FEATURES.map(([title, desc]) => (
              <li key={title} className="flex gap-2.5">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <div className="flex flex-col">
                  <span className="text-sm font-semibold text-foreground">{title}</span>
                  <span className="text-xs text-muted-foreground">{desc}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-2xs text-muted-foreground">
          Open source. Self-host the whole thing, or use the hosted tier.
        </p>
      </aside>

      {/* Auth form */}
      <main className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex flex-col items-center gap-1 text-center lg:hidden">
            <div className="flex items-center gap-2">
              <Logo size={26} />
              <span className="font-display text-lg font-semibold">Dock</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Permanent URLs, versions, and review for your AI artifacts.
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{signup ? "Create your account" : "Welcome back"}</CardTitle>
              <CardDescription>
                {signup
                  ? "Set your name, handle, and photo — change them anytime."
                  : "Sign in to your workspace."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <form onSubmit={submit} className="flex flex-col gap-3">
                {err && (
                  <div
                    data-testid="login-error"
                    role="alert"
                    className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  >
                    {err}
                  </div>
                )}

                {signup && (
                  <>
                    {/* Optional avatar — clicking the tile opens the picker. */}
                    <div className="flex flex-col items-center gap-1.5">
                      <button
                        type="button"
                        data-testid="login-avatar"
                        onClick={() => avatarInput.current?.click()}
                        className="group relative size-16 overflow-hidden rounded-full border border-dashed border-input transition-colors hover:border-primary"
                        aria-label="Add a profile photo"
                      >
                        <Avatar className="size-full rounded-full">
                          {avatarUrl && <AvatarImage src={avatarUrl} alt="Your avatar preview" />}
                          <AvatarFallback className="rounded-full bg-card text-muted-foreground">
                            {name.trim() ? (
                              <span className="font-display text-xl font-semibold">{initials}</span>
                            ) : (
                              <Camera className="size-5" aria-hidden />
                            )}
                          </AvatarFallback>
                        </Avatar>
                        <span className="absolute inset-x-0 bottom-0 hidden bg-foreground/70 py-0.5 text-center text-2xs font-medium text-background group-hover:block">
                          Edit
                        </span>
                      </button>
                      <span className="text-2xs text-muted-foreground">Add a photo (optional)</span>
                      <input
                        ref={avatarInput}
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/webp"
                        data-testid="login-avatar-input"
                        className="hidden"
                        onChange={(e) => pickAvatar(e.target.files?.[0] ?? null)}
                      />
                    </div>

                    <label
                      htmlFor="login-name"
                      className="flex flex-col gap-1.5 text-sm font-medium text-foreground"
                    >
                      Name
                      <Input
                        id="login-name"
                        data-testid="login-name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Your name"
                      />
                    </label>

                    <label
                      htmlFor="login-username"
                      className="flex flex-col gap-1.5 text-sm font-medium text-foreground"
                    >
                      Username
                      <span
                        className={cn(
                          "flex items-center rounded-md border border-input bg-card transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-accent",
                          handleBlocked && handle && "border-destructive",
                        )}
                      >
                        <span className="select-none pl-3 text-sm text-muted-foreground">@</span>
                        <input
                          id="login-username"
                          data-testid="login-username"
                          value={username}
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          onChange={(e) => setUsername(e.target.value)}
                          placeholder="yourname"
                          className="h-9 w-full rounded-md bg-transparent pl-1 pr-3 text-base text-foreground outline-none placeholder:text-muted-foreground"
                        />
                      </span>
                      {handle && (
                        <span
                          data-testid="login-username-status"
                          className={cn(
                            "text-xs font-normal",
                            uStatus === "available"
                              ? "text-primary"
                              : handleError || uStatus === "taken"
                                ? "text-destructive"
                                : "text-muted-foreground",
                          )}
                        >
                          {handleError ??
                            (uStatus === "checking"
                              ? "Checking…"
                              : uStatus === "taken"
                                ? "That username is taken."
                                : uStatus === "available"
                                  ? "✓ Available"
                                  : "Your public handle.")}
                        </span>
                      )}
                    </label>
                  </>
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
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                  />
                </label>
                <Button
                  data-testid="login-submit"
                  variant="primary"
                  size="lg"
                  type="submit"
                  disabled={busy || !email || !password || handleBlocked}
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
                  className="h-auto p-0 align-baseline text-sm font-semibold"
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
