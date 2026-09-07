import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import type { ContextInfo } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { LoadError } from "@/components/shared/load-error"
import { PageShell } from "@/components/shared/page-shell"
import { Spinner } from "@/components/shared/spinner"
import { Button } from "@/components/ui/button"
import { contextsQuery } from "@/lib/queries"
import { useDocumentTitle } from "@/lib/use-document-title"
import { cn } from "@/lib/utils"
import { ContextRowsSkeleton } from "./context-skeleton"
import { runnerStatus } from "./runner-status"

export function Contexts() {
  useDocumentTitle("Contexts")
  const nav = useNavigate()
  // Polled only while a paper import is on its way, so its row turns from "fetching" to
  // the paper's title without a reload; quiet otherwise (and on error, behind Try again).
  const {
    data: contexts,
    isPending,
    isError,
    refetch,
  } = useQuery({
    ...contextsQuery(),
    refetchInterval: (q) =>
      q.state.status === "error" || !q.state.data?.some((x) => importInFlight(x))
        ? false
        : IMPORT_POLL_MS,
    refetchIntervalInBackground: false,
  })

  return (
    <PageShell className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-2xl font-medium tracking-tight text-foreground">
            Contexts
          </h1>
          <p className="max-w-2xl text-pretty text-sm text-muted-foreground">
            A Context is a reusable setup: instructions, skills, sources, and permissions that an
            agent can use across many runs.
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
          description="Package instructions, skills, and sources so your agents can reuse them."
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

const IMPORT_POLL_MS = 3_000
const importInFlight = (x: ContextInfo): boolean =>
  x.import?.status === "pending" || x.import?.status === "fetching"

/** The one badge an imported row shows in place of the runner stripe: where the paper
 *  is on its way from, or that it arrived. */
function ImportBadge({ context: x }: { context: ContextInfo }) {
  const imp = x.import
  if (!imp) return null
  if (importInFlight(x))
    return (
      <span
        role="status"
        data-testid="context-import-badge"
        className="ml-auto flex items-center gap-1.5 rounded-md border border-warning/20 bg-warning/10 px-1.5 py-0.5 font-mono text-2xs text-warning"
      >
        <Spinner size="sm" tone="current" />
        fetching from arXiv
      </span>
    )
  if (imp.status === "failed")
    return (
      <span
        data-testid="context-import-badge"
        className="ml-auto rounded-md border border-warning/20 bg-warning/10 px-1.5 py-0.5 font-mono text-2xs text-warning"
      >
        retrying soon
      </span>
    )
  if (imp.status === "dead")
    return (
      <span
        data-testid="context-import-badge"
        className="ml-auto rounded-md border border-destructive/20 bg-destructive/10 px-1.5 py-0.5 font-mono text-2xs font-semibold text-destructive"
      >
        import failed
      </span>
    )
  return (
    <span
      data-testid="context-arxiv-badge"
      title={`Imported from arXiv:${imp.ref}`}
      className="ml-auto rounded-md border border-border bg-muted/45 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground"
    >
      arXiv
    </span>
  )
}

function ContextRow({ context: x }: { context: ContextInfo }) {
  const status = runnerStatus(x.runner_seen_at)
  const runnerLabel = status.online ? "ready" : status.away ? "away" : "offline"
  const imported = !!x.import
  return (
    <Link
      to="/contexts/$id"
      params={{ id: x.id }}
      data-testid="context-card"
      className="relative flex flex-col gap-2 overflow-hidden rounded-xl border bg-card px-4 py-3 pl-5 transition-colors hover:bg-accent"
    >
      {/* An imported paper has no runner: no liveness stripe, no runner chip. */}
      {!imported && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0 left-0 w-1",
            status.online ? "bg-success" : status.away ? "bg-warning" : "bg-muted-foreground/35",
          )}
        />
      )}
      <div className="flex items-center gap-2">
        <Icon name={imported ? "lock" : "context"} className="text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{x.name}</span>
        {imported ? (
          <ImportBadge context={x} />
        ) : (
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
                status.online
                  ? "bg-success"
                  : status.away
                    ? "bg-warning"
                    : "bg-muted-foreground/50",
              )}
            />
            {runnerLabel}
          </span>
        )}
      </div>
      {x.description && (
        <p className="line-clamp-1 pl-6 text-sm text-muted-foreground">{x.description}</p>
      )}
      <span className="flex flex-wrap items-center gap-1.5 pl-6 font-mono text-2xs">
        {x.manifest_version != null ? (
          <span className="rounded-md border border-share/20 bg-share/10 px-1.5 py-0.5 font-semibold text-share">
            definition v{x.manifest_version}
          </span>
        ) : (
          <span className="rounded-md border border-border bg-muted/45 px-1.5 py-0.5 text-muted-foreground">
            definition unresolved
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
