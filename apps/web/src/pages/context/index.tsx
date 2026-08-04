import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { api, type ContextInfo } from "@/api"
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
import { toast } from "@/components/ui/sonner"
import { agentsQuery, contextsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useDocumentTitle } from "@/lib/use-document-title"
import { cn } from "@/lib/utils"
import { ContextRowsSkeleton } from "./context-skeleton"

// The contexts directory: the workspace's askable agent setups. Each one pairs a
// registered agent with a manifest — the versioned document that defines what it
// knows and what it can do. Sharing the manifest is sharing the context.
export function Contexts() {
  useDocumentTitle("Contexts")
  const qc = useQueryClient()
  const { data: contexts, isPending, isError, refetch } = useQuery(contextsQuery())
  // Agents load lazily for the create form; a 403 (non-admin) just hides it —
  // asking doesn't require admin, only creating does.
  const { data: agents } = useQuery({ ...agentsQuery(), retry: false })
  const [showCreate, setShowCreate] = useState(false)

  return (
    <PageShell className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-medium tracking-tight text-foreground">
            Contexts
          </h1>
          <p className="max-w-2xl text-pretty text-sm text-muted-foreground">
            Each context is a packaged agent — a versioned manifest, the skills it pins, and a
            runner, usually its owner's own machine. Read one to see what it does, or message it;
            work queues while the runner is away.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          data-testid="contexts-new-toggle"
          onClick={() => setShowCreate((v) => !v)}
          className="ml-auto"
        >
          <Icon name="plus" /> New context
        </Button>
      </div>

      {showCreate && (
        <NewContext
          agents={(agents ?? []).filter((a) => !a.managed).map((a) => ({ id: a.id, name: a.name }))}
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
          description="Publish a manifest, then wire it here — `derive context push` does both in one step."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {contexts.map((x) => (
            <li key={x.id}>
              <ContextRow context={x} />
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  )
}

function ContextRow({ context: x }: { context: ContextInfo }) {
  const age = x.runner_seen_at
    ? Date.now() - new Date(x.runner_seen_at).getTime()
    : Number.POSITIVE_INFINITY
  const online = age < 90_000
  const facts = [
    x.skills_count ? `${x.skills_count} ${x.skills_count === 1 ? "skill" : "skills"}` : null,
    x.manifest_version != null ? `manifest v${x.manifest_version}` : null,
    x.connection_ids.length
      ? `${x.connection_ids.length} ${x.connection_ids.length === 1 ? "source" : "sources"}`
      : null,
  ].filter((v): v is string => !!v)
  return (
    <Link
      to="/contexts/$id"
      params={{ id: x.id }}
      data-testid="context-card"
      className="flex flex-col gap-1 rounded-xl border bg-card px-4 py-3 transition-colors hover:bg-accent"
    >
      <div className="flex items-center gap-2">
        <Icon name="context" className="text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{x.name}</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={cn("size-1.5 rounded-full", online ? "bg-success" : "bg-muted-foreground")}
          />
          {online ? "online" : x.runner_seen_at ? "offline" : "never connected"}
        </span>
      </div>
      {x.description && (
        <p className="line-clamp-1 pl-6 text-sm text-muted-foreground">{x.description}</p>
      )}
      {facts.length > 0 && (
        <p className="pl-6 font-mono text-2xs text-muted-foreground">{facts.join(" · ")}</p>
      )}
    </Link>
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
  // "" = auto-mint (the default; nobody picks an agent). A non-empty id = run as
  // an existing service agent — an opt-in the roster's presence (admins) reveals.
  const [agentId, setAgentId] = useState("")
  const [manifest, setManifest] = useState("")
  // The minted agent's bearer, shown exactly once; navigation waits for Done so
  // the only display of the token is never lost to an instant redirect.
  const [minted, setMinted] = useState<{ contextId: string; name: string; token: string } | null>(
    null,
  )
  const nav = useNavigate()

  const create = useApiMutation({
    mutationFn: () =>
      api.createContext({
        name: name.trim(),
        ...(agentId ? { agent_id: agentId } : {}),
        manifest_short_id: manifest.trim(),
      }),
    success: "Context created",
    onSuccess: (ctx) => {
      const created = name.trim()
      setName("")
      setManifest("")
      onCreated()
      if (ctx.agent_token) {
        setMinted({ contextId: ctx.id, name: created, token: ctx.agent_token })
        return
      }
      // Carry the user straight into the console they just made — asking the first
      // question is the point, not admiring a new row in the directory.
      nav({ to: "/contexts/$id", params: { id: ctx.id } })
    },
  })
  const submit = () => {
    if (name.trim() && manifest.trim()) create.mutate()
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          data-testid="context-create-name"
          aria-label="Context name"
          placeholder="Name (e.g. Analytics)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-40 flex-1"
        />
        <Input
          data-testid="context-create-manifest"
          aria-label="Manifest short id"
          placeholder="Manifest short id"
          value={manifest}
          onChange={(e) => setManifest(e.target.value)}
          className="w-44 font-mono"
        />
        {/* Only admins can even load the roster; everyone else auto-mints. */}
        {agents.length > 0 && (
          <Select value={agentId} onValueChange={(v) => setAgentId(v === "auto" ? "" : v)}>
            <SelectTrigger data-testid="context-create-agent" aria-label="Agent" className="w-44">
              <SelectValue placeholder="Its own agent" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Its own agent (default)</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          data-testid="context-create-submit"
          onClick={submit}
          loading={create.isPending}
          disabled={create.isPending || !name.trim() || !manifest.trim()}
        >
          Create
        </Button>
      </div>
      {/* Shown exactly once, warning tone — same contract as agent registration. */}
      {minted && (
        <div data-testid="context-agent-token">
          <StatusPanel
            tone="warning"
            layout="inline"
            title={`Runner token for ${minted.name} — copy it now, it won't be shown again.`}
            description={
              <div className="flex flex-col gap-1.5">
                <code className="block break-all rounded-md bg-secondary px-2.5 py-1.5 font-mono text-2xs text-foreground">
                  {minted.token}
                </code>
                <span className="text-2xs text-muted-foreground">
                  Save it where the runner reads it (e.g.{" "}
                  <code className="font-mono">.derive/agent-token</code>), then{" "}
                  <code className="font-mono">derive runner serve</code> answers this context.
                </span>
              </div>
            }
            action={
              <div className="flex items-center gap-2">
                <Button
                  data-testid="context-agent-token-copy"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(minted.token)
                    toast.success("Token copied")
                  }}
                >
                  Copy
                </Button>
                <Button
                  data-testid="context-agent-token-done"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const id = minted.contextId
                    setMinted(null)
                    nav({ to: "/contexts/$id", params: { id } })
                  }}
                >
                  Done
                </Button>
              </div>
            }
          />
        </div>
      )}
    </div>
  )
}
