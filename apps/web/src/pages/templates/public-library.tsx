import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { useDeferredValue, useEffect, useRef, useState } from "react"
import { ApiError } from "@/api"
import { Icon } from "@/components/icons"
import { AuthorChip } from "@/components/shared/author-chip"
import { CardGrid } from "@/components/shared/card-grid"
import { EmptyState } from "@/components/shared/empty-state"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { PageShell } from "@/components/shared/page-shell"
import { PublicFrame } from "@/components/shared/public-frame"
import { SearchField } from "@/components/shared/search-field"
import { StatusPanel } from "@/components/shared/status-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { useAuth } from "@/ctx"
import { useDocumentTitle } from "@/lib/use-document-title"
import { AgentTemplateDialog, type AgentTemplateTarget } from "./agent-template-dialog"
import { TemplateEntryCard } from "./template-entry-card"
import { TemplateLibraryGrid } from "./template-library-grid"
import { templateLibrariesQuery, templateLibraryQuery } from "./template-library-queries"
import { targetFromLibraryEntry } from "./template-target"

const route = getRouteApi("/template-libraries/$id")

export function PublicTemplateLibrary() {
  const { id } = route.useParams()
  const { use: resumeEntryId } = route.useSearch()
  const { me } = useAuth()
  const inner = <PublicTemplateLibraryInner id={id} />
  const returnTo = `/template-libraries/${id}${resumeEntryId ? `?use=${encodeURIComponent(resumeEntryId)}` : ""}`
  return me ? inner : <PublicFrame returnTo={returnTo}>{inner}</PublicFrame>
}

export function PublicTemplateLibraryCatalog() {
  const { me } = useAuth()
  const inner = <PublicTemplateLibraryCatalogInner />
  return me ? inner : <PublicFrame returnTo="/template-libraries">{inner}</PublicFrame>
}

function PublicTemplateLibraryCatalogInner() {
  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)
  const libraries = useInfiniteQuery(
    templateLibrariesQuery({ scope: "public", query: deferredQuery }),
  )
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
        <LoadError
          title="Couldn’t load public libraries"
          onRetry={() => libraries.refetch()}
          testId="public-template-libraries-retry"
        />
      </PageShell>
    )
  const publicLibraries = libraries.data?.pages.flatMap((page) => page.libraries) ?? []
  return (
    <PageShell width="wide" className="flex flex-col gap-8">
      <PageHeader
        className="border-b pb-7"
        eyebrow="Public template libraries"
        title="Useful beginnings, shared openly."
        subtitle="Browse version-pinned starters from the Derive community, then tell your agent what to make with one."
      />
      <SearchField
        className="max-w-md"
        value={query}
        onValueChange={setQuery}
        loading={libraries.isFetching && !libraries.isFetchingNextPage}
        placeholder="Search libraries or topics"
        aria-label="Search public libraries"
        testId="public-template-libraries-search"
      />
      {libraries.isPlaceholderData ? (
        <div className="grid min-h-48 place-items-center border-y text-sm text-muted-foreground">
          Searching libraries…
        </div>
      ) : publicLibraries.length ? (
        <TemplateLibraryGrid
          libraries={publicLibraries}
          testId={(library) => `public-template-library-open-${library.id}`}
          loadMoreTestId="public-template-libraries-load-more"
          hasNextPage={libraries.hasNextPage}
          loadingMore={libraries.isFetchingNextPage}
          onLoadMore={() => void libraries.fetchNextPage()}
        />
      ) : query.trim() ? (
        <EmptyState
          icon={<Icon name="templates" />}
          title="No public libraries match that search"
          description="Try a broader topic or library name."
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
          icon={<Icon name="templates" />}
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
  const [resumeError, setResumeError] = useState("")
  const resumed = useRef<string | null>(null)
  const library = useQuery({ ...templateLibraryQuery(id), retry: false })
  useDocumentTitle(library.data?.title ? `${library.data.title} · Templates` : "Template library")
  useEffect(() => {
    if (!me || !resumeEntryId || !library.data) return
    const resumeKey = `${library.data.id}:${resumeEntryId}`
    if (resumed.current === resumeKey) return
    resumed.current = resumeKey
    const entry = library.data.entries?.find((candidate) => candidate.id === resumeEntryId)
    if (entry) {
      setResumeError("")
      setAgentTarget(targetFromLibraryEntry(library.data.id, entry))
    } else {
      setResumeError("That starter is no longer available in this library.")
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
        <LoadError
          title="Couldn’t load this library"
          onRetry={() => library.refetch()}
          testId="public-template-library-retry"
        />
      </PageShell>
    )
  if (library.isError || !library.data)
    return (
      <PageShell className="grid min-h-full place-items-center">
        <EmptyState
          icon={<Icon name="templates" />}
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
      {resumeError ? (
        <StatusPanel
          tone="warning"
          layout="inline"
          title="Starter unavailable"
          description={resumeError}
        />
      ) : null}
      <CardGrid>
        {(data.entries ?? []).map((entry) => (
          <TemplateEntryCard
            key={entry.id}
            entry={entry}
            actions={
              me ? (
                <Button
                  className="w-full"
                  data-testid={`public-template-library-use-${entry.id}`}
                  onClick={() => setAgentTarget(targetFromLibraryEntry(data.id, entry))}
                >
                  <Icon name="sparkles" />
                  {entry.kind === "context" ? "Make it ours" : "Make it mine"}
                </Button>
              ) : (
                <Button
                  asChild
                  className="w-full"
                  data-testid={`public-template-library-use-${entry.id}`}
                >
                  <Link
                    to="/login"
                    search={{
                      signup: true,
                      return_to: `/template-libraries/${data.id}?use=${encodeURIComponent(entry.id)}`,
                    }}
                  >
                    <Icon name="sparkles" />
                    {entry.kind === "context" ? "Make it ours" : "Make it mine"}
                  </Link>
                </Button>
              )
            }
          />
        ))}
      </CardGrid>
      {(data.entries ?? []).length === 0 && (
        <EmptyState
          icon={<Icon name="templates" />}
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
