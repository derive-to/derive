import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, api } from "@/api"
import { Icon } from "@/components/icons"
import { AuthorChip } from "@/components/shared/author-chip"
import { EmptyState } from "@/components/shared/empty-state"
import { PageShell } from "@/components/shared/page-shell"
import { PublicFrame } from "@/components/shared/public-frame"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "@/components/ui/sonner"
import { useAuth } from "@/ctx"
import { useDocumentTitle } from "@/lib/use-document-title"

const route = getRouteApi("/template-libraries/$id")

export function PublicTemplateLibrary() {
  const { id } = route.useParams()
  const { me } = useAuth()
  const inner = <PublicTemplateLibraryInner id={id} />
  return me ? inner : <PublicFrame returnTo={`/template-libraries/${id}`}>{inner}</PublicFrame>
}

export function PublicTemplateLibraryCatalog() {
  const { me } = useAuth()
  const inner = <PublicTemplateLibraryCatalogInner />
  return me ? inner : <PublicFrame returnTo="/template-libraries">{inner}</PublicFrame>
}

function PublicTemplateLibraryCatalogInner() {
  const [query, setQuery] = useState("")
  const libraries = useQuery({
    queryKey: ["public-template-libraries"] as const,
    queryFn: () => api.listTemplateLibraries(),
  })
  useDocumentTitle("Public template libraries")
  if (libraries.isPending)
    return (
      <PageShell className="grid min-h-full place-items-center text-sm text-muted-foreground">
        Opening public libraries…
      </PageShell>
    )
  if (libraries.isError)
    return (
      <PageShell className="grid min-h-full place-items-center">
        <StatusPanel
          tone="danger"
          title="Couldn’t load public libraries"
          description="This is usually temporary."
          action={
            <Button variant="outline" onClick={() => libraries.refetch()}>
              Try again
            </Button>
          }
        />
      </PageShell>
    )
  const needle = query.trim().toLocaleLowerCase()
  const publicLibraries = (libraries.data?.libraries ?? []).filter(
    (library) =>
      library.scope === "public" &&
      (!needle ||
        [
          library.title,
          library.description,
          library.publisher.name,
          library.publisher.username,
        ].some((value) => value?.toLocaleLowerCase().includes(needle))),
  )
  return (
    <PageShell width="wide" className="flex flex-col gap-8">
      <section className="border-b pb-7">
        <Badge variant="outline" shape="pill">
          <Icon name="globe" size={12} /> Public template libraries
        </Badge>
        <h1 className="mt-4 max-w-3xl font-serif text-4xl font-medium leading-tight tracking-tight text-foreground sm:text-5xl">
          Useful beginnings, shared openly.
        </h1>
        <p className="mt-3 max-w-2xl text-base text-pretty text-muted-foreground">
          Browse version-pinned starters from the Derive community. Starting one always creates your
          own editable work.
        </p>
        <label className="mt-5 block max-w-md">
          <span className="sr-only">Search public libraries</span>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search libraries, publishers, or topics"
            aria-label="Search public libraries"
          />
        </label>
      </section>
      {publicLibraries.length ? (
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {publicLibraries.map((library) => (
            <article
              key={library.id}
              className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <Badge variant="outline" shape="pill">
                  <Icon name="globe" size={12} /> Public
                </Badge>
                <span className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
                  {library.entry_count} starters
                </span>
              </div>
              <div>
                <h2 className="font-serif text-2xl font-medium tracking-tight text-foreground">
                  {library.title}
                </h2>
                <p className="mt-1 text-sm text-pretty text-muted-foreground">
                  {library.description || "Reusable Derive starters."}
                </p>
              </div>
              <AuthorChip
                name={library.publisher.name}
                login={null}
                avatar={library.publisher.image}
                handle={library.publisher.username}
                size="xs"
              />
              <Button asChild className="mt-auto">
                <Link to="/template-libraries/$id" params={{ id: library.id }}>
                  Browse starters <Icon name="arrow" />
                </Link>
              </Button>
            </article>
          ))}
        </section>
      ) : needle ? (
        <EmptyState
          icon="templates"
          title="No public libraries match that search"
          description="Try a broader topic, library name, or publisher."
          action={
            <Button variant="outline" onClick={() => setQuery("")}>
              Clear search
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon="templates"
          title="No public libraries yet"
          description="The first public starter kit will appear here."
        />
      )}
    </PageShell>
  )
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
  const copyPublicLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/template-libraries/${data.id}`)
      toast.success("Public library link copied")
    } catch {
      toast.error("Couldn't copy the public library link")
    }
  }
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
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <AuthorChip
            name={data.publisher.name}
            login={null}
            avatar={data.publisher.image}
            handle={data.publisher.username}
          />
          <span className="text-sm text-muted-foreground">Published starter kit</span>
        </div>
        <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
          Every starter begins as an independent copy. Its source version is pinned for provenance;
          the original artifact never changes when someone uses it.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <a href="/template-libraries">
              <Icon name="templates" /> Browse public libraries
            </a>
          </Button>
          <Button variant="outline" size="sm" onClick={copyPublicLink}>
            <Icon name="link" /> Copy library link
          </Button>
        </div>
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
