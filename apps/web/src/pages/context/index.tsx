import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import type { ContextInfo } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { PageShell } from "@/components/shared/page-shell"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import { contextsQuery } from "@/lib/queries"
import { useDocumentTitle } from "@/lib/use-document-title"
import { cn } from "@/lib/utils"
import { BUILDER_COPY } from "./builder-copy"
import { ContextRowsSkeleton } from "./context-skeleton"

// The contexts directory: the workspace's askable agent setups. Each one pairs a
// registered agent with a manifest — the versioned document that defines what it
// knows and what it can do. Sharing the manifest is sharing the context. Creating one
// is a conversation now (/contexts/new), not a page-level form — see pages/context/
// builder.tsx.
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
            A context is a helper you set up once — what it knows, how it answers — that your team
            and their agents can ask questions or hand work.
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
        <span
          className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"
          title={
            online
              ? BUILDER_COPY.statusOnline
              : x.runner_seen_at
                ? BUILDER_COPY.statusOffline
                : BUILDER_COPY.statusNever
          }
        >
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
