import { useInfiniteQuery } from "@tanstack/react-query"
import { useDeferredValue, useState } from "react"
import { ApiError, type TemplateLibraryEntry, type TemplateLibraryScope } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { LoadError } from "@/components/shared/load-error"
import { PageHeader } from "@/components/shared/page-header"
import { SearchField } from "@/components/shared/search-field"
import { Button } from "@/components/ui/button"
import { LibraryDetail } from "./library-detail"
import { CreateLibraryDialog } from "./library-dialogs"
import { TemplateLibraryGrid } from "./template-library-grid"
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
      <PageHeader
        className="border-y py-5"
        eyebrow="A shareable starting point"
        title="Libraries make useful work reusable."
        subtitle="Publish the version you trust. Others start from an independent copy, with source provenance intact."
        actions={
          <>
            {(query || libraryRows.length > 1) && (
              <SearchField
                className="min-w-48 flex-1 sm:w-56 sm:flex-none"
                value={query}
                onValueChange={setQuery}
                loading={libraries.isFetching && !libraries.isFetchingNextPage}
                placeholder="Search libraries"
                aria-label="Search libraries"
                testId="template-library-search"
              />
            )}
            <Button onClick={() => setCreateOpen(true)} data-testid="template-library-new">
              <Icon name="plus" /> New library
            </Button>
          </>
        }
      />
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
        <LoadError
          title="Couldn’t load template libraries"
          onRetry={() => libraries.refetch()}
          testId="template-library-retry"
        />
      ) : libraryRows.length ? (
        <TemplateLibraryGrid
          libraries={libraryRows}
          testId={(library) => `template-library-card-${library.id}`}
          onOpen={(library) => onSelect(library.id)}
          loadMoreTestId="template-libraries-load-more"
          hasNextPage={libraries.hasNextPage && !libraries.isPlaceholderData}
          loadingMore={libraries.isFetchingNextPage}
          onLoadMore={() => void libraries.fetchNextPage()}
        />
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
      <CreateLibraryDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(library) => onSelect(library.id)}
      />
    </section>
  )
}
