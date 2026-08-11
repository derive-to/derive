import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { ApiError, api } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { PageShell } from "@/components/shared/page-shell"
import { PublicFrame } from "@/components/shared/public-frame"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/ctx"
import { useDocumentTitle } from "@/lib/use-document-title"

const route = getRouteApi("/template-libraries/$id")

export function PublicTemplateLibrary() {
  const { id } = route.useParams()
  const { me } = useAuth()
  const inner = <PublicTemplateLibraryInner id={id} />
  return me ? inner : <PublicFrame returnTo={`/template-libraries/${id}`}>{inner}</PublicFrame>
}

function PublicTemplateLibraryInner({ id }: { id: string }) {
  const { me } = useAuth()
  const library = useQuery({
    queryKey: ["public-template-library", id] as const,
    queryFn: () => api.getTemplateLibrary(id),
    retry: false,
  })
  useDocumentTitle(library.data?.title ? `${library.data.title} · Templates` : "Template library")
  if (library.isPending)
    return (
      <PageShell className="grid min-h-full place-items-center text-sm text-muted-foreground">
        Opening library…
      </PageShell>
    )
  if (library.isError && !(library.error instanceof ApiError && library.error.status === 404))
    return (
      <PageShell className="grid min-h-full place-items-center">
        <StatusPanel
          tone="danger"
          title="Couldn’t load this library"
          description="This is usually temporary."
          action={
            <Button variant="outline" onClick={() => library.refetch()}>
              Try again
            </Button>
          }
        />
      </PageShell>
    )
  if (library.isError || !library.data)
    return (
      <PageShell className="grid min-h-full place-items-center">
        <EmptyState
          icon="templates"
          title="This library isn’t available"
          description="It may be private, deleted, or moved."
        />
      </PageShell>
    )
  const data = library.data
  const start = (entry: { id: string; kind: "artifact" | "context"; title: string }) => {
    const target = `/new?library=${encodeURIComponent(data.id)}&entry=${encodeURIComponent(entry.id)}${entry.kind === "context" ? `&next=context&contextName=${encodeURIComponent(entry.title)}` : ""}`
    return me ? target : `/login?signup=true&return_to=${encodeURIComponent(target)}`
  }
  return (
    <PageShell width="wide" className="flex flex-col gap-8">
      <section className="border-b pb-7">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" shape="pill">
            <Icon name="globe" size={12} /> Public template library
          </Badge>
          <span className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
            {data.entry_count} pinned starters
          </span>
        </div>
        <h1 className="mt-4 max-w-3xl font-serif text-4xl font-medium leading-tight tracking-tight text-foreground sm:text-5xl">
          {data.title}
        </h1>
        <p className="mt-3 max-w-2xl text-base text-pretty text-muted-foreground">
          {data.description || "A reusable collection of Derive starters."}
        </p>
        <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
          Every starter begins as an independent copy. Its source version is pinned for provenance;
          the original artifact never changes when someone uses it.
        </p>
      </section>
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(data.entries ?? []).map((entry) => (
          <article
            key={entry.id}
            className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4"
          >
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" shape="pill">
                {entry.kind === "context" ? "Context" : entry.category}
              </Badge>
              <Badge variant="outline" shape="pill">
                Source v{entry.source_version}
              </Badge>
            </div>
            <div>
              <h2 className="font-serif text-2xl font-medium tracking-tight text-foreground">
                {entry.title}
              </h2>
              <p className="mt-1 text-sm text-pretty text-muted-foreground">{entry.description}</p>
            </div>
            {entry.sections.length > 0 && (
              <p className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
                {entry.sections.join(" · ")}
              </p>
            )}
            {entry.inputs.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Needs:{" "}
                {entry.inputs
                  .map((input) => `${input.name}${input.required ? " · required" : ""}`)
                  .join(" · ")}
              </p>
            )}
            <Button asChild className="mt-auto">
              <Link to={start(entry)}>
                {entry.kind === "context" ? "Create manifest" : "Start with this"}
                <Icon name="arrow" />
              </Link>
            </Button>
          </article>
        ))}
      </section>
      {(data.entries ?? []).length === 0 && (
        <EmptyState
          icon="templates"
          title="No starters published yet"
          description="This public library is ready for its first reusable artifact."
        />
      )}
    </PageShell>
  )
}
