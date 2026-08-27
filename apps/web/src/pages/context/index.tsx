import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import type { ContextInfo } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { LoadError } from "@/components/shared/load-error"
import { PageShell } from "@/components/shared/page-shell"
import { Button } from "@/components/ui/button"
import { contextsQuery } from "@/lib/queries"
import { useDocumentTitle } from "@/lib/use-document-title"
import { cn } from "@/lib/utils"
import { ContextRowsSkeleton } from "./context-skeleton"
import { runnerStatus } from "./runner-status"

// This is the Agent product surface. ContextInfo remains the transport type until
// the versioned API contract changes.
export function Agents() {
  useDocumentTitle("Agents")
  const nav = useNavigate()
  const { data: contexts, isPending, isError, refetch } = useQuery(contextsQuery())

  return (
    <PageShell className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-medium tracking-tight text-foreground">Agents</h1>
          <p className="max-w-2xl text-pretty text-sm text-muted-foreground">
            An Agent is a reusable worker: what it knows, what it can do, who may use it, and where
            it runs.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          data-testid="agents-new-toggle"
          onClick={() => void nav({ to: "/agents/new" })}
          className="ml-auto"
        >
          <Icon name="plus" /> New agent
        </Button>
      </div>

      {isPending ? (
        <ContextRowsSkeleton />
      ) : isError ? (
        <LoadError title="Couldn’t load agents" testId="agents-retry" onRetry={() => refetch()} />
      ) : !contexts || contexts.length === 0 ? (
        <EmptyState
          icon={<Icon name="context" />}
          title="No agents yet"
          description="Describe a job or body of knowledge, and Derive builds the Agent with you."
          action={
            <Button
              size="sm"
              data-testid="agents-empty-new"
              onClick={() => void nav({ to: "/agents/new" })}
            >
              <Icon name="plus" /> New agent
            </Button>
          }
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
  const status = runnerStatus(x.runner_seen_at)
  const runnerLabel = status.online ? "ready" : status.away ? "away" : "offline"
  return (
    <Link
      to="/agents/$id"
      params={{ id: x.id }}
      data-testid="agent-card"
      className="relative flex flex-col gap-2 overflow-hidden rounded-xl border bg-card px-4 py-3 pl-5 transition-colors hover:bg-accent"
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-0 w-1",
          status.online ? "bg-success" : status.away ? "bg-warning" : "bg-muted-foreground/35",
        )}
      />
      <div className="flex items-center gap-2">
        <Icon name="context" className="text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{x.name}</span>
        <span
          className={cn(
            "ml-auto flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-2xs",
            status.online
              ? "border-success/20 bg-success/10 text-success"
              : status.away
                ? "border-warning/20 bg-warning/10 text-warning"
                : "border-border bg-muted/45 text-muted-foreground",
          )}
          title={status.title}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              status.online ? "bg-success" : status.away ? "bg-warning" : "bg-muted-foreground/50",
            )}
          />
          {runnerLabel}
        </span>
      </div>
      {x.description && (
        <p className="line-clamp-1 pl-6 text-sm text-muted-foreground">{x.description}</p>
      )}
      <span className="flex flex-wrap items-center gap-1.5 pl-6 font-mono text-2xs">
        {x.manifest_version != null ? (
          <span className="rounded-md border border-share/20 bg-share/10 px-1.5 py-0.5 font-semibold text-share">
            manifest v{x.manifest_version}
          </span>
        ) : (
          <span className="rounded-md border border-border bg-muted/45 px-1.5 py-0.5 text-muted-foreground">
            manifest unresolved
          </span>
        )}
        {x.skills_count ? (
          <span className="rounded-md border border-border bg-muted/35 px-1.5 py-0.5 text-muted-foreground">
            {x.skills_count} {x.skills_count === 1 ? "skill" : "skills"}
          </span>
        ) : null}
        {x.connection_ids.length ? (
          <span className="rounded-md border border-border bg-muted/35 px-1.5 py-0.5 text-muted-foreground">
            {x.connection_ids.length} {x.connection_ids.length === 1 ? "source" : "sources"}
          </span>
        ) : null}
      </span>
    </Link>
  )
}
