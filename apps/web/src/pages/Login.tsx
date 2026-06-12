import { useEffect, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { api } from "../api"
import { Logo } from "../components"
import { useAuth } from "../ctx"

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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr("")
    setBusy(true)
    try {
      const r = mode === "signup" ? await api.signup(email, password, name) : await api.login(email, password)
      setMe(r.user)
      nav({ to: "/" })
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="center">
      <div style={{ width: 360, maxWidth: "90vw" }}>
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <Logo size={30} />
          <span className="display" style={{ fontWeight: 600, fontSize: 22 }}>
            Dock
          </span>
        </div>
        <p className="muted" style={{ textAlign: "center", margin: "0 0 24px" }}>
          {mode === "signup" ? "Create your account." : "Sign in to your workspace."}
        </p>
        <form className="card" style={{ padding: 22, boxShadow: "var(--shadow)" }} onSubmit={submit}>
          {err && (
            <div style={{ background: "var(--cmt-bg)", color: "var(--bad)", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 12 }}>
              {err}
            </div>
          )}
          {mode === "signup" && (
            <label style={lbl}>
              Name
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            </label>
          )}
          <label style={lbl}>
            Email
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </label>
          <label style={{ ...lbl, marginBottom: 16 }}>
            Password
            <input className="input" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
          </label>
          <button className="btn pri" type="submit" disabled={busy} style={{ width: "100%", justifyContent: "center" }}>
            {busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}
          </button>
        </form>
        <p className="muted" style={{ textAlign: "center", fontSize: 13, marginTop: 14 }}>
          {mode === "login" ? (
            <>
              New here?{" "}
              <a style={{ cursor: "pointer" }} onClick={() => setMode("signup")}>
                Create an account
              </a>
            </>
          ) : (
            <>
              Have an account?{" "}
              <a style={{ cursor: "pointer" }} onClick={() => setMode("login")}>
                Sign in
              </a>
            </>
          )}
        </p>
      </div>
    </div>
  )
}

const lbl: React.CSSProperties = { display: "block", fontSize: 12.5, fontWeight: 600, color: "var(--fg-mut)", marginBottom: 12 }
