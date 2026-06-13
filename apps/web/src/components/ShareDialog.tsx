import { useEffect, useRef, useState } from "react"
import { type ArtifactMember, api, type Role } from "../api"

const ROLES: Role[] = ["viewer", "commenter", "editor", "owner"]
const BLURB: Record<Role, string> = {
  viewer: "Can view",
  commenter: "Can view and comment",
  editor: "Can publish new versions",
  owner: "Full control, incl. sharing",
}

/**
 * Per-artifact sharing, as a header popover that mirrors Insights/History. Only
 * an owner of this artifact can change shares; everyone else sees nothing. Kept
 * fully self-contained (no shared Dialog primitive, no edits to the comment
 * sidebar) so it composes into the artifact header with a single line.
 */
export function ShareButton({ shortId, myRole }: { shortId: string; myRole?: Role | null }) {
  const [open, setOpen] = useState(false)
  const [members, setMembers] = useState<ArtifactMember[]>([])
  const [defaultRole, setDefaultRole] = useState<Role>("editor")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("editor")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("click", h)
    return () => document.removeEventListener("click", h)
  }, [])

  const load = () =>
    api
      .listMembers(shortId)
      .then((r) => {
        setMembers(r.members)
        setDefaultRole(r.default_role)
      })
      .catch(() => {})
  useEffect(() => {
    if (open) load()
  }, [open, shortId])

  // Only an owner can manage shares; hide the affordance otherwise.
  if (myRole !== "owner") return null

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const addr = email.trim()
    if (!addr) return
    setBusy(true)
    setErr(null)
    try {
      await api.setMember(shortId, addr, role)
      setEmail("")
      await load()
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Could not share")
    } finally {
      setBusy(false)
    }
  }
  const change = async (m: ArtifactMember, next: Role) => {
    if (next === m.role || !m.email) return
    await api.setMember(shortId, m.email, next).catch(() => {})
    await load()
  }
  const remove = async (m: ArtifactMember) => {
    await api.removeMember(shortId, m.user_id).catch(() => {})
    await load()
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="btn sm"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        style={{ gap: 6 }}
        title="Share this artifact"
      >
        <span style={{ fontSize: 12 }}>🔗</span>
        Share
      </button>
      {open && (
        <div
          className="card"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 7px)",
            width: 330,
            padding: 14,
            boxShadow: "var(--shadow)",
            zIndex: 30,
          }}
        >
          <div
            className="mono muted"
            style={{
              fontSize: 9.5,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              marginBottom: 8,
            }}
          >
            People with access
          </div>

          <form onSubmit={add} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
            <input
              className="input"
              type="email"
              placeholder="teammate@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ flex: 1, padding: "7px 9px", fontSize: 13 }}
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="input"
              style={{ width: 104, padding: "7px 6px", fontSize: 12 }}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button className="btn pri sm" type="submit" disabled={busy}>
              {busy ? "…" : "Add"}
            </button>
          </form>
          <div className="mono muted" style={{ fontSize: 10, marginBottom: 10 }}>
            {BLURB[role]}.
          </div>
          {err && <div style={{ color: "var(--bad)", fontSize: 11.5, marginBottom: 8 }}>{err}</div>}

          {members.length === 0 ? (
            <div className="muted" style={{ fontSize: 11.5 }}>
              No one shared yet. Everyone else is a <b>{defaultRole}</b> by default.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {members.map((m) => (
                <div key={m.user_id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {m.name ?? m.email ?? m.user_id}
                    </div>
                    {m.name && m.email && (
                      <div className="muted" style={{ fontSize: 10.5 }}>
                        {m.email}
                      </div>
                    )}
                  </div>
                  <select
                    value={m.role}
                    onChange={(e) => change(m, e.target.value as Role)}
                    className="input"
                    style={{ width: 96, padding: "5px 6px", fontSize: 11.5 }}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button
                    className="lnk"
                    onClick={() => remove(m)}
                    title="Remove"
                    style={{ textDecoration: "none", fontSize: 14 }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
