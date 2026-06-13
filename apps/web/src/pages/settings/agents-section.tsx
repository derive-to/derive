import { Bot } from "lucide-react"
import { useEffect, useState } from "react"
import { type Agent, api, type Role } from "@/api"
import { EmptyState } from "@/components/shared/empty-state"
import { Spinner } from "@/components/shared/spinner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { selectClass } from "./roles"

export function AgentsSection({ show }: { show: (m: string) => void }) {
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const load = () =>
    api
      .listAgents()
      .then((r) => setAgents(r.agents))
      .catch(() => setAgents([]))
  useEffect(() => {
    load()
  }, [])

  return (
    <section>
      <p className="mb-4 text-sm text-muted-foreground">
        Register an agent so people can <code className="font-mono">@mention</code> it in a thread.
        It gets a scoped token and acts as a commenter — it can propose changes for review, but a
        human still approves. The agent reads its mentions from{" "}
        <code className="font-mono">GET /v1/agent/inbox</code> with its token.
      </p>

      <NewAgent
        onCreated={(msg) => {
          show(msg)
          load()
        }}
      />

      <div className="mt-4 flex flex-col gap-2.5">
        {agents === null ? (
          <div className="flex h-20 items-center justify-center">
            <Spinner />
          </div>
        ) : agents.length === 0 ? (
          <EmptyState>No agents yet. Add one above.</EmptyState>
        ) : (
          agents.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
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
    <Card className="p-4">
      <div className="flex flex-wrap gap-2">
        <Input
          data-testid="agent-name"
          aria-label="Agent name"
          placeholder="Agent name (e.g. Claude)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-[180px] flex-1"
        />
        <select
          data-testid="agent-role"
          aria-label="Agent role"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          className={`${selectClass} w-[150px]`}
        >
          <option value="commenter">Commenter (propose)</option>
          <option value="editor">Editor (publish)</option>
        </select>
        <Button
          data-testid="agent-add"
          variant="primary"
          onClick={add}
          disabled={busy || !name.trim()}
        >
          {busy ? "Adding…" : "Add agent"}
        </Button>
      </div>
      {/* The token is shown exactly once, right after creation. */}
      {created && (
        <div
          data-testid="agent-token"
          className="mt-3 rounded-lg border border-primary bg-accent/15 p-3"
        >
          <div className="mb-1.5 text-xs font-semibold text-foreground">
            Token for {created.name} — copy it now, it won't be shown again.
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-xs">
              {created.token}
            </code>
            <Button
              data-testid="agent-token-copy"
              variant="ghost"
              size="sm"
              onClick={() => {
                navigator.clipboard?.writeText(created.token)
                onCreated("Token copied")
              }}
            >
              Copy
            </Button>
            <Button
              data-testid="agent-token-done"
              variant="ghost"
              size="sm"
              onClick={() => setCreated(null)}
            >
              Done
            </Button>
          </div>
        </div>
      )}
    </Card>
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
    <Card data-testid={`agent-row-${agent.id}`} className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        <Bot className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          @{agent.name}
          <Badge variant="accent" className="font-mono">
            {agent.role}
          </Badge>
        </div>
        <div className="text-2xs text-muted-foreground">
          Mention it in any thread to send it work.
        </div>
      </div>
      <Button
        data-testid={`agent-remove-${agent.id}`}
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={remove}
        disabled={busy}
      >
        Remove
      </Button>
    </Card>
  )
}
