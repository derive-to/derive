import { Link, useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState } from "react"
import { api, type Notification } from "./api"
import { THEMES, useAuth, useTheme } from "./ctx"

const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export const Logo = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
    <rect x="1" y="1" width="30" height="30" rx="8" fill="#2a2540" />
    <path
      d="M16 7l7 7v11h-4.6v-6.2h-4.8V25H9V14l7-7z"
      fill="none"
      stroke="#8a7dc0"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
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

export function Header({ left, right }: { left?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header className="app-header">
      {left}
      <Link to="/" className="hdr-brand">
        <Logo />
        <span className="display" style={{ fontWeight: 600, fontSize: 18 }}>
          Dock
        </span>
      </Link>
      {right && <div className="hdr-actions">{right}</div>}
      <NotificationBell />
      <UserMenu />
    </header>
  )
}

// Header bell: unread badge + a panel of recent @mentions, kept live over SSE.
// Clicking an item deep-links to its comment thread (?c=) and marks it read.
export function NotificationBell() {
  const { me } = useAuth()
  const nav = useNavigate()
  const [items, setItems] = useState<Notification[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    api
      .notifications()
      .then((r) => {
        setItems(r.notifications)
        setUnread(r.unread)
      })
      .catch(() => {})
  }, [])

  // Initial load + live updates. EventSource reconnects on its own.
  useEffect(() => {
    if (!me) return
    load()
    const ev = new EventSource(api.notificationsStreamUrl(), { withCredentials: true })
    ev.addEventListener("notification", load)
    return () => ev.close()
  }, [me, load])

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("click", h)
    return () => document.removeEventListener("click", h)
  }, [])

  if (!me) return null

  const openItem = (n: Notification) => {
    setOpen(false)
    if (!n.read) {
      setUnread((u) => Math.max(0, u - 1))
      setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, read: 1 } : x)))
      api
        .markNotificationsRead({ ids: [n.id] })
        .then((r) => setUnread(r.unread))
        .catch(() => {})
    }
    nav({ to: "/a/$ref", params: { ref: n.artifact_short_id }, search: { c: n.thread_id } })
  }

  const markAll = () => {
    setUnread(0)
    setItems((cur) => cur.map((x) => ({ ...x, read: 1 })))
    api
      .markNotificationsRead({ all: true })
      .then((r) => setUnread(r.unread))
      .catch(() => {})
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="btn sm icon-btn"
        title="Notifications"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        style={{ position: "relative" }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6.2.3.5 0 1.3-.7 1.3H4.7c-.7 0-1-.8-.7-1.3.5-.7 2-2.2 2-6.2Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M9.5 19a2.5 2.5 0 0 0 5 0" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        {unread > 0 && <span className="notif-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div
          className="card"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 7px)",
            width: 330,
            padding: 0,
            boxShadow: "var(--shadow)",
            zIndex: 30,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "9px 12px",
              borderBottom: "1px solid var(--line-soft)",
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 13 }}>Notifications</span>
            {unread > 0 && (
              <button className="lnk" onClick={markAll} style={{ fontSize: 11.5 }}>
                Mark all read
              </button>
            )}
          </div>
          <div style={{ maxHeight: 380, overflow: "auto" }}>
            {items.length === 0 ? (
              <div
                className="muted"
                style={{ padding: "22px 12px", fontSize: 12, textAlign: "center" }}
              >
                Nothing yet
              </div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => openItem(n)}
                  className="notif-item"
                  style={{ background: n.read ? "transparent" : "var(--ac-soft)" }}
                >
                  <span className={`notif-dot${n.read ? " read" : ""}`} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ fontSize: 12.5, color: "var(--fg)", display: "block" }}>
                      <strong>{n.actor}</strong>{" "}
                      {n.kind === "mention" ? "mentioned you" : "commented"}
                      {n.artifact_title ? (
                        <>
                          {" in "}
                          <strong>{n.artifact_title}</strong>
                        </>
                      ) : null}
                    </span>
                    <span className="notif-preview">{n.preview}</span>
                    <span
                      className="mono"
                      style={{ fontSize: 10, color: "var(--fg-mut)", display: "block" }}
                    >
                      {ago(n.created_at)}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
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
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 7px)",
            width: 200,
            padding: 6,
            boxShadow: "var(--shadow)",
            zIndex: 30,
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: 9.5,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: "var(--fg-mut)",
              padding: "6px 8px 4px",
            }}
          >
            Theme
          </div>
          {THEMES.map((t) => (
            <button key={t.id} onClick={() => setTheme(t.id)} style={menuRow}>
              <span
                style={{
                  width: 13,
                  height: 13,
                  borderRadius: "50%",
                  background: t.sw,
                  border: "1px solid rgba(0,0,0,.12)",
                }}
              />
              {t.label}
              <span style={{ marginLeft: "auto", color: "var(--ac)", fontWeight: 700 }}>
                {theme === t.id ? "✓" : ""}
              </span>
            </button>
          ))}
          <div style={{ height: 1, background: "var(--line-soft)", margin: "5px 2px" }} />
          <button
            onClick={() => {
              setOpen(false)
              nav({ to: "/settings" })
            }}
            style={menuRow}
          >
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
  const el = <div className={`toast${msg ? " show" : ""}`}>{msg}</div>
  const show = (m: string) => {
    setMsg(m)
    setTimeout(() => setMsg(""), 1900)
  }
  return { toast: el, show }
}
