import { useInfiniteQuery } from "@tanstack/react-query"
import { useDeferredValue, useState } from "react"
import { ApiError, type TemplateLibraryEntry, type TemplateLibraryScope } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { LibraryDetail } from "./library-detail"
import { CreateLibraryDialog } from "./library-dialogs"
import { TemplateLibraryCard } from "./template-library-card"
import { scopeCopy } from "./template-library-helpers"
import { templateLibrariesQuery } from "./template-library-queries"

export function LibraryShelf({
  selectedId,
  onSelect,
  onUse,
}: {
  selectedId?: string
  onSelect: (id?: string) => void
  onUse: (entry: TemplateLibraryEntry) => void
}) {
  const [scope, setScope] = useState<"all" | TemplateLibraryScope>("all")
  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)
  const libraries = useInfiniteQuery(
    templateLibrariesQuery({
      scope: scope === "all" ? undefined : scope,
      query: deferredQuery,
    }),
  )
  const libraryRows = libraries.data?.pages.flatMap((page) => page.libraries) ?? []
  const [createOpen, setCreateOpen] = useState(false)
  const schemaPending =
    libraries.error instanceof ApiError &&
    libraries.error.code === "template_library_schema_unavailable"
  if (selectedId)
    return <LibraryDetail libraryId={selectedId} onBack={() => onSelect(undefined)} onUse={onUse} />
  return (
    <section className="flex flex-col gap-5" data-testid="template-libraries">
      <div className="flex flex-wrap items-end justify-between gap-4 border-y py-5">
        <div>
          <p className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
            A shareable starting point
          </p>
          <h2 className="mt-2 font-serif text-3xl font-medium tracking-tight text-foreground">
            Libraries make useful work reusable.
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-pretty text-muted-foreground">
            Publish the version you trust. Others start from an independent copy, with source
            provenance intact.
          </p>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:flex-nowrap">
          {(query || libraryRows.length > 1) && (
            <label className="min-w-48 flex-1 sm:w-56 sm:flex-none">
              <span className="sr-only">Search libraries</span>
              <Input
                data-testid="template-library-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search libraries"
                aria-label="Search libraries"
              />
            </label>
          )}
          <Button onClick={() => setCreateOpen(true)} data-testid="template-library-new">
            <Icon name="plus" /> New library
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <fieldset className="flex flex-wrap gap-1.5">
          <legend className="sr-only">Library visibility</legend>
          {(["all", "private", "workspace", "public"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="xs"
              variant={scope === value ? "default" : "outline"}
              onClick={() => setScope(value)}
              data-testid={`template-library-scope-${value}`}
            >
              {value === "all" ? "All" : scopeCopy[value].label}
            </Button>
          ))}
        </fieldset>
        <Button asChild variant="ghost" size="sm" data-testid="template-library-explore-public">
          <a href="/template-libraries">
            <Icon name="globe" /> Explore public libraries
          </a>
        </Button>
      </div>
      {libraries.isPending || libraries.isPlaceholderData ? (
        <div className="grid min-h-64 place-items-center border-y text-sm text-muted-foreground">
          {libraries.isPlaceholderData ? "Searching libraries…" : "Loading libraries…"}
        </div>
      ) : schemaPending ? (
        <EmptyState
          icon={<Icon name="templates" />}
          title="Template libraries are landing with this release"
          description="Built-in artifact and Context templates are ready now. Shared libraries turn on automatically when the release finishes."
        />
      ) : libraries.isError ? (
        <EmptyState
          icon={<Icon name="templates" />}
          title="Libraries couldn't load"
          description="Try again in a moment."
          action={
            <Button
              variant="outline"
              onClick={() => libraries.refetch()}
              data-testid="template-library-retry"
            >
              Retry
            </Button>
          }
        />
      ) : libraryRows.length ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {libraryRows.map((library) => (
            <TemplateLibraryCard
              key={library.id}
              library={library}
              onOpen={() => onSelect(library.id)}
              testId={`template-library-card-${library.id}`}
            />
          ))}
        </div>
      ) : query.trim() ? (
        <EmptyState
          icon={<Icon name="templates" />}
          title="No matching libraries"
          description="Try a broader word or clear the current search."
          action={
            <Button
              variant="outline"
              onClick={() => setQuery("")}
              data-testid="template-library-search-clear"
            >
              Clear search
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon={<Icon name="templates" />}
          title="Create the first shared beginning"
          description="Turn a trusted artifact into a library entry, then share it privately, with your workspace, or publicly."
        />
      )}
      {libraries.hasNextPage && !libraries.isPlaceholderData ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => libraries.fetchNextPage()}
            disabled={libraries.isFetchingNextPage}
            data-testid="template-libraries-load-more"
          >
            {libraries.isFetchingNextPage ? "Loading…" : "Load more libraries"}
          </Button>
        </div>
      ) : null}
      <CreateLibraryDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(library) => onSelect(library.id)}
      />
    </section>
  )
}
