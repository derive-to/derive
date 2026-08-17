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

function ContextRow({ context: x }: { context: ContextInfo }) {
  const status = runnerStatus(x.runner_seen_at)
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
        <span
          className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"
          title={status.title}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              status.online ? "bg-success" : "bg-muted-foreground",
            )}
          />
          {status.online ? "online" : x.runner_seen_at ? "offline" : "never connected"}
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
