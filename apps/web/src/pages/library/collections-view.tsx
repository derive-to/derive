import { useState } from "react"
import type { Collection } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CollectionCard } from "./collection-card"

// The library's second view: shelves as cards, starred first.
//
// Each group states its rule in the UI ("Starred — pinned to your sidebar", "You have
// access to these"), so grouping stays something a reader can predict. Nothing is
// hidden — the unstarred group lists everything else.
export function CollectionsView({
  collections,
  onStar,
  onCreate,
}: {
  collections: Collection[]
  onStar: (id: string, next: boolean) => void
  onCreate: (title: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const starred = collections.filter((c) => c.starred)
  const rest = collections.filter((c) => !c.starred)
  const submit = () => {
    const t = (draft ?? "").trim()
    setDraft(null)
    if (t) onCreate(t)
  }

  return (
    <div className="flex flex-col gap-7">
      {/* Create where you can see what you already have — the point of moving this off
          the rail, where a permanent form sat in the navigation. */}
      <div className="flex items-center gap-2">
        {draft === null ? (
          <Button
            variant="outline"
            size="sm"
            data-testid="collections-new"
            onClick={() => setDraft("")}
          >
            <Icon name="plus" size={16} /> New collection
          </Button>
        ) : (
          <>
            <Input
              autoFocus
              value={draft}
              placeholder="Collection name…"
              aria-label="Collection name"
              data-testid="collections-new-input"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit()
                if (e.key === "Escape") setDraft(null)
              }}
              onBlur={submit}
              className="max-w-64"
            />
            <Button
              variant="outline"
              size="sm"
              data-testid="collections-new-create"
              // Blur fires before click, which would commit and clear the draft before
              // this button ever saw it — keeping focus is what makes it reachable.
              onMouseDown={(e) => e.preventDefault()}
              onClick={submit}
              disabled={!draft.trim()}
            >
              Create
            </Button>
          </>
        )}
      </div>

      {collections.length === 0 && (
        <EmptyState
          icon={<Icon name="collections" strokeWidth={1.75} />}
          title="No collections yet."
          description="A collection groups related documents, and sharing one shares everything in it."
        />
      )}

      {starred.length > 0 && (
        <Group
          testId="collections-starred"
          title="Collections you're working in"
          rule="Starred — they're pinned to your sidebar."
          cols={starred}
          onStar={onStar}
        />
      )}
      {rest.length > 0 && (
        <Group
          testId="collections-all"
          title={starred.length > 0 ? "All collections" : "Collections"}
          rule={
            starred.length > 0
              ? "You have access to these. Star one to pin it to your sidebar."
              : "Star one to pin it to your sidebar."
          }
          cols={rest}
          onStar={onStar}
        />
      )}
    </div>
  )
}

function Group({
  testId,
  title,
  rule,
  cols,
  onStar,
}: {
  testId: string
  title: string
  rule: string
  cols: Collection[]
  onStar: (id: string, next: boolean) => void
}) {
  return (
    <section data-testid={testId}>
      <div className="mb-2.5">
        <h2 className="text-sm font-medium tracking-tight">
          {title}{" "}
          <span className="font-mono text-2xs font-normal tabular-nums text-muted-foreground">
            {cols.length}
          </span>
        </h2>
        <p className="text-xs text-muted-foreground">{rule}</p>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5">
        {cols.map((col) => (
          <CollectionCard key={col.id} col={col} onStar={(next) => onStar(col.id, next)} />
        ))}
      </div>
    </section>
  )
}
