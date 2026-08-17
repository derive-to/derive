import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { api, type TemplateLibraryEntry } from "@/api"
import { Icon } from "@/components/icons"
import { CardGrid } from "@/components/shared/card-grid"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { EmptyState } from "@/components/shared/empty-state"
import { SearchField } from "@/components/shared/search-field"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useApiMutation } from "@/lib/use-api-mutation"
import { AddEntryDialog } from "./add-entry-dialog"
import { LibrarySettingsDialog } from "./library-dialogs"
import { TemplateEntryCard } from "./template-entry-card"
import { matches, scopeCopy } from "./template-library-helpers"
import { templateLibraryInvalidation, templateLibraryQuery } from "./template-library-queries"

export function LibraryDetail({
  libraryId,
  onBack,
  onUse,
}: {
  libraryId: string
  onBack: () => void
  onUse: (entry: TemplateLibraryEntry) => void
}) {
  const detail = useQuery(templateLibraryQuery(libraryId))
  const [addOpen, setAddOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [pendingDelete, setPendingDelete] = useState<TemplateLibraryEntry | null>(null)
  const remove = useApiMutation({
    mutationFn: (entry: TemplateLibraryEntry) =>
      api.deleteTemplateLibraryEntry(libraryId, entry.id),
    invalidate: templateLibraryInvalidation,
    success: "Starter removed",
    onSuccess: () => setPendingDelete(null),
  })
  if (detail.isPending)
    return (
      <div className="grid min-h-64 place-items-center border-y text-sm text-muted-foreground">
        Opening library…
      </div>
    )
  if (detail.isError || !detail.data)
    return (
      <EmptyState
        icon={<Icon name="templates" />}
        title="This library is unavailable"
        description="It may be private, deleted, or outside your current workspace."
        action={
          <Button variant="outline" onClick={onBack} data-testid="template-library-error-back">
            Back to libraries
          </Button>
        }
      />
    )
  const library = detail.data
  const allEntries = library.entries ?? []
  const entries = allEntries.filter((entry) =>
    matches(query, [
      entry.title,
      entry.description,
      entry.outcome,
      entry.category,
      entry.kind,
      ...entry.sections,
      ...entry.tags,
      ...entry.inputs.flatMap((input) => [input.name, input.description]),
    ]),
  )
  return (
    <section className="flex flex-col gap-5" data-testid="template-library-detail">
      <div className="flex flex-wrap items-start gap-3 border-b pb-5">
        <Button size="sm" variant="ghost" onClick={onBack} data-testid="template-library-back">
          <Icon name="chevron-left" /> Libraries
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" shape="pill">
              <Icon name={scopeCopy[library.scope].icon} size={12} />{" "}
              {scopeCopy[library.scope].label}
            </Badge>
            <span className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
              {library.entry_count} starters · immutable versions
            </span>
          </div>
          <h2 className="mt-3 font-serif text-3xl font-medium tracking-tight text-foreground [overflow-wrap:anywhere]">
            {library.title}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-pretty text-muted-foreground">
            {library.description || "A reusable collection of Derive starters."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {library.can_manage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSettingsOpen(true)}
              data-testid="template-library-settings-open"
            >
              <Icon name="settings" /> Library settings
            </Button>
          )}
          {library.scope === "public" && (
            <Button asChild variant="outline" size="sm" data-testid="template-library-public-page">
              <a href={`/template-libraries/${library.id}`} target="_blank" rel="noreferrer">
                <Icon name="globe" /> Public page
              </a>
            </Button>
          )}
          {library.can_manage && (
            <Button onClick={() => setAddOpen(true)} data-testid="template-library-add-starter">
              <Icon name="plus" /> Add starter
            </Button>
          )}
        </div>
      </div>
      {allEntries.length > 1 && (
        <SearchField
          className="max-w-sm"
          value={query}
          onValueChange={setQuery}
          placeholder="Filter starters"
          aria-label="Filter starters"
          testId="template-library-entry-filter"
        />
      )}
      <CardGrid>
        {entries.map((entry) => (
          <TemplateEntryCard
            key={entry.id}
            entry={entry}
            actions={
              <>
                <Button
                  size="sm"
                  onClick={() => onUse(entry)}
                  data-testid={`template-library-use-${entry.id}`}
                >
                  <Icon name="sparkles" /> Use template
                </Button>
                {library.can_manage ? (
                  <Button
                    data-testid={`template-library-delete-${entry.id}`}
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    disabled={remove.isPending && pendingDelete?.id === entry.id}
                    onClick={() => setPendingDelete(entry)}
                    aria-label={`Delete ${entry.title}`}
                  >
                    <Icon name="delete" />
                  </Button>
                ) : null}
              </>
            }
          />
        ))}
      </CardGrid>
      {allEntries.length === 0 && (
        <EmptyState
          icon={<Icon name="templates" />}
          title="No starters yet"
          description={
            library.can_manage
              ? "Add an artifact to capture a reusable, pinned starting point."
              : "This library is ready for its first published starter."
          }
        />
      )}
      {allEntries.length > 0 && entries.length === 0 && (
        <EmptyState
          icon={<Icon name="templates" />}
          title="No matching starters"
          description="Try a broader word or clear the current filter."
          action={
            <Button
              variant="outline"
              onClick={() => setQuery("")}
              data-testid="template-library-entry-filter-clear"
            >
              Clear filter
            </Button>
          }
        />
      )}
      <AddEntryDialog libraryId={libraryId} open={addOpen} onOpenChange={setAddOpen} />
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => !open && !remove.isPending && setPendingDelete(null)}
        title={`Remove ${pendingDelete?.title ?? "this starter"}?`}
        description="This removes the pinned starter from the library. Its source artifact and anything already made from it stay untouched."
        confirmLabel="Remove starter"
        onConfirm={async () => {
          if (pendingDelete) await remove.mutateAsync(pendingDelete)
        }}
        confirmTestId="template-library-entry-delete-confirm"
      />
      {settingsOpen && (
        <LibrarySettingsDialog
          key={library.id}
          library={library}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onDeleted={onBack}
        />
      )}
    </section>
  )
}
