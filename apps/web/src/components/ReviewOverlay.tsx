import { useEffect, useState } from "react"
import { API_BASE, api, type Proposal, type Role } from "../api"

const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/**
 * The review surface. A proposed version is rendered exactly like a live one so
 * a reviewer approves the EXPERIENCE, not a source dump — toggle Proposed ↔
 * Current, with the line diff demoted to a secondary tab for the code-y cases.
 * Self-contained overlay so it composes onto the artifact page with one button.
 */
export function ReviewOverlay({
  shortId,
  currentVersion,
  myRole,
  meName,
  onClose,
  onApplied,
}: {
  shortId: string
  currentVersion: number
  myRole?: Role | null
  meName?: string | null
  onClose: () => void
  onApplied: () => void
}) {
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [active, setActive] = useState<Proposal | null>(null)
  const [view, setView] = useState<"proposed" | "current" | "diff">("proposed")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const canApprove = myRole === "editor" || myRole === "owner"

  const load = () =>
    api
      .listProposals(shortId, "open")
      .then((r) => {
        setProposals(r.proposals)
        setActiveId((cur) =>
          cur && r.proposals.some((p) => p.id === cur) ? cur : (r.proposals[0]?.id ?? null),
        )
        if (r.proposals.length === 0) onClose()
      })
      .catch(() => {})

  useEffect(() => {
    load()
  }, [shortId])
  useEffect(() => {
    if (activeId)
      api
        .getProposal(shortId, activeId)
        .then(setActive)
        .catch(() => setActive(null))
    else setActive(null)
  }, [shortId, activeId])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      onApplied()
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Action failed")
    } finally {
      setBusy(false)
    }
  }

  const adds = active?.diff?.ops.filter((o) => o.t === "add").length ?? 0
  const dels = active?.diff?.ops.filter((o) => o.t === "del").length ?? 0
  const isAuthor = !!meName && active?.author === meName
  const src =
    view === "current"
      ? `${API_BASE}/raw/${shortId}/v/${currentVersion}/index.html`
      : active
        ? `${API_BASE}/raw/${shortId}/p/${active.id}/index.html`
        : "about:blank"

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top bar: what's proposed, by whom, and the close. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "11px 16px",
          borderBottom: "1px solid var(--line)",
          background: "var(--card)",
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: ".04em",
            textTransform: "uppercase",
            color: "var(--ac)",
            background: "var(--ac-soft)",
            borderRadius: 999,
            padding: "3px 9px",
          }}
        >
          Review
        </span>
        {active && (
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>
              {active.message ?? "Proposed change"}
            </div>
            <div className="muted" style={{ fontSize: 11.5 }}>
              {active.author} · proposed {ago(active.created_at)} · against v{active.base_version}
            </div>
          </div>
        )}
        {proposals.length > 1 && (
          <select
            className="input"
            value={activeId ?? ""}
            onChange={(e) => setActiveId(e.target.value)}
            style={{ width: 150, padding: "5px 8px", fontSize: 12, marginLeft: 8 }}
          >
            {proposals.map((p, i) => (
              <option key={p.id} value={p.id}>
                {p.message ? p.message.slice(0, 28) : `Proposal ${i + 1}`}
              </option>
            ))}
          </select>
        )}
        <span style={{ flex: 1 }} />
        {/* Proposed ↔ Current ↔ Diff */}
        <div style={{ display: "flex", gap: 4 }}>
          {(["proposed", "current", "diff"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={`chip${view === v ? " on" : ""}`}
              onClick={() => setView(v)}
              style={{ cursor: "pointer", textTransform: "capitalize" }}
            >
              {v}
            </button>
          ))}
        </div>
        <button className="btn sm" onClick={onClose} title="Close review">
          Close
        </button>
      </div>

      {/* Body: the experience (proposed or current), or the source diff. */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {view === "diff" ? (
          <div
            style={{ position: "absolute", inset: 0, overflow: "auto", background: "var(--card)" }}
          >
            <div
              style={{
                display: "flex",
                gap: 12,
                padding: "8px 16px",
                borderBottom: "1px solid var(--line-soft)",
                fontSize: 12,
                position: "sticky",
                top: 0,
                background: "var(--card)",
              }}
            >
              <span className="mono muted" style={{ marginRight: "auto" }}>
                v{active?.base_version} → proposed
              </span>
              <span className="mono" style={{ color: "var(--good)" }}>
                +{adds}
              </span>
              <span className="mono" style={{ color: "var(--bad)" }}>
                −{dels}
              </span>
            </div>
            <pre
              className="mono"
              style={{ margin: 0, padding: "10px 0", fontSize: 12.5, lineHeight: 1.6 }}
            >
              {(active?.diff?.ops ?? []).map((o, i) => (
                <div
                  key={i}
                  style={{
                    padding: "0 16px",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    background:
                      o.t === "add"
                        ? "var(--good-bg)"
                        : o.t === "del"
                          ? "var(--cmt-bg)"
                          : "transparent",
                  }}
                >
                  <span className="muted" style={{ userSelect: "none" }}>
                    {o.t === "add" ? "+ " : o.t === "del" ? "− " : "  "}
                  </span>
                  {o.line}
                </div>
              ))}
            </pre>
          </div>
        ) : (
          <iframe
            title="review"
            src={src}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              border: 0,
              background: "#fff",
            }}
          />
        )}
        {view === "proposed" && (
          <div
            style={{
              position: "absolute",
              top: 10,
              left: "50%",
              transform: "translateX(-50%)",
              fontSize: 11,
              fontWeight: 600,
              color: "var(--ac)",
              background: "var(--ac-soft)",
              border: "1px solid var(--ac)",
              borderRadius: 999,
              padding: "3px 12px",
              pointerEvents: "none",
            }}
          >
            Previewing the proposed version
          </div>
        )}
      </div>

      {/* Decision bar. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 16px",
          borderTop: "1px solid var(--line)",
          background: "var(--card)",
        }}
      >
        {err && <span style={{ color: "var(--bad)", fontSize: 12 }}>{err}</span>}
        <span style={{ flex: 1 }} />
        {isAuthor && active && (
          <button
            className="btn sm"
            disabled={busy}
            onClick={() => act(() => api.withdrawProposal(shortId, active.id))}
          >
            Withdraw
          </button>
        )}
        {canApprove && active ? (
          <>
            <button
              className="btn sm"
              disabled={busy}
              onClick={() => act(() => api.requestChanges(shortId, active.id))}
            >
              Request changes
            </button>
            <button
              className="btn pri sm"
              disabled={busy}
              onClick={() => act(() => api.approveProposal(shortId, active.id))}
            >
              {busy ? "Approving…" : "Approve & publish"}
            </button>
          </>
        ) : (
          !isAuthor && (
            <span className="muted" style={{ fontSize: 12 }}>
              Only an editor can approve.
            </span>
          )
        )}
      </div>
    </div>
  )
}
