import { useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { api, type Delivery, type Webhook } from "../api"
import { Header, useToast } from "../components"
import { useAuth } from "../ctx"

const ALL_EVENTS = ["comment.created", "comment.resolved", "version.published"] as const

export function Settings() {
  const { me, loading } = useAuth()
  const nav = useNavigate()
  const { toast, show } = useToast()
  const [hooks, setHooks] = useState<Webhook[] | null>(null)

  useEffect(() => {
    if (!loading && !me) nav({ to: "/login" })
  }, [loading, me, nav])
  const load = () =>
    api
      .listWebhooks()
      .then((r) => setHooks(r.webhooks))
      .catch(() => setHooks([]))
  useEffect(() => {
    if (me) load()
  }, [me])

  if (!me)
    return (
      <div className="center">
        <div className="spin" />
      </div>
    )

  return (
    <div style={{ minHeight: "100%" }}>
      <Header />
      <main style={{ maxWidth: 760, margin: "0 auto", padding: "26px 22px 60px" }}>
        <h2 className="display" style={{ fontSize: 22, margin: "0 0 4px" }}>
          Settings
        </h2>
        <p className="muted" style={{ margin: "0 0 26px", fontSize: 14 }}>
          Notifications and integrations for this workspace.
        </p>

        <section>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
            <h3 className="display" style={{ fontSize: 16, margin: 0 }}>
              Webhooks &amp; Slack
            </h3>
            <span className="muted" style={{ fontSize: 13 }}>
              · {hooks?.length ?? 0}
            </span>
          </div>
          <p className="muted" style={{ fontSize: 13, margin: "0 0 16px" }}>
            Get a POST (or a Slack message) when a comment is added or resolved, or a new version is
            published. Generic payloads are signed with{" "}
            <code className="mono">X-Dock-Signature</code>.
          </p>

          <NewWebhook
            onCreated={(msg) => {
              show(msg)
              load()
            }}
          />

          <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 11 }}>
            {hooks === null ? (
              <div className="center" style={{ height: 80 }}>
                <div className="spin" />
              </div>
            ) : hooks.length === 0 ? (
              <div
                className="muted"
                style={{
                  textAlign: "center",
                  padding: 28,
                  border: "1px dashed var(--line)",
                  borderRadius: 12,
                  fontSize: 13,
                }}
              >
                No webhooks yet. Add one above.
              </div>
            ) : (
              hooks.map((w) => (
                <WebhookRow
                  key={w.id}
                  hook={w}
                  onChanged={(m) => {
                    show(m)
                    load()
                  }}
                  onError={show}
                />
              ))
            )}
          </div>
        </section>
      </main>
      {toast}
    </div>
  )
}

function NewWebhook({ onCreated }: { onCreated: (msg: string) => void }) {
  const [url, setUrl] = useState("")
  const [kind, setKind] = useState<"generic" | "slack">("generic")
  const [events, setEvents] = useState<string[]>([...ALL_EVENTS])
  const [busy, setBusy] = useState(false)
  const toggle = (e: string) =>
    setEvents((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]))
  const add = async () => {
    if (!/^https?:\/\//.test(url)) return
    setBusy(true)
    try {
      await api.createWebhook({
        url,
        kind,
        events: events.length === ALL_EVENTS.length ? undefined : events,
      })
      setUrl("")
      onCreated("Webhook added")
    } catch (e) {
      onCreated((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select
          className="input"
          value={kind}
          onChange={(e) => setKind(e.target.value as "generic" | "slack")}
          style={{ width: 110, padding: "8px 9px" }}
        >
          <option value="generic">Webhook</option>
          <option value="slack">Slack</option>
        </select>
        <input
          className="input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={
            kind === "slack"
              ? "Slack incoming-webhook URL"
              : "https://your-endpoint.example.com/hook"
          }
          style={{ flex: 1, minWidth: 240 }}
        />
        <button className="btn pri" onClick={add} disabled={busy || !/^https?:\/\//.test(url)}>
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 11, flexWrap: "wrap" }}>
        {ALL_EVENTS.map((e) => (
          <label
            key={e}
            className="mono"
            style={{
              fontSize: 11.5,
              display: "flex",
              alignItems: "center",
              gap: 5,
              color: "var(--fg-mut)",
              cursor: "pointer",
            }}
          >
            <input type="checkbox" checked={events.includes(e)} onChange={() => toggle(e)} />
            {e}
          </label>
        ))}
      </div>
    </div>
  )
}

function WebhookRow({
  hook,
  onChanged,
  onError,
}: {
  hook: Webhook
  onChanged: (m: string) => void
  onError: (m: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null)
  const showLog = async () => {
    const next = !open
    setOpen(next)
    if (next)
      api
        .webhookDeliveries(hook.id)
        .then((r) => setDeliveries(r.deliveries))
        .catch(() => setDeliveries([]))
  }
  const test = async () => {
    try {
      await api.testWebhook(hook.id)
      onChanged("Test event queued")
      if (open)
        setTimeout(
          () => api.webhookDeliveries(hook.id).then((r) => setDeliveries(r.deliveries)),
          1500,
        )
    } catch (e) {
      onError((e as Error).message)
    }
  }
  const remove = async () => {
    try {
      await api.deleteWebhook(hook.id)
      onChanged("Webhook removed")
    } catch (e) {
      onError((e as Error).message)
    }
  }
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 11, padding: "12px 14px" }}>
        <span
          className="mono"
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            padding: "2px 8px",
            borderRadius: 999,
            background: hook.kind === "slack" ? "var(--ac-soft)" : "var(--card-2)",
            color: hook.kind === "slack" ? "var(--ac)" : "var(--fg-mut)",
          }}
        >
          {hook.kind === "slack" ? "Slack" : "Webhook"}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            className="mono"
            style={{
              fontSize: 12,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {hook.url}
          </div>
          <div className="mono muted" style={{ fontSize: 10, marginTop: 1 }}>
            {hook.events === "*" ? "all events" : hook.events.split(",").join(" · ")}
          </div>
        </div>
        <button className="btn sm" onClick={showLog}>
          {open ? "Hide" : "Log"}
        </button>
        <button className="btn sm" onClick={test}>
          Test
        </button>
        <button className="btn sm" onClick={remove} style={{ color: "var(--bad)" }}>
          Remove
        </button>
      </div>
      {open && (
        <div
          style={{
            borderTop: "1px solid var(--line-soft)",
            padding: "8px 14px",
            background: "var(--card-2)",
          }}
        >
          {deliveries === null ? (
            <div className="muted" style={{ fontSize: 12 }}>
              Loading…
            </div>
          ) : deliveries.length === 0 ? (
            <div className="muted" style={{ fontSize: 12 }}>
              No deliveries yet. Hit Test.
            </div>
          ) : (
            deliveries.map((d) => (
              <div
                key={d.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  fontSize: 11.5,
                  padding: "3px 0",
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    padding: "1px 7px",
                    borderRadius: 999,
                    background:
                      d.status === "delivered"
                        ? "var(--good-bg)"
                        : d.status === "dead"
                          ? "var(--cmt-bg)"
                          : "var(--warn-bg, var(--card))",
                    color:
                      d.status === "delivered"
                        ? "var(--good)"
                        : d.status === "dead"
                          ? "var(--bad)"
                          : "var(--fg-mut)",
                  }}
                >
                  {d.status}
                </span>
                <span className="mono muted">{d.event_type}</span>
                {d.attempts > 1 && <span className="mono muted">· {d.attempts} tries</span>}
                {d.last_error && (
                  <span
                    className="mono"
                    style={{
                      color: "var(--bad)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    · {d.last_error}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
