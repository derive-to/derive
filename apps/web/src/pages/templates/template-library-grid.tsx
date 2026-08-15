import type { TemplateLibrary } from "@/api"
import { CardGrid } from "@/components/shared/card-grid"
import { Button } from "@/components/ui/button"
import { TemplateLibraryCard } from "./template-library-card"

export function TemplateLibraryGrid({
  libraries,
  testId,
  onOpen,
  loadMoreTestId,
  hasNextPage,
  loadingMore,
  onLoadMore,
}: {
  libraries: TemplateLibrary[]
  testId: (library: TemplateLibrary) => string
  onOpen?: (library: TemplateLibrary) => void
  loadMoreTestId: string
  hasNextPage?: boolean
  loadingMore: boolean
  onLoadMore: () => void
}) {
  return (
    <>
      <CardGrid>
        {libraries.map((library) => (
          <TemplateLibraryCard
            key={library.id}
            library={library}
            onOpen={onOpen ? () => onOpen(library) : undefined}
            testId={testId(library)}
          />
        ))}
      </CardGrid>
      {hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={onLoadMore}
            disabled={loadingMore}
            data-testid={loadMoreTestId}
          >
            {loadingMore ? "Loading…" : "Load more libraries"}
          </Button>
        </div>
      ) : null}
    </>
  )
}
