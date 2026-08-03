import { useQuery } from "@tanstack/react-query"
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react"
import { api, type Collection } from "@/api"
import { Icon } from "@/components/icons"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { artifactQuery, collectionSuggestionsQuery, collectionsQuery } from "@/lib/queries"
import { ago } from "@/lib/time"
import { useApiMutation } from "@/lib/use-api-mutation"
import { useBrandprintCollectionIds } from "@/lib/use-brandprint-ids"
import { cn } from "@/lib/utils"

// The "organize" dialog, shared by the artifact workbench's ⋯ menu and the library
// cards' quick-actions menu (controlled by both): toggle this artifact in/out of
// collections, or create one on the fly. Adding to a shared collection grants its members
// their role on this artifact too. Owns its API calls and reports the new state through
// `onChange`; the caller keeps the cache writes.
//
// The list is a picker, so it answers "where do I file this" rather than inventorying:
// a couple of suggestions (your recent desks, then title kinship) above an alphabetical
// index, one filter-or-create input above both. Membership lives in the row's trailing
// checkbox — bg-accent stays the pointer/keyboard wash, never a second meaning.

/** Collections an organize dialog offers at all: hand-made ones. Repo mirrors and PR
 *  previews fill themselves from GitHub, and Brandprint-pointed collections are managed
 *  on /brandprint — offering any of them here is a row you shouldn't press. */
export function pickableCollections(
  all: Collection[],
  excludeIds: ReadonlySet<string>,
): Collection[] {
  return all.filter((col) => (col.kind ?? "manual") === "manual" && !excludeIds.has(col.id))
}

/** Whether the caller can file an artifact into this collection. The add route demands
 *  `publish` on the collection, so a viewer/commenter row renders inert instead of
 *  optimistically checking and bouncing back as an error toast. */
export const canAddTo = (col: Collection): boolean =>
  col.my_role === "editor" || col.my_role === "owner"

const byTitle = (a: Collection, b: Collection) =>
  a.title.localeCompare(b.title, undefined, { sensitivity: "base" })

// Title kinship, for the "similar" suggestion tier: meaningful words two titles share.
// Lowercased, split on non-word runs, articles/connectives dropped, a trailing plural-s
// stripped so "screenshots" meets "screenshot". Deliberately dumb — it only has to rank
// a workspace's handful of collections, not search a corpus.
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "for",
  "to",
  "in",
  "on",
  "with",
  "from",
])
const titleTokens = (s: string): Set<string> => {
  const out = new Set<string>()
  for (const raw of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const t = raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t)
  }
  return out
}
export const titleAffinity = (a: string, b: string): number => {
  const ta = titleTokens(a)
  let n = 0
  for (const t of titleTokens(b)) if (ta.has(t)) n++
  return n
}

export type SuggestReason = "recent" | "neighbors" | "similar"
export type OrganizeList =
  /** No query: a short Suggested tier above the full alphabetical index (deduped). */
  | { mode: "browse"; suggested: { col: Collection; reason: SuggestReason }[]; rest: Collection[] }
  /** A query: matches ranked prefix → word-prefix → substring, then A–Z; `create`
   *  carries the draft title unless a collection already has exactly that name. */
  | { mode: "filter"; matches: Collection[]; create: string | null }

const SUGGESTED_MAX = 3
/** Below this many collections the whole list fits in one glance — section labels
 *  would be chrome, not help. */
const SUGGESTED_MIN_LIST = 6

/**
 * The picker's whole ordering policy, pure so tests pin it (the Collections page's
 * digest earned the same treatment — see digestFor).
 *
 * Suggested = the collections YOU touched most recently (filing runs in batches, so
 * your last desk is the best guess), then where semantically-similar artifacts already
 * live (`semanticIds`, the server's neighbor vote — already ranked), then title kinship
 * with the artifact being filed. Only collections the caller can add to are suggested;
 * the rest stay reachable in the alphabetical index below.
 */
export function organizeList(
  pickable: Collection[],
  query: string,
  artifactTitle?: string,
  semanticIds?: string[],
): OrganizeList {
  const q = query.trim().toLowerCase()
  if (q) {
    const rank = (col: Collection): number => {
      const t = col.title.toLowerCase()
      if (t.startsWith(q)) return 0
      if (t.split(/\s+/).some((w) => w.startsWith(q))) return 1
      return t.includes(q) ? 2 : 3
    }
    const matches = pickable
      .map((col) => ({ col, rank: rank(col) }))
      .filter((r) => r.rank < 3)
      .sort((a, b) => a.rank - b.rank || byTitle(a.col, b.col))
      .map((r) => r.col)
    const exact = pickable.some((col) => col.title.trim().toLowerCase() === q)
    return { mode: "filter", matches, create: exact ? null : query.trim() }
  }

  const rest = [...pickable].sort(byTitle)
  if (pickable.length < SUGGESTED_MIN_LIST) return { mode: "browse", suggested: [], rest }

  const suggested: { col: Collection; reason: SuggestReason }[] = []
  const addable = pickable.filter(canAddTo)
  const recent = addable
    .filter((col) => col.my_last_activity)
    .sort((a, b) => (b.my_last_activity ?? "").localeCompare(a.my_last_activity ?? ""))
  for (const col of recent.slice(0, 2)) suggested.push({ col, reason: "recent" })
  if (semanticIds?.length) {
    const byId = new Map(addable.map((col) => [col.id, col]))
    for (const id of semanticIds) {
      if (suggested.length >= SUGGESTED_MAX) break
      const col = byId.get(id)
      if (col && !suggested.some((s) => s.col.id === col.id))
        suggested.push({ col, reason: "neighbors" })
    }
  }
  if (artifactTitle) {
    const kin = addable
      .filter((col) => !suggested.some((s) => s.col.id === col.id))
      .map((col) => ({ col, score: titleAffinity(artifactTitle, col.title) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || byTitle(a.col, b.col))
    for (const { col } of kin.slice(0, SUGGESTED_MAX - suggested.length))
      suggested.push({ col, reason: "similar" })
  }
  const picked = new Set(suggested.map((s) => s.col.id))
  return { mode: "browse", suggested, rest: rest.filter((col) => !picked.has(col.id)) }
}

// The menu-row grammar (the dropdown item recipe): rounded-lg, bg-accent as the
// pointer/keyboard wash only — membership renders in the checkbox, never as a wash.
const ROW_CLASS =
  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-foreground outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-60"

/** One picker row — also the bulk dialog's row, so the grammar can't drift. */
export function CollectionToggleRow({
  col,
  checked,
  disabled,
  highlighted,
  hint,
  onSelect,
  onHover,
  testId,
  rowIndex,
}: {
  col: Collection
  checked: boolean
  disabled?: boolean
  highlighted?: boolean
  /** Small trailing note: a suggestion's reason, or "view only" on an inert row. */
  hint?: string
  onSelect: () => void
  onHover?: () => void
  testId: string
  rowIndex?: number
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-idx={rowIndex}
      aria-pressed={checked}
      disabled={disabled}
      onClick={onSelect}
      onMouseMove={onHover}
      className={cn(ROW_CLASS, highlighted && "bg-accent")}
    >
      <Icon name="collection" size={16} className="shrink-0 text-muted-foreground" />
      <span className={cn("min-w-0 flex-1 truncate", checked && "font-semibold")}>{col.title}</span>
      {hint && <span className="shrink-0 text-2xs text-muted-foreground">{hint}</span>}
      <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
        {col.count}
      </span>
      <span
        aria-hidden
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded border",
          checked ? "border-foreground bg-foreground text-background" : "border-input",
        )}
      >
        {checked && <Icon name="check" size={12} />}
      </span>
    </button>
  )
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="px-2 pt-2.5 pb-1 font-medium text-2xs tracking-wide text-muted-foreground uppercase first:pt-0.5">
      {children}
    </div>
  )
}

export function CollectionsDialog({
  shortId,
  artifactTitle,
  inCollections,
  onChange,
  open,
  onOpenChange,
}: {
  shortId: string
  /** Feeds the "similar title" suggestion tier; the picker works without it. */
  artifactTitle?: string
  inCollections: string[]
  onChange: (ids: string[]) => void
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const {
    data: all = [],
    isPending,
    isError,
    refetch,
  } = useQuery({ ...collectionsQuery(), enabled: open })
  const [query, setQuery] = useState("")
  // Keyboard position among the actionable rows (null = nowhere: a bare Enter must not
  // toggle a collection the user never aimed at). Typing aims at the first match.
  const [cursor, setCursor] = useState<number | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // The workbench keeps this dialog mounted; a reopen must not inherit last time's
  // filter. Reset on close so the exit animation carries the old list out.
  useEffect(() => {
    if (!open) {
      setQuery("")
      setCursor(null)
    }
  }, [open])

  // Brandprint-pointed collections take docs through Settings → Brandprint only, not from
  // an artifact's organize menu.
  const brandprintIds = useBrandprintCollectionIds()
  const pickable = pickableCollections(all, brandprintIds)
  // The semantic tier — "collections where similar artifacts already live", from the
  // dense index's neighbor vote. Best-effort garnish: a miss, an error, or an install
  // with no dense arm all read as "no suggestions" and the local tiers carry the list.
  const { data: semanticIds } = useQuery({
    ...collectionSuggestionsQuery(shortId),
    enabled: open,
  })
  const list = organizeList(pickable, query, artifactTitle, semanticIds)
  const inSet = new Set(inCollections)

  // Toggle membership optimistically (via onChange); the primitive rolls it back and
  // toasts if the write fails. The settle-time invalidation reconciles the artifact
  // detail (`collections` AND the server-computed `collection_access` disclosure rows)
  // against the server once the write lands — never during the optimistic phase, where
  // a refetch would race the in-flight PUT and repaint pre-mutation state. The
  // collections list rides along so the rows' item counts stay honest.
  const toggleCol = useApiMutation({
    mutationFn: ({ col, isIn }: { col: Collection; isIn: boolean }) =>
      isIn ? api.removeFromCollection(col.id, shortId) : api.addToCollection(col.id, shortId),
    optimistic: ({ col, isIn }) => {
      const prev = inCollections
      onChange(isIn ? inCollections.filter((id) => id !== col.id) : [...inCollections, col.id])
      return () => onChange(prev)
    },
    invalidate: [artifactQuery(shortId).queryKey, collectionsQuery().queryKey],
  })
  const toggle = (col: Collection) => toggleCol.mutate({ col, isIn: inSet.has(col.id) })
  // Create a collection and drop this artifact into it in one gesture.
  const createCol = useApiMutation({
    mutationFn: async (title: string) => {
      const col = await api.createCollection(title)
      await api.addToCollection(col.id, shortId)
      return col
    },
    onSuccess: (col) => {
      onChange([...inCollections, col.id])
      setQuery("")
      setCursor(null)
    },
    invalidate: [artifactQuery(shortId).queryKey, collectionsQuery().queryKey],
  })
  const create = () => {
    if (list.mode === "filter" && list.create && !createCol.isPending) createCol.mutate(list.create)
  }

  // The rows in visual order, with what Enter on each would do — the keyboard walks
  // exactly what the eye sees, skipping inert (view-only) rows.
  const actions: (() => void)[] = []
  const register = (run: () => void): number => actions.push(run) - 1
  const rowFor = (col: Collection, reason?: SuggestReason) => {
    const addable = canAddTo(col)
    const idx = addable ? register(() => toggle(col)) : -1
    return (
      <CollectionToggleRow
        key={col.id}
        col={col}
        checked={inSet.has(col.id)}
        disabled={!addable}
        highlighted={idx !== -1 && idx === cursor}
        hint={
          !addable
            ? "view only"
            : reason === "recent" && col.my_last_activity
              ? ago(col.my_last_activity)
              : reason === "neighbors"
                ? "similar artifacts"
                : reason === "similar"
                  ? "similar title"
                  : undefined
        }
        onSelect={() => toggle(col)}
        onHover={() => setCursor(idx)}
        testId={`collections-menu-${col.id}`}
        rowIndex={idx === -1 ? undefined : idx}
      />
    )
  }
  const body: ReactNode[] = []
  if (list.mode === "browse") {
    if (list.suggested.length > 0) {
      body.push(<SectionLabel key="l-suggested">Suggested</SectionLabel>)
      body.push(...list.suggested.map(({ col, reason }) => rowFor(col, reason)))
      body.push(<SectionLabel key="l-all">All collections</SectionLabel>)
    }
    body.push(...list.rest.map((col) => rowFor(col)))
  } else {
    body.push(...list.matches.map((col) => rowFor(col)))
    if (list.create) {
      const idx = register(create)
      body.push(
        <button
          key="create"
          type="button"
          data-testid="collections-create"
          data-idx={idx}
          disabled={createCol.isPending}
          onClick={create}
          onMouseMove={() => setCursor(idx)}
          className={cn(ROW_CLASS, idx === cursor && "bg-accent")}
        >
          <Icon name="plus" size={16} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">Create “{list.create}”</span>
        </button>,
      )
    }
  }

  const move = (delta: number) => {
    if (actions.length === 0) return
    const next =
      cursor === null
        ? delta > 0
          ? 0
          : actions.length - 1
        : Math.min(actions.length - 1, Math.max(0, cursor + delta))
    setCursor(next)
    requestAnimationFrame(() =>
      listRef.current?.querySelector(`[data-idx="${next}"]`)?.scrollIntoView({ block: "nearest" }),
    )
  }
  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      move(e.key === "ArrowDown" ? 1 : -1)
    } else if (e.key === "Enter") {
      e.preventDefault()
      // A bare Enter acts only where the user has aimed: the cursor row, or — while
      // filtering — the first match (the combobox default).
      const at = cursor ?? (query.trim() ? 0 : null)
      if (at !== null) actions[at]?.()
    }
  }

  const membership =
    inCollections.length === 0
      ? "Not in any collection"
      : `In ${inCollections.length} ${inCollections.length === 1 ? "collection" : "collections"}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to collection</DialogTitle>
          <DialogDescription>
            Collections group related artifacts; sharing a collection shares its artifacts with its
            members.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={query}
          placeholder="Filter or create…"
          aria-label="Filter collections, or type a new name"
          data-testid="collections-filter"
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(e.target.value.trim() ? 0 : null)
          }}
          onKeyDown={onInputKeyDown}
        />
        {/* A failed load is NOT "no collections yet" — saying so would invite you to
            create a duplicate of one you already have. */}
        {isError && (
          <StatusPanel
            tone="danger"
            title="Couldn’t load your collections"
            description="This is usually temporary."
            action={
              <Button
                variant="outline"
                size="sm"
                data-testid="collections-retry"
                onClick={() => refetch()}
              >
                Try again
              </Button>
            }
          />
        )}
        {!isError && isPending && (
          <div className="text-sm text-muted-foreground">Loading collections…</div>
        )}
        {!isError && !isPending && body.length === 0 && (
          <div className="text-sm text-muted-foreground">
            {query.trim()
              ? "No collection matches."
              : "No collections yet — type a name above to create one."}
          </div>
        )}
        {body.length > 0 && (
          <div ref={listRef} className="flex max-h-64 flex-col gap-px overflow-auto">
            {body}
          </div>
        )}
        <DialogFooter className="items-center">
          <span className="mr-auto text-xs text-muted-foreground">{membership}</span>
          <Button size="sm" data-testid="collections-done" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
