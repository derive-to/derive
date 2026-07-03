import { Bot } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { type Agent, api, type Role } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "@/components/ui/sonner"

export function AgentsSection() {
  const [agents, setAgents] = useState<Agent[] | null>(null)
  const load = useCallback(
    () =>
      api
        .listAgents()
        .then((r) => setAgents(r.agents))
        .catch(() => setAgents([])),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

  return (
    <section className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Register an agent so people can <code className="font-mono">@mention</code> it in a thread.
        It gets a scoped token and acts as a commenter — it can propose changes for review, but a
        human still approves. The agent reads its mentions from{" "}
        <code className="font-mono">GET /v1/agent/inbox</code> with its token.
      </p>

      <NewAgent
        onCreated={(msg) => {
          toast.success(msg)
          load()
        }}
      />

      <div className="flex flex-col gap-2.5">
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
                toast.success(m)
                load()
              }}
              onError={(m) => toast.error(m)}
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
          className="min-w-45 flex-1"
        />
        <Select value={role} onValueChange={(v) => setRole(v as Role)}>
          <SelectTrigger data-testid="agent-role" aria-label="Agent role" className="w-37.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="commenter">Commenter (propose)</SelectItem>
            <SelectItem value="editor">Editor (publish)</SelectItem>
          </SelectContent>
        </Select>
        <Button
          data-testid="agent-add"
          variant="secondary"
          size="sm"
          onClick={add}
          disabled={busy || !name.trim()}
        >
          {busy ? "Adding…" : "Add agent"}
        </Button>
      </div>
      {/* The token is shown exactly once, right after creation — the one-time
          reveal is a safety-orange warning moment, never the accent. */}
      {created && (
        <div data-testid="agent-token">
          <StatusPanel
            tone="warning"
            layout="inline"
            title={`Token for ${created.name} — copy it now, it won't be shown again.`}
            description={
              <code className="block break-all rounded-md bg-secondary px-2.5 py-1.5 font-mono text-2xs text-foreground">
                {created.token}
              </code>
            }
            action={
              <div className="flex items-center gap-2">
                <Button
                  data-testid="agent-token-copy"
                  variant="secondary"
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
            }
          />
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
  const [confirming, setConfirming] = useState(false)
  return (
    <Card data-testid={`agent-row-${agent.id}`} className="flex-row items-center gap-3 px-4 py-3">
      <Avatar className="size-7">
        <AvatarFallback>
          <Bot className="size-4" aria-hidden />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          @{agent.name}
          <Badge variant="secondary">{agent.role}</Badge>
        </div>
        <div className="text-sm text-muted-foreground">
          Mention it in any thread to send it work.
        </div>
      </div>
      <Button
        data-testid={`agent-remove-${agent.id}`}
        variant="destructive-ghost"
        size="sm"
        onClick={() => setConfirming(true)}
      >
        Remove
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Remove @${agent.name}?`}
        description="Its token stops working immediately."
        confirmLabel="Remove"
        onConfirm={async () => {
          try {
            await api.deleteAgent(agent.id)
            onChanged(`Agent ${agent.name} removed`)
          } catch (e) {
            onError((e as Error).message)
          }
        }}
      />
    </Card>
  )
}
