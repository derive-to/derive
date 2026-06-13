import { useEffect, useRef, useState } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { api } from "./api"
import { THEMES, useAuth, useTheme } from "./ctx"

export const Logo = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
    <rect x="1" y="1" width="30" height="30" rx="8" fill="#2a2540" />
    <path d="M16 7l7 7v11h-4.6v-6.2h-4.8V25H9V14l7-7z" fill="none" stroke="#8a7dc0" strokeWidth="1.7" strokeLinejoin="round" />
    <rect x="13.6" y="6.4" width="4.8" height="4.8" rx="1.2" fill="#655999" />
  </svg>
)

// Matches a max-width breakpoint, reactively. SSR-safe (assumes desktop until
// the client mounts). Drives the mobile layout branches across the app.
export function useIsMobile(bp = 640): boolean {
  const [m, setM] = useState(
    () => typeof window !== "undefined" && window.matchMedia(`(max-width:${bp}px)`).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(`(max-width:${bp}px)`)
    const on = () => setM(mq.matches)
    on()
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [bp])
  return m
}

export function Header({ right }: { right?: React.ReactNode }) {
  return (
    <header className="app-header">
      <Link to="/" className="hdr-brand">
        <Logo />
        <span className="display" style={{ fontWeight: 600, fontSize: 18 }}>
          Dock
        </span>
      </Link>
      {right && <div className="hdr-actions">{right}</div>}
      <UserMenu />
    </header>
  )
}

export function UserMenu() {
  const { me, setMe } = useAuth()
  const { theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const nav = useNavigate()
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("click", h)
    return () => document.removeEventListener("click", h)
  }, [])
  if (!me) return null
  const initials = (me.name ?? me.email).slice(0, 2).toUpperCase()
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="btn sm"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        style={{ gap: 8 }}
      >
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: "var(--ac)",
            color: "var(--ac-fg)",
            display: "grid",
            placeItems: "center",
            fontSize: 10,
            fontWeight: 700,
          }}
        >
          {initials}
        </span>
        {me.name ?? me.email} ⌄
      </button>
      {open && (
        <div
          className="card"
          style={{ position: "absolute", right: 0, top: "calc(100% + 7px)", width: 200, padding: 6, boxShadow: "var(--shadow)", zIndex: 30 }}
        >
          <div className="mono" style={{ fontSize: 9.5, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--fg-mut)", padding: "6px 8px 4px" }}>
            Theme
          </div>
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => setTheme(t.id)}
              style={menuRow}
            >
              <span style={{ width: 13, height: 13, borderRadius: "50%", background: t.sw, border: "1px solid rgba(0,0,0,.12)" }} />
              {t.label}
              <span style={{ marginLeft: "auto", color: "var(--ac)", fontWeight: 700 }}>{theme === t.id ? "✓" : ""}</span>
            </button>
          ))}
          <div style={{ height: 1, background: "var(--line-soft)", margin: "5px 2px" }} />
          <button onClick={() => { setOpen(false); nav({ to: "/settings" }) }} style={menuRow}>
            Settings
          </button>
          <button
            onClick={async () => {
              await api.logout().catch(() => {})
              setMe(null)
              nav({ to: "/login" })
            }}
            style={{ ...menuRow, color: "var(--fg-mut)" }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}

const menuRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  width: "100%",
  border: 0,
  background: "transparent",
  color: "var(--fg)",
  font: "500 12.5px Inter,sans-serif",
  padding: "7px 8px",
  borderRadius: 7,
  cursor: "pointer",
  textAlign: "left",
}

export function useToast() {
  const [msg, setMsg] = useState("")
  const el = (
    <div className={`toast${msg ? " show" : ""}`}>{msg}</div>
  )
  const show = (m: string) => {
    setMsg(m)
    setTimeout(() => setMsg(""), 1900)
  }
  return { toast: el, show }
}
