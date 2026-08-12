import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
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
import { AgentTemplateDialog, type AgentTemplateTarget } from "./agent-template-dialog"

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
            <Button
              variant="outline"
              onClick={() => libraries.refetch()}
              data-testid="public-template-libraries-retry"
            >
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
          Browse version-pinned starters from the Derive community, then tell Derive what to make
          with one.
        </p>
        <label className="mt-5 block max-w-md">
          <span className="sr-only">Search public libraries</span>
          <Input
            data-testid="public-template-libraries-search"
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
                <h2 className="font-serif text-2xl font-medium tracking-tight text-foreground [overflow-wrap:anywhere]">
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
              <Button
                asChild
                className="mt-auto"
                data-testid={`public-template-library-open-${library.id}`}
              >
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
            <Button
              variant="outline"
              onClick={() => setQuery("")}
              data-testid="public-template-libraries-search-clear"
            >
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
  const { use: resumeEntryId } = route.useSearch()
  const navigate = route.useNavigate()
  const [agentTarget, setAgentTarget] = useState<AgentTemplateTarget | null>(null)
  const resumed = useRef(false)
  const library = useQuery({
    queryKey: ["public-template-library", id] as const,
    queryFn: () => api.getTemplateLibrary(id),
    retry: false,
  })
  useDocumentTitle(library.data?.title ? `${library.data.title} · Templates` : "Template library")
  useEffect(() => {
    if (!me || !resumeEntryId || !library.data || resumed.current) return
    resumed.current = true
    const entry = library.data.entries?.find((candidate) => candidate.id === resumeEntryId)
    if (entry) {
      setAgentTarget({
        uri: `derive://template-libraries/${library.data.id}/${entry.id}`,
        title: entry.title,
        description: entry.description,
        kind: entry.kind,
        category: entry.category,
        inputs: entry.inputs,
      })
    }
    void navigate({ search: {}, replace: true })
  }, [library.data, me, navigate, resumeEntryId])
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
            <Button
              variant="outline"
              onClick={() => library.refetch()}
              data-testid="public-template-library-retry"
            >
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
  const scopeLabel =
    data.scope === "public"
      ? "Public template library"
      : data.scope === "workspace"
        ? "Workspace template library"
        : "Private template library"
  const scopeIcon =
    data.scope === "public" ? "globe" : data.scope === "workspace" ? "workspace" : "lock"
  const copyLibraryLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/template-libraries/${data.id}`)
      toast.success("Library link copied")
    } catch {
      toast.error("Couldn't copy the library link")
    }
  }
  return (
    <PageShell width="wide" className="flex flex-col gap-8">
      <section className="border-b pb-7">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" shape="pill">
            <Icon name={scopeIcon} size={12} /> {scopeLabel}
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
          <span className="text-sm text-muted-foreground">
            {data.scope === "public"
              ? "Published starter kit"
              : data.scope === "workspace"
                ? "Workspace starter kit"
                : "Private starter kit"}
          </span>
        </div>
        <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
          Every starter gives Derive an exact, version-pinned shape to work from. You describe the
          job; the agent adapts it into new, independent work and leaves the original untouched.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            asChild
            variant="outline"
            size="sm"
            data-testid="public-template-library-browse-all"
          >
            <a href="/template-libraries">
              <Icon name="templates" /> Browse public libraries
            </a>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={copyLibraryLink}
            data-testid="public-template-library-copy-link"
          >
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
              <h2 className="font-serif text-2xl font-medium tracking-tight text-foreground [overflow-wrap:anywhere]">
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
            {me ? (
              <Button
                className="mt-auto"
                data-testid={`public-template-library-use-${entry.id}`}
                onClick={() =>
                  setAgentTarget({
                    uri: `derive://template-libraries/${data.id}/${entry.id}`,
                    title: entry.title,
                    description: entry.description,
                    kind: entry.kind,
                    category: entry.category,
                    inputs: entry.inputs,
                  })
                }
              >
                <Icon name="sparkles" />
                {entry.kind === "context" ? "Set up with Derive" : "Make it mine"}
              </Button>
            ) : (
              <Button
                asChild
                className="mt-auto"
                data-testid={`public-template-library-use-${entry.id}`}
              >
                <Link
                  to="/login"
                  search={{
                    signup: true,
                    return_to: `/template-libraries/${data.id}?use=${encodeURIComponent(entry.id)}`,
                  }}
                >
                  <Icon name="sparkles" /> Make it mine
                </Link>
              </Button>
            )}
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
      <AgentTemplateDialog
        target={agentTarget}
        onOpenChange={(open) => !open && setAgentTarget(null)}
      />
    </PageShell>
  )
}
