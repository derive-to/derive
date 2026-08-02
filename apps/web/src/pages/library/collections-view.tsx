import { useState } from "react"
import type { Collection } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CollectionCard } from "./collection-card"
import { CollectionRow } from "./collection-row"

// The library's second view: shelves, starred first, each showing what's inside it.
//
// Both layouts lead with the artifacts — filmstrip rows in List, a cover mosaic in Grid —
// because a name and a count is the least interesting thing we know about a collection,
// and the renders are the thing nothing else can show.
//
// Each group states its rule in the UI ("Starred — pinned to your sidebar", "You have
// access to these"), so grouping stays something a reader can predict. Nothing is
// hidden — the unstarred group lists everything else.
export function CollectionsView({
  collections,
  layout,
  onStar,
  onCreate,
  draft,
  setDraft,
}: {
  collections: Collection[]
  layout: "grid" | "list"
  onStar: (id: string, next: boolean) => void
  onCreate: (title: string) => void
  /** Opened from the toolbar's one New button — the page owns the state so there is a
   *  single "+ New" on screen rather than one per surface. */
  draft: string | null
  setDraft: (v: string | null) => void
}) {
  // Starred is a choice; active is derived from what you actually did. Both belong in
  // the same group — the question the heading answers is "is this mine to work in",
  // and how it got there is not the reader's problem.
  const working = collections.filter((c) => c.starred || c.active)
  const rest = collections.filter((c) => !c.starred && !c.active)
  const submit = () => {
    const t = (draft ?? "").trim()
    setDraft(null)
    if (t) onCreate(t)
  }

  return (
    <div className="flex flex-col gap-7">
      {/* Create where you can see what you already have — the point of moving this off
          the rail, where a permanent form sat in the navigation. */}
      {draft !== null && (
        <div className="flex items-center gap-2">
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
        </div>
      )}

      {collections.length === 0 && (
        <EmptyState
          icon={<Icon name="collections" strokeWidth={1.75} />}
          title="No collections yet."
          description="A collection groups related artifacts, and sharing one shares everything in it."
        />
      )}

      {working.length > 0 && (
        <Group
          testId="collections-working"
          title="Collections you're working in"
          rule="Starred, plus any you've published or commented in this month."
          cols={working}
          layout={layout}
          onStar={onStar}
        />
      )}
      {rest.length > 0 && (
        <Group
          testId="collections-all"
          title={working.length > 0 ? "All collections" : "Collections"}
          rule={
            working.length > 0
              ? "You have access to these. Star one to pin it to your sidebar."
              : "Star one to pin it to your sidebar."
          }
          cols={rest}
          layout={layout}
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
  layout,
  onStar,
}: {
  testId: string
  title: string
  rule: string
  cols: Collection[]
  layout: "grid" | "list"
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
      {layout === "list" ? (
        <div className="rounded-xl border border-border-soft px-2.5">
          {cols.map((col) => (
            <CollectionRow key={col.id} col={col} onStar={(next) => onStar(col.id, next)} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2.5">
          {cols.map((col) => (
            <CollectionCard key={col.id} col={col} onStar={(next) => onStar(col.id, next)} />
          ))}
        </div>
      )}
    </section>
  )
}
