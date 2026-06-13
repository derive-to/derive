import { useNavigate } from "@tanstack/react-router"
import type { FormEvent } from "react"
import { useEffect, useState } from "react"
import { api } from "../api"
import { Logo } from "../components"
import { useAuth } from "../ctx"

const FEATURES: [string, string][] = [
  ["Permanent URLs", "Every artifact gets a stable link with full version history."],
  ["Review in context", "Comments anchor to the text and survive every republish."],
  ["Publish from anywhere", "Ship from the CLI, the HTTP API, or an agent over MCP."],
  ["Yours to host", "Self-host the whole thing, or use the hosted tier."],
]

export function Login() {
  const { me, loading, setMe } = useAuth()
  const nav = useNavigate()
  const [mode, setMode] = useState<"login" | "signup">("login")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!loading && me) nav({ to: "/" })
  }, [loading, me, nav])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setErr("")
    setBusy(true)
    try {
      if (mode === "signup") await api.signup(email, password, name)
      else await api.login(email, password)
      const { user } = await api.me()
      setMe(user)
      nav({ to: "/" })
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="auth">
      <aside className="auth-aside">
        <div className="auth-aside-inner">
          <div className="auth-brand">
            <Logo size={30} />
            <span className="display">Dock</span>
          </div>
          <h1 className="display auth-headline">The permanent home for your AI artifacts.</h1>
          <p className="auth-sub">
            Give any HTML page, doc, or built site a lasting URL, version history, and a review loop
            your team and your agents can actually use.
          </p>
          <ul className="auth-features">
            {FEATURES.map(([title, desc]) => (
              <li key={title}>
                <span className="auth-check" aria-hidden>
                  ✓
                </span>
                <div>
                  <b>{title}</b>
                  <span>{desc}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <main className="auth-main">
        <div className="auth-card-wrap">
          <div className="auth-brand auth-brand-mobile">
            <Logo size={26} />
            <span className="display">Dock</span>
          </div>
          <p className="auth-tagline-mobile muted">
            Permanent URLs, versions, and review for your AI artifacts.
          </p>
          <h2 className="display auth-title">
            {mode === "signup" ? "Create your account" : "Welcome back"}
          </h2>
          <p className="muted auth-card-sub">
            {mode === "signup"
              ? "Start publishing artifacts in seconds."
              : "Sign in to your workspace."}
          </p>

          <form className="auth-form" onSubmit={submit}>
            {err && <div className="auth-err">{err}</div>}
            {mode === "signup" && (
              <label className="auth-field">
                Name
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                />
              </label>
            )}
            <label className="auth-field">
              Email
              <input
                className="input"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </label>
            <label className="auth-field">
              Password
              <input
                className="input"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
              />
            </label>
            <button
              className="btn pri auth-submit"
              type="submit"
              disabled={busy || !email || !password}
            >
              {busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}
            </button>
          </form>

          <p className="auth-toggle muted">
            {mode === "login" ? (
              <>
                New here?{" "}
                <button type="button" className="lnk" onClick={() => setMode("signup")}>
                  Create an account
                </button>
              </>
            ) : (
              <>
                Have an account?{" "}
                <button type="button" className="lnk" onClick={() => setMode("login")}>
                  Sign in
                </button>
              </>
            )}
          </p>
        </div>
      </main>
    </div>
  )
}
