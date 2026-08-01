import { useState } from "react"
import type { Collection } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CollectionCard } from "./collection-card"

// The library's second view: your shelves, as cards.
//
// Two groups, each stating its own rule on the page in words that don't assume you know
// how the app is built. That is the whole difference between this and a ranking — a rule
// you can read is a rule you can disagree with, and "you have access to these" is a fact
// about you, not a score.
//
// Starred leads. Everything else is listed below rather than hidden: the collections you
// don't work in stop being your problem by default, without anyone deciding you shouldn't
// have them.
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

  if (collections.length === 0) {
    return (
      <EmptyState
        icon={<Icon name="collections" strokeWidth={1.75} />}
        title="No collections yet."
        description="A collection groups related documents, and sharing one shares everything in it."
        action={
          <button
            type="button"
            data-testid="collections-empty-create"
            onClick={() => setDraft("")}
            className="rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            New collection
          </button>
        }
      />
    )
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
              onClick={submit}
              disabled={!draft.trim()}
            >
              Create
            </Button>
          </>
        )}
      </div>

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
