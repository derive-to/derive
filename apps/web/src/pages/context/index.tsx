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

// The contexts directory: the workspace's askable agent setups. Each one pairs a
// registered agent with a manifest — the versioned document that defines what it
// knows and what it can do. Sharing the manifest is sharing the context. Creating one is
// a conversation of its own (/contexts/new, see builder.tsx), so this page only lists and
// points at it.
export function Contexts() {
  useDocumentTitle("Contexts")
  const nav = useNavigate()
  const { data: contexts, isPending, isError, refetch } = useQuery(contextsQuery())

  return (
    <PageShell className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-medium tracking-tight text-foreground">
            Contexts
          </h1>
          <p className="max-w-2xl text-pretty text-sm text-muted-foreground">
            A context is a reusable agent setup: what it knows, how it answers, and who can use it.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          data-testid="contexts-new-toggle"
          onClick={() => void nav({ to: "/contexts/new" })}
          className="ml-auto"
        >
          <Icon name="plus" /> New context
        </Button>
      </div>

      {isPending ? (
        <ContextRowsSkeleton />
      ) : isError ? (
        <LoadError
          title="Couldn’t load contexts"
          testId="contexts-retry"
          onRetry={() => refetch()}
        />
      ) : !contexts || contexts.length === 0 ? (
        <EmptyState
          icon={<Icon name="context" />}
          title="No contexts yet"
          description="Describe what it should know, and Derive builds it with you."
          action={
            <Button
              size="sm"
              data-testid="contexts-empty-new"
              onClick={() => void nav({ to: "/contexts/new" })}
            >
              <Icon name="plus" /> New context
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

export function ContextRow({ context: x }: { context: ContextInfo }) {
  const status = runnerStatus(x.runner_seen_at)
  const runnerLabel = status.online ? "ready" : status.away ? "away" : "offline"
  const composite = x.kind === "graph" || x.kind === "loop"
  const icon = x.kind === "graph" || x.kind === "loop" ? x.kind : "context"
  const ready = x.manifest_status === "ready"
  const stateLabel = composite ? (ready ? "ready" : "needs changes") : runnerLabel
  const stateTitle = composite
    ? ready
      ? `Validated ${x.kind} manifest. Runs are driven by a local harness.`
      : x.manifest_errors.join("\n") || "This manifest needs changes before it can run."
    : status.title
  return (
    <Link
      to="/contexts/$id"
      params={{ id: x.id }}
      data-testid="context-card"
      className="relative flex flex-col gap-2 overflow-hidden rounded-xl border bg-card px-4 py-3 pl-5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-0 w-1",
          composite
            ? ready
              ? "bg-share"
              : "bg-warning"
            : status.online
              ? "bg-success"
              : status.away
                ? "bg-warning"
                : "bg-muted-foreground/35",
        )}
      />
      <div className="flex min-w-0 items-center gap-2">
        <Icon name={icon} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{x.name}</span>
        <span className="shrink-0 rounded-md border border-border bg-muted/35 px-1.5 py-0.5 font-mono text-2xs capitalize text-muted-foreground">
          {x.kind ?? "unknown"}
        </span>
        <span
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-2xs",
            composite
              ? ready
                ? "border-share/20 bg-share/10 text-share"
                : "border-warning/20 bg-warning/10 text-warning"
              : status.online
                ? "border-success/20 bg-success/10 text-success"
                : status.away
                  ? "border-warning/20 bg-warning/10 text-warning"
                  : "border-border bg-muted/45 text-muted-foreground",
          )}
          title={stateTitle}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              composite
                ? ready
                  ? "bg-share"
                  : "bg-warning"
                : status.online
                  ? "bg-success"
                  : status.away
                    ? "bg-warning"
                    : "bg-muted-foreground/50",
            )}
          />
          {stateLabel}
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
        {composite && (ready || x.node_count > 0) ? (
          <span className="rounded-md border border-border bg-muted/35 px-1.5 py-0.5 text-muted-foreground">
            {x.node_count} {x.node_count === 1 ? "node" : "nodes"}
            {x.loop_count ? ` · ${x.loop_count} ${x.loop_count === 1 ? "bound" : "bounds"}` : ""}
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
