import { useEffect, useState } from "react"
import { API_BASE, api, type Proposal, type ProposalState, type Role } from "../api"

const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** True while the viewport is phone-width; the rail collapses to a dropdown. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    typeof window !== "undefined" ? window.matchMedia("(max-width: 820px)").matches : false,
  )
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 820px)")
    const on = () => setNarrow(mq.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  return narrow
}

const ellipsis: React.CSSProperties = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
}

const STATE_META: Record<ProposalState, { label: string; color: string; soft: string }> = {
  open: { label: "Open", color: "var(--ac)", soft: "var(--ac-soft)" },
  approved: { label: "Approved", color: "var(--good)", soft: "var(--good-bg)" },
  changes_requested: { label: "Changes requested", color: "var(--bad)", soft: "var(--cmt-bg)" },
  withdrawn: { label: "Withdrawn", color: "var(--fg-mut)", soft: "var(--bg)" },
}

function StateBadge({ state }: { state: ProposalState }) {
  const m = STATE_META[state]
  return (
    <span
      className="mono"
      style={{
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: ".03em",
        color: m.color,
        background: m.soft,
        border: `1px solid ${m.color}`,
        borderRadius: 999,
        padding: "1px 7px",
        whiteSpace: "nowrap",
      }}
    >
      {m.label}
    </span>
  )
}

/**
 * The review surface. A proposed version is rendered exactly like a live one so
 * a reviewer approves the EXPERIENCE, not a source dump — toggle Proposed ↔
 * Current to compare, with the line diff demoted to a third tab for code-y
 * cases. A queue rail lists every proposal with its state and the reviewer's
 * note, so both proposer and reviewer always see status and feedback in one
 * place. Self-contained overlay; composes onto the artifact page with one button.
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
  const narrow = useNarrow()
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [active, setActive] = useState<Proposal | null>(null)
  const [view, setView] = useState<"proposed" | "current" | "diff">("proposed")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [noteFor, setNoteFor] = useState<"changes" | "approve" | null>(null)
  const [note, setNote] = useState("")

  const canApprove = myRole === "editor" || myRole === "owner"

  const load = () =>
    api
      .listProposals(shortId)
      .then((r) => {
        const live = r.proposals.filter((p) => p.state !== "withdrawn")
        setProposals(live)
        if (live.length === 0) {
          onClose()
          return
        }
        setActiveId((cur) => {
          if (cur && live.some((p) => p.id === cur)) return cur
          return (live.find((p) => p.state === "open") ?? live[0]).id
        })
      })
      .catch(() => {})

  useEffect(() => {
    load()
  }, [shortId])
  // Refetch the detail when the selection changes OR when the selected
  // proposal's state flips in the list (e.g. just approved / changes-requested),
  // so the decision note and state badge update without reselecting.
  const activeState = proposals.find((p) => p.id === activeId)?.state
  useEffect(() => {
    if (activeId)
      api
        .getProposal(shortId, activeId)
        .then(setActive)
        .catch(() => setActive(null))
    else setActive(null)
  }, [shortId, activeId, activeState])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      setNoteFor(null)
      setNote("")
      onApplied()
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Action failed")
    } finally {
      setBusy(false)
    }
  }

  const open = proposals.filter((p) => p.state === "open")
  const decided = proposals.filter((p) => p.state !== "open")
  const adds = active?.diff?.ops.filter((o) => o.t === "add").length ?? 0
  const dels = active?.diff?.ops.filter((o) => o.t === "del").length ?? 0
  const isAuthor = !!meName && active?.author === meName
  const isOpen = active?.state === "open"
  // Stale base: proposed against an older version than what's now live. Approving
  // replaces the newer live version wholesale, so we warn and confirm — no merge.
  const stale = !!active && isOpen && active.base_version !== currentVersion
  const src =
    view === "current"
      ? `${API_BASE}/raw/${shortId}/v/${currentVersion}/index.html`
      : active
        ? `${API_BASE}/raw/${shortId}/p/${active.id}/index.html`
        : "about:blank"

  const strip =
    view === "proposed"
      ? { text: "Viewing the proposed version — not live yet", accent: true }
      : view === "current"
        ? { text: `Viewing the current live version (v${currentVersion})`, accent: false }
        : { text: `Source diff · v${active?.base_version ?? "?"} → proposed`, accent: false }

  const Toggle = (
    <div style={{ display: "flex", gap: 4, flex: "0 0 auto" }}>
      {(["proposed", "current", "diff"] as const).map((v) => (
        <button
          key={v}
          type="button"
          className={`chip${view === v ? " on" : ""}`}
          onClick={() => setView(v)}
          style={{ cursor: "pointer", textTransform: "capitalize", padding: "4px 11px" }}
        >
          {v}
        </button>
      ))}
    </div>
  )

  const RailItem = ({ p }: { p: Proposal }) => (
    <button
      type="button"
      onClick={() => setActiveId(p.id)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        border: 0,
        borderLeft: `3px solid ${p.id === activeId ? "var(--ac)" : "transparent"}`,
        background: p.id === activeId ? "var(--ac-soft)" : "transparent",
        padding: "9px 12px",
        cursor: "pointer",
        font: "inherit",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
        <StateBadge state={p.state} />
        <span className="muted" style={{ fontSize: 10.5, marginLeft: "auto" }}>
          {ago(p.created_at)}
        </span>
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 600, ...ellipsis }}>
        {p.message ?? "Proposed change"}
      </div>
      <div className="muted" style={{ fontSize: 11, ...ellipsis }}>
        {p.author}
      </div>
    </button>
  )

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
      {/* Top bar: selected proposal identity + view controls. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: narrow ? "9px 12px" : "10px 18px",
          borderBottom: "1px solid var(--line)",
          background: "var(--card)",
          flexWrap: narrow ? "wrap" : "nowrap",
        }}
      >
        <span
          className="mono"
          style={{
            flex: "0 0 auto",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: ".05em",
            color: "var(--ac)",
            background: "var(--ac-soft)",
            borderRadius: 999,
            padding: "4px 10px",
          }}
        >
          REVIEW
        </span>
        <div style={{ flex: 1, minWidth: narrow ? "55%" : 120 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, ...ellipsis }}>
              {active?.message ?? "Proposed change"}
            </span>
            {active && !narrow && <StateBadge state={active.state} />}
          </div>
          <div className="muted" style={{ fontSize: 11.5, ...ellipsis }}>
            {active ? `${active.author} · proposed ${ago(active.created_at)}` : "Loading…"}
          </div>
        </div>
        {/* On phones, switch proposals via a dropdown instead of the side rail. */}
        {narrow && proposals.length > 1 && (
          <select
            className="input"
            value={activeId ?? ""}
            onChange={(e) => setActiveId(e.target.value)}
            style={{ width: 150, padding: "5px 8px", fontSize: 12, flex: "0 0 auto" }}
          >
            {proposals.map((p, i) => (
              <option key={p.id} value={p.id}>
                {(p.message ? p.message.slice(0, 26) : `Proposal ${i + 1}`) +
                  (p.state === "open" ? "" : ` · ${STATE_META[p.state].label}`)}
              </option>
            ))}
          </select>
        )}
        {!narrow && Toggle}
        <button
          className="btn sm"
          onClick={onClose}
          title="Close review"
          style={{ flex: "0 0 auto" }}
        >
          Close
        </button>
        {narrow && (
          <div style={{ width: "100%", display: "flex", justifyContent: "center" }}>{Toggle}</div>
        )}
      </div>

      {/* Context strip. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 18px",
          fontSize: 12,
          fontWeight: 500,
          color: strip.accent ? "var(--ac)" : "var(--fg-mut)",
          background: strip.accent ? "var(--ac-soft)" : "var(--card)",
          borderBottom: "1px solid var(--line-soft)",
          borderLeft: `3px solid ${strip.accent ? "var(--ac)" : "var(--line)"}`,
        }}
      >
        {strip.text}
        {view === "diff" && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 12 }}>
            <span className="mono" style={{ color: "var(--good)" }}>
              +{adds}
            </span>
            <span className="mono" style={{ color: "var(--bad)" }}>
              −{dels}
            </span>
          </span>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {/* Queue + history rail (desktop). Open proposals first, then decided. */}
        {!narrow && (
          <div
            style={{
              width: 232,
              flex: "0 0 232px",
              borderRight: "1px solid var(--line)",
              background: "var(--card)",
              overflowY: "auto",
            }}
          >
            {open.length > 0 && (
              <div
                className="mono muted"
                style={{
                  fontSize: 9.5,
                  letterSpacing: ".06em",
                  textTransform: "uppercase",
                  padding: "10px 12px 4px",
                }}
              >
                Awaiting review ({open.length})
              </div>
            )}
            {open.map((p) => (
              <RailItem key={p.id} p={p} />
            ))}
            {decided.length > 0 && (
              <div
                className="mono muted"
                style={{
                  fontSize: 9.5,
                  letterSpacing: ".06em",
                  textTransform: "uppercase",
                  padding: "14px 12px 4px",
                }}
              >
                Decided ({decided.length})
              </div>
            )}
            {decided.map((p) => (
              <RailItem key={p.id} p={p} />
            ))}
          </div>
        )}

        {/* Body: the rendered experience, or the source diff. */}
        <div style={{ flex: 1, minWidth: 0, position: "relative", background: "var(--card)" }}>
          {/* Reviewer feedback on a decided proposal — what the proposer reads. */}
          {active && !isOpen && active.decision_note && (
            <div
              style={{
                padding: "10px 18px",
                fontSize: 12.5,
                lineHeight: 1.5,
                borderBottom: "1px solid var(--line-soft)",
                background: STATE_META[active.state].soft,
              }}
            >
              <b style={{ color: STATE_META[active.state].color }}>
                {STATE_META[active.state].label}
                {active.decided_by ? ` by ${active.decided_by}` : ""}:
              </b>{" "}
              {active.decision_note}
            </div>
          )}
          {/* Stale-base warning: this was proposed against an older live version. */}
          {stale && active && (
            <div
              style={{
                padding: "10px 18px",
                fontSize: 12.5,
                lineHeight: 1.5,
                borderBottom: "1px solid var(--line-soft)",
                background: "var(--cmt-bg)",
              }}
            >
              <b style={{ color: "var(--bad)" }}>Out of date:</b> proposed against v
              {active.base_version}, but the live version is now v{currentVersion}. Approving
              replaces v{currentVersion} entirely — compare against{" "}
              <button
                type="button"
                className="lnk"
                onClick={() => setView("current")}
                style={{ cursor: "pointer" }}
              >
                Current
              </button>{" "}
              before approving.
            </div>
          )}
          <div
            style={{
              position: "absolute",
              inset: 0,
              top: (active && !isOpen && active.decision_note) || stale ? 44 : 0,
            }}
          >
            {view === "diff" ? (
              <pre
                className="mono"
                style={{
                  position: "absolute",
                  inset: 0,
                  overflow: "auto",
                  margin: 0,
                  padding: "12px 0",
                  fontSize: 12.5,
                  lineHeight: 1.65,
                }}
              >
                {(active?.diff?.ops ?? []).map((o, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "0 18px",
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
            ) : (
              <iframe
                title="review"
                src={src}
                sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
                style={{ width: "100%", height: "100%", border: 0, background: "#fff" }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Decision bar. Request-changes opens an inline note composer first. */}
      <div
        style={{
          borderTop: "1px solid var(--line)",
          background: "var(--card)",
        }}
      >
        {noteFor && (
          <div style={{ padding: "10px 18px 0" }}>
            {noteFor === "approve" && (
              <div style={{ fontSize: 12.5, marginBottom: 8, lineHeight: 1.5 }}>
                {stale ? (
                  <span style={{ color: "var(--bad)" }}>
                    <b>Heads up:</b> this was proposed against v{active?.base_version}, but the live
                    version is now v{currentVersion}. Approving replaces v{currentVersion} entirely.
                    Approve anyway?
                  </span>
                ) : (
                  <span className="muted">
                    This publishes the proposed version as the new live v{currentVersion + 1}.
                    Approve?
                  </span>
                )}
              </div>
            )}
            <textarea
              className="input"
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                noteFor === "changes"
                  ? "What should change? This goes back to the proposer."
                  : "Optional note to the proposer (e.g. why you approved)"
              }
              style={{ width: "100%", minHeight: 54, resize: "vertical", fontSize: 13 }}
            />
          </div>
        )}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: narrow ? "10px 12px" : "11px 18px",
          }}
        >
          {err ? (
            <span style={{ color: "var(--bad)", fontSize: 12.5 }}>{err}</span>
          ) : (
            isOpen &&
            canApprove &&
            !narrow &&
            !noteFor && (
              <span className="muted" style={{ fontSize: 12 }}>
                Approving publishes this as the new live version.
              </span>
            )
          )}
          <span style={{ flex: 1 }} />

          {noteFor ? (
            <>
              <button
                className="btn sm"
                disabled={busy}
                onClick={() => {
                  setNoteFor(null)
                  setNote("")
                }}
              >
                Cancel
              </button>
              {noteFor === "changes" ? (
                <button
                  className="btn pri sm"
                  disabled={busy || !note.trim()}
                  onClick={() =>
                    active && act(() => api.requestChanges(shortId, active.id, note.trim()))
                  }
                >
                  {busy ? "Sending…" : "Send request"}
                </button>
              ) : (
                <button
                  className="btn pri sm"
                  disabled={busy}
                  onClick={() =>
                    active &&
                    act(() => api.approveProposal(shortId, active.id, note.trim() || undefined))
                  }
                >
                  {busy ? "Approving…" : stale ? "Approve anyway" : "Approve & publish"}
                </button>
              )}
            </>
          ) : (
            isOpen &&
            active && (
              <>
                {isAuthor && (
                  <button
                    className="btn sm"
                    disabled={busy}
                    onClick={() => act(() => api.withdrawProposal(shortId, active.id))}
                  >
                    Withdraw
                  </button>
                )}
                {canApprove ? (
                  <>
                    <button
                      className="btn sm"
                      disabled={busy}
                      onClick={() => setNoteFor("changes")}
                    >
                      Request changes
                    </button>
                    <button
                      className="btn pri sm"
                      disabled={busy}
                      onClick={() => setNoteFor("approve")}
                    >
                      Approve & publish
                    </button>
                  </>
                ) : (
                  !isAuthor && (
                    <span className="muted" style={{ fontSize: 12 }}>
                      Only an editor can approve.
                    </span>
                  )
                )}
              </>
            )
          )}
        </div>
      </div>
    </div>
  )
}
