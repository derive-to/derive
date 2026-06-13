import { useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import {
  type Agent,
  type ArtifactMember,
  api,
  type Delivery,
  type Role,
  type Webhook,
  type Workspace,
} from "../api"
import { Header, useToast } from "../components"
import { useAuth } from "../ctx"

const ALL_EVENTS = ["comment.created", "comment.resolved", "version.published"] as const

// Workspace membership, presented as three simple roles. The values are the
// canonical Role vocabulary; the labels are what people see.
const WS_ROLES: { value: Role; label: string; hint: string }[] = [
  { value: "owner", label: "Admin", hint: "Add people, manage settings" },
  { value: "editor", label: "Creator", hint: "Create & publish" },
  { value: "commenter", label: "Viewer", hint: "Read & comment" },
]
const roleLabel = (r: Role): string => WS_ROLES.find((x) => x.value === r)?.label ?? "Viewer"
// A historical bare "viewer" maps onto the Viewer (commenter) option.
const roleValue = (r: Role): Role => (r === "viewer" ? "commenter" : r)

export function Settings() {
  const { me, loading } = useAuth()
  const nav = useNavigate()
  const { toast, show } = useToast()
  const [hooks, setHooks] = useState<Webhook[] | null>(null)
  const [agents, setAgents] = useState<Agent[] | null>(null)

  useEffect(() => {
    if (!loading && !me) nav({ to: "/login" })
  }, [loading, me, nav])
  const load = () =>
    api
      .listWebhooks()
      .then((r) => setHooks(r.webhooks))
      .catch(() => setHooks([]))
  const loadAgents = () =>
    api
      .listAgents()
      .then((r) => setAgents(r.agents))
      .catch(() => setAgents([]))
  useEffect(() => {
    if (me) {
      load()
      loadAgents()
    }
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
          Your workspace, members, and integrations.
        </p>

        <WorkspaceSection meId={me.id} show={show} />

        <section style={{ marginTop: 38 }}>
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

        <section style={{ marginTop: 38 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
            <h3 className="display" style={{ fontSize: 16, margin: 0 }}>
              Agents
            </h3>
            <span className="muted" style={{ fontSize: 13 }}>
              · {agents?.length ?? 0}
            </span>
          </div>
          <p className="muted" style={{ fontSize: 13, margin: "0 0 16px" }}>
            Register an agent so people can <code className="mono">@mention</code> it in a thread.
            It gets a scoped token and acts as a commenter — it can propose changes for review, but
            a human still approves. The agent reads its mentions from{" "}
            <code className="mono">GET /v1/agent/inbox</code> with its token.
          </p>

          <NewAgent
            onCreated={(msg) => {
              show(msg)
              loadAgents()
            }}
          />

          <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 11 }}>
            {agents === null ? (
              <div className="center" style={{ height: 80 }}>
                <div className="spin" />
              </div>
            ) : agents.length === 0 ? (
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
                No agents yet. Add one above.
              </div>
            ) : (
              agents.map((a) => (
                <AgentRow
                  key={a.id}
                  agent={a}
                  onChanged={(m) => {
                    show(m)
                    loadAgents()
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

function WorkspaceSection({ meId, show }: { meId: string; show: (m: string) => void }) {
  const [ws, setWs] = useState<Workspace | null>(null)
  const [name, setName] = useState("")
  const [savingName, setSavingName] = useState(false)
  const [email, setEmail] = useState("")
  const [addRole, setAddRole] = useState<Role>("commenter")
  const [adding, setAdding] = useState(false)

  const load = () =>
    api
      .getWorkspace()
      .then((w) => {
        setWs(w)
        setName(w.name)
      })
      .catch(() => setWs(null))
  useEffect(() => {
    load()
  }, [])

  const isAdmin = ws?.role === "owner"

  const saveName = async () => {
    const n = name.trim()
    if (!n || n === ws?.name) return
    setSavingName(true)
    try {
      const r = await api.renameWorkspace(n)
      setWs((w) => (w ? { ...w, name: r.name } : w))
      show("Workspace renamed")
    } catch (e) {
      show((e as Error).message)
    } finally {
      setSavingName(false)
    }
  }

  const addMember = async () => {
    const em = email.trim()
    if (!em) return
    setAdding(true)
    try {
      await api.addWorkspaceMember(em, addRole)
      setEmail("")
      show("Member added")
      load()
    } catch (e) {
      show((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  const changeRole = async (userId: string, role: Role) => {
    try {
      await api.setWorkspaceMemberRole(userId, role)
      setWs((w) =>
        w
          ? { ...w, members: w.members.map((m) => (m.user_id === userId ? { ...m, role } : m)) }
          : w,
      )
      show("Role updated")
    } catch (e) {
      show((e as Error).message)
      load()
    }
  }

  const removeMember = async (m: ArtifactMember) => {
    if (!confirm(`Remove ${m.name ?? m.email ?? "this member"} from the workspace?`)) return
    try {
      await api.removeWorkspaceMember(m.user_id)
      setWs((w) => (w ? { ...w, members: w.members.filter((x) => x.user_id !== m.user_id) } : w))
      show("Member removed")
    } catch (e) {
      show((e as Error).message)
    }
  }

  return (
    <section>
      <h3 className="display" style={{ fontSize: 16, margin: "0 0 4px" }}>
        Workspace
      </h3>
      <p className="muted" style={{ fontSize: 13, margin: "0 0 16px" }}>
        Name your workspace and choose who's in it. <strong>Admins</strong> add people,{" "}
        <strong>Creators</strong> publish artifacts, <strong>Viewers</strong> read and comment.
      </p>

      <div className="card" style={{ padding: 16 }}>
        <div className="muted" style={{ fontSize: 12, fontWeight: 600 }}>
          Workspace name
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!isAdmin || ws === null}
            maxLength={80}
            placeholder="My Workspace"
            style={{ flex: 1 }}
          />
          {isAdmin && (
            <button
              className="btn pri"
              onClick={saveName}
              disabled={savingName || !name.trim() || name.trim() === ws?.name}
            >
              {savingName ? "Saving…" : "Save"}
            </button>
          )}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 10, margin: "22px 0 4px" }}>
        <h4 className="display" style={{ fontSize: 14, margin: 0 }}>
          Members
        </h4>
        <span className="muted" style={{ fontSize: 13 }}>
          · {ws?.members.length ?? 0}
        </span>
      </div>

      {isAdmin && (
        <div className="card" style={{ padding: 16, marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              className="input"
              placeholder="Email of a Dock user"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addMember()}
              style={{ flex: 1, minWidth: 200 }}
            />
            <select
              className="input"
              value={addRole}
              onChange={(e) => setAddRole(e.target.value as Role)}
              style={{ width: 130 }}
            >
              {WS_ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <button className="btn pri" onClick={addMember} disabled={adding || !email.trim()}>
              {adding ? "Adding…" : "Add"}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {ws === null ? (
          <div className="center" style={{ height: 80 }}>
            <div className="spin" />
          </div>
        ) : (
          ws.members.map((m) => (
            <div
              key={m.user_id}
              className="card"
              style={{ padding: "12px 15px", display: "flex", alignItems: "center", gap: 12 }}
            >
              <span style={{ fontSize: 16 }}>👤</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {m.name ?? m.email ?? m.user_id}
                  {m.user_id === meId && (
                    <span className="muted" style={{ fontWeight: 400 }}>
                      {" "}
                      (you)
                    </span>
                  )}
                </div>
                {m.email && m.name && (
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {m.email}
                  </div>
                )}
              </div>
              {isAdmin ? (
                <select
                  className="input"
                  value={roleValue(m.role)}
                  onChange={(e) => changeRole(m.user_id, e.target.value as Role)}
                  style={{ width: 120 }}
                >
                  {WS_ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span
                  className="mono"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: "var(--ac)",
                    background: "var(--ac-soft)",
                    borderRadius: 999,
                    padding: "1px 7px",
                  }}
                >
                  {roleLabel(m.role)}
                </span>
              )}
              {isAdmin && (
                <button
                  className="btn sm"
                  onClick={() => removeMember(m)}
                  style={{ color: "var(--bad)" }}
                  title="Remove member"
                >
                  Remove
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  )
}

function NewAgent({ onCreated }: { onCreated: (msg: string) => void }) {
  const [name, setName] = useState("")
  const [role, setRole] = useState<Role>("commenter")
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null)

  const add = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const a = await api.createAgent(name.trim(), role)
      setCreated({ name: a.name, token: a.token })
      setName("")
      onCreated(`Agent ${a.name} created`)
    } catch (e) {
      onCreated((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          className="input"
          placeholder="Agent name (e.g. Claude)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        <select
          className="input"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          style={{ width: 150 }}
        >
          <option value="commenter">Commenter (propose)</option>
          <option value="editor">Editor (publish)</option>
        </select>
        <button className="btn pri" onClick={add} disabled={busy || !name.trim()}>
          {busy ? "Adding…" : "Add agent"}
        </button>
      </div>
      {/* The token is shown exactly once, right after creation. */}
      {created && (
        <div
          style={{
            marginTop: 12,
            padding: "11px 13px",
            background: "var(--ac-soft)",
            border: "1px solid var(--ac)",
            borderRadius: 10,
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>
            Token for {created.name} — copy it now, it won't be shown again.
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <code
              className="mono"
              style={{
                flex: 1,
                fontSize: 11.5,
                wordBreak: "break-all",
                background: "var(--card)",
                padding: "7px 9px",
                borderRadius: 7,
                border: "1px solid var(--line)",
              }}
            >
              {created.token}
            </code>
            <button
              className="btn sm"
              onClick={() => {
                navigator.clipboard?.writeText(created.token)
                onCreated("Token copied")
              }}
            >
              Copy
            </button>
            <button className="btn sm" onClick={() => setCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function AgentRow({
  agent,
  onChanged,
  onError,
}: {
  agent: Agent
  onChanged: (msg: string) => void
  onError: (msg: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const remove = async () => {
    if (!confirm(`Remove agent ${agent.name}? Its token stops working.`)) return
    setBusy(true)
    try {
      await api.deleteAgent(agent.id)
      onChanged(`Agent ${agent.name} removed`)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className="card"
      style={{ padding: "12px 15px", display: "flex", alignItems: "center", gap: 12 }}
    >
      <span style={{ fontSize: 16 }}>🤖</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>
          @{agent.name}{" "}
          <span
            className="mono"
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--ac)",
              background: "var(--ac-soft)",
              borderRadius: 999,
              padding: "1px 7px",
            }}
          >
            {agent.role}
          </span>
        </div>
        <div className="muted" style={{ fontSize: 11.5 }}>
          Mention it in any thread to send it work.
        </div>
      </div>
      <button className="btn sm" onClick={remove} disabled={busy} title="Remove agent">
        Remove
      </button>
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
