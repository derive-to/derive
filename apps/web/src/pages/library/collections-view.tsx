import { useState } from "react"
import type { Collection } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { SectionEyebrow } from "@/components/shared/section-eyebrow"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CollectionRow } from "./collection-row"

// The library's second view: shelves, starred first, each showing what's inside it.
//
// One presentation, not two. A name and a count is the least interesting thing we know
// about a collection, so every shelf leads with its artifacts; offering a second layout
// that showed less of them was a knob with a wrong setting on it.
//
// Each group states its rule in the UI ("Starred — pinned to your sidebar", "You have
// access to these"), so grouping stays something a reader can predict. Nothing is
// hidden — the unstarred group lists everything else.
export function CollectionsView({
  collections,
  onStar,
  onCreate,
  draft,
  setDraft,
}: {
  collections: Collection[]
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
          title="Working in"
          rule="Starred, plus any you've published or commented in this month."
          cols={working}
          onStar={onStar}
        />
      )}
      {rest.length > 0 && (
        <Group
          testId="collections-all"
          title={working.length > 0 ? "Everything else" : "Collections"}
          rule={
            working.length > 0
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
      {/* The house section register (mono smallcaps + a rule to the edge), so the group
          label recedes and the shelf names are the biggest thing in the group. A
          same-size heading above a same-size title left the eye nothing to land on. */}
      <SectionEyebrow count={cols.length} className="mb-1">
        {title}
      </SectionEyebrow>
      <p className="mb-2 font-mono text-2xs text-muted-foreground/70">{rule}</p>
      <div className="flex flex-col gap-0.5">
        {/* Shelves with something on them first; empties sink, compressed to a title
            line each. Stable within each half. */}
        {[...cols]
          .sort((a, b) => Number((b.count ?? 0) > 0) - Number((a.count ?? 0) > 0))
          .map((col) => (
            <CollectionRow key={col.id} col={col} onStar={(next) => onStar(col.id, next)} />
          ))}
      </div>
    </section>
  )
}
