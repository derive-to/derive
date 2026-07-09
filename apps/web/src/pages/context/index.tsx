import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { api } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { PageShell } from "@/components/shared/page-shell"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { agentsQuery, contextsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { ContextRowsSkeleton } from "./context-skeleton"

// The contexts directory: the workspace's askable agent setups. Creation wires an
// existing agent (Settings → Agents) to a manifest artifact by its short id — the
// two halves already exist as first-class objects; a context is just the joint.
export function Contexts() {
  const qc = useQueryClient()
  const { data: contexts, isPending, isError, refetch } = useQuery(contextsQuery())
  // Agents load lazily for the create form; a 403 (non-admin) just hides it —
  // asking doesn't require admin, only creating does.
  const { data: agents } = useQuery({ ...agentsQuery(), retry: false })

  return (
    <PageShell className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-serif text-2xl font-medium tracking-tight text-foreground">Contexts</h1>
        <p className="text-sm text-pretty text-muted-foreground">
          Agent setups you can ask. Each one pairs a registered agent with a manifest — the
          versioned document that defines what it knows. Sharing the manifest is sharing the
          context.
        </p>
      </div>

      {agents && agents.length > 0 && (
        <NewContext
          agents={agents.map((a) => ({ id: a.id, name: a.name }))}
          onCreated={() => qc.invalidateQueries({ queryKey: contextsQuery().queryKey })}
        />
      )}

      {isPending ? (
        <ContextRowsSkeleton />
      ) : isError ? (
        <StatusPanel
          tone="danger"
          title="Couldn't load contexts"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="contexts-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
        />
      ) : !contexts || contexts.length === 0 ? (
        <EmptyState
          icon={<Icon name="context" />}
          title="No contexts yet"
          description="Register an agent in Settings, publish a manifest, then wire them together here."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {contexts.map((x) => (
            <li key={x.id}>
              <Link
                to="/contexts/$id"
                params={{ id: x.id }}
                data-testid="context-card"
                className="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors hover:bg-accent"
              >
                <Icon name="context" className="text-muted-foreground" />
                <span className="text-sm font-medium text-foreground">{x.name}</span>
                <span className="ml-auto text-sm text-muted-foreground">Ask →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  )
}

function NewContext({
  agents,
  onCreated,
}: {
  agents: { id: string; name: string }[]
  onCreated: () => void
}) {
  const [name, setName] = useState("")
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "")
  const [manifest, setManifest] = useState("")
  const nav = useNavigate()

  const create = useApiMutation({
    mutationFn: () =>
      api.createContext({
        name: name.trim(),
        agent_id: agentId,
        manifest_short_id: manifest.trim(),
      }),
    success: "Context created",
    onSuccess: (ctx) => {
      setName("")
      setManifest("")
      onCreated()
      // Carry the user straight into the console they just made — asking the first
      // question is the point, not admiring a new row in the directory.
      nav({ to: "/contexts/$id", params: { id: ctx.id } })
    },
  })
  const submit = () => {
    if (name.trim() && agentId && manifest.trim()) create.mutate()
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3">
      <Input
        data-testid="context-create-name"
        aria-label="Context name"
        placeholder="Name (e.g. Analytics)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="min-w-40 flex-1"
      />
      <Select value={agentId} onValueChange={setAgentId}>
        <SelectTrigger data-testid="context-create-agent" aria-label="Agent" className="w-40">
          <SelectValue placeholder="Agent" />
        </SelectTrigger>
        <SelectContent>
          {agents.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        data-testid="context-create-manifest"
        aria-label="Manifest short id"
        placeholder="Manifest short id"
        value={manifest}
        onChange={(e) => setManifest(e.target.value)}
        className="w-44 font-mono"
      />
      <Button
        data-testid="context-create-submit"
        onClick={submit}
        loading={create.isPending}
        disabled={create.isPending || !name.trim() || !agentId || !manifest.trim()}
      >
        Create
      </Button>
    </div>
  )
}
