import type { SortMode } from "@derive/core"
import type { ReactNode } from "react"
import type { Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { AuthorChip } from "@/components/shared/author-chip"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { artifactTypeLabel, dirOf } from "@/lib/artifact"
import { REVEAL_MENU, reveal } from "@/lib/interaction"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"
import { needsYouCount } from "./needs-you"

// The library as a real list — aligned columns, one line per artifact.
//
// What this replaces was a list in name only: the same cards, stacked, each keeping its
// own border and spending three lines on a title, a relative time, and a badge reading
// HTML on nine rows in ten. 83px an artifact, six to a screen, and nothing lined up with
// anything, so there was no column to run your eye down. A list is a table; the
// alignment IS the affordance. 36px here, twenty-one to a screen, and it gains the
// author on the way.
//
// The render is deliberately absent. Grid is where Derive's claim lives — big covers,
// few per screen, built to show the artifact itself. This is the working view: you know
// what these are and you are finding one. A thumbnail in a 36px row is a smudge.

/** Columns, in one place, so the header and the rows cannot drift apart. */
const COL = {
  gutter: "w-2.5 shrink-0",
  select: "w-[22px] shrink-0",
  type: "w-5 shrink-0",
  name: "min-w-0 flex-1",
  author: "w-[148px] shrink-0 max-lg:hidden",
  state: "w-[86px] shrink-0 max-xl:hidden",
  when: "w-[88px] shrink-0 text-right",
}

/** Which header cells sort. Clicking the active one reverses it, the way every file
 *  browser behaves; the pair is the mode and its opposite. */
const SORTS: { key: "name" | "when"; label: string; desc: SortMode; asc: SortMode; col: string }[] =
  [
    { key: "name", label: "Name", desc: "az", asc: "za", col: COL.name },
    { key: "when", label: "Updated", desc: "updated", asc: "updated-asc", col: COL.when },
  ]

/**
 * The list's one card. Rows live inside it separated by hairlines; nothing is bordered
 * individually, which is the whole difference between a list and a stack of cards.
 */
export function ListShell({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="artifact-list"
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      {children}
    </div>
  )
}

// The header is not decoration: it is where sort lives. It used to be two clicks into a
// Display menu that also held layout and grouping; clicking a column is the gesture every
// file browser has already taught everyone.
export function ListHeader({ sort, onSort }: { sort: SortMode; onSort: (m: SortMode) => void }) {
  return (
    <div className="flex h-7 items-center border-b border-border bg-secondary/40 pr-3 font-mono text-2xs uppercase tracking-wide text-muted-foreground">
      <span className={COL.gutter} />
      <span className={COL.select} />
      <span className={COL.type} />
      {SORTS.map(({ key, label, desc, asc, col }) => {
        const active = sort === desc || sort === asc
        const next = sort === desc ? asc : desc
        return (
          <span key={key} className={cn(col, key === "when" && "order-last")}>
            <button
              type="button"
              data-testid={`list-sort-${key}`}
              aria-pressed={active}
              title={`Sort by ${label.toLowerCase()}`}
              onClick={() => onSort(next)}
              className={cn(
                "inline-flex items-center gap-1 rounded-sm uppercase outline-none transition-colors duration-state hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                key === "when" && "flex-row-reverse",
                active && "text-foreground",
              )}
            >
              {label}
              {active && (
                <Icon
                  name="caret"
                  size={11}
                  aria-hidden
                  className={cn(
                    "transition-transform duration-state",
                    sort === asc && "rotate-180",
                  )}
                />
              )}
            </button>
          </span>
        )
      })}
      <span className={COL.author}>Author</span>
      <span className={COL.state} />
    </div>
  )
}

export function ArtifactListRow({
  artifact: a,
  onOpen,
  onToggleFavorite,
  onAddToCollection,
  onDelete,
  onPrefetch,
  selected = false,
  selectionActive = false,
  onSelect,
  indent = false,
}: {
  artifact: Artifact
  onOpen: () => void
  onToggleFavorite: () => void
  onAddToCollection?: () => void
  onDelete?: () => void
  onPrefetch?: () => void
  selected?: boolean
  selectionActive?: boolean
  onSelect?: (shift: boolean) => void
  /** Nested under a collection header in the grouped view. */
  indent?: boolean
}) {
  const updated = a.updated_at ?? a.created_at ?? a.versions[0]?.created_at
  const dir = a.source_path ? dirOf(a.source_path) : ""
  const isPrivate = a.workspace_access === "none" && (a.link_role ?? "none") === "none"
  const needs = needsYouCount(a)
  const awaitingReview =
    (a.my_role === "owner" || a.my_role === "editor") && (a.open_proposals ?? 0) > 0
  // The 10px gutter is reserved, always. A row that wants you takes an ink bar in it, so
  // the flag never widens the row or shoves its neighbours — and because the gutter is
  // usually empty, the one row that isn't reads from across the screen.
  const flagged = a.mentions_me || a.i_participated || awaitingReview
  const author = a.author ?? null

  return (
    <div
      data-selected={selected || undefined}
      data-testid={`artifact-list-row-${a.short_id}`}
      className={cn(
        "group relative flex h-9 items-center border-b border-border-soft pr-3 transition-colors duration-state last:border-b-0",
        selected ? "bg-primary/5" : "hover:bg-secondary/60",
      )}
    >
      {/* Selection outranks the ambient flag — while you're building a set, the only
          question the row answers is whether it's in it. */}
      {(selected || flagged) && (
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-0 left-0 w-0.5",
            selected ? "bg-primary" : a.mentions_me ? "bg-primary" : "bg-foreground/40",
          )}
        />
      )}
      <span className={COL.gutter} />
      <span className={cn(COL.select, "flex items-center")}>
        {onSelect && (
          <Checkbox
            data-testid={`artifact-list-select-${a.short_id}`}
            aria-label={`Select ${a.title ?? a.short_id}`}
            checked={selected}
            onClick={(e) => {
              e.stopPropagation()
              onSelect(e.shiftKey)
            }}
            className={cn("relative z-20 size-3.5", reveal(selected || selectionActive))}
          />
        )}
      </span>
      <span className={cn(COL.type, "text-muted-foreground")} title={artifactTypeLabel(a)}>
        <Icon name={a.spa ? "collections" : "all"} size={13} aria-hidden />
      </span>

      <button
        type="button"
        data-testid={`artifact-list-open-${a.short_id}`}
        onClick={onOpen}
        onMouseEnter={onPrefetch}
        onPointerDown={onPrefetch}
        onFocus={onPrefetch}
        aria-label={`Open ${a.title ?? a.short_id}`}
        className={cn(
          COL.name,
          "flex items-baseline gap-2 pr-4 text-left outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring",
          indent && "pl-5",
        )}
      >
        <span className="truncate text-sm font-medium tracking-tight text-foreground">
          {a.title ?? a.short_id}
        </span>
        {dir && (
          <span
            className="shrink-0 truncate font-mono text-2xs text-muted-foreground/80"
            title={a.source_path ?? undefined}
          >
            {dir}/
          </span>
        )}
      </button>

      <span className={cn(COL.author, "min-w-0 pr-3")}>
        <AuthorChip
          name={author?.name ?? a.author_name ?? null}
          login={author?.login ?? a.author_login ?? null}
          avatar={author?.avatar ?? a.author_avatar ?? null}
          handle={author?.handle ?? null}
          size="xs"
          className="relative z-20 min-w-0"
          data-testid={`artifact-list-author-${a.short_id}`}
        />
      </span>

      <span className={cn(COL.state, "flex items-center gap-1.5")}>
        {isPrivate && (
          <span
            role="img"
            aria-label="Private"
            title="Private — only you and people you add"
            className="text-muted-foreground/70"
          >
            <Icon name="lock" size={12} />
          </span>
        )}
        {needs > 0 && (
          <span className="font-mono text-2xs tabular-nums text-foreground">{needs}↩</span>
        )}
      </span>

      {/* Updated and the actions share one 88px slot: the date crossfades out and the
          controls take its place, so nothing appears, nothing shifts, and the row never
          twitches as the cursor crosses it. */}
      <span className={cn(COL.when, "relative")}>
        <span
          className={cn(
            "font-mono text-2xs tabular-nums text-muted-foreground transition-opacity duration-state",
            "group-hover:opacity-0 group-focus-within:opacity-0",
          )}
        >
          {updated ? ago(updated) : ""}
        </span>
        <span className="absolute inset-y-0 right-0 flex items-center justify-end gap-0.5">
          <button
            type="button"
            data-testid={`artifact-list-favorite-${a.short_id}`}
            aria-label="Toggle favorite"
            aria-pressed={a.favorite}
            onClick={(e) => {
              e.stopPropagation()
              onToggleFavorite()
            }}
            className={cn(
              "relative z-20 grid size-6 place-items-center rounded-md outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              reveal(!!a.favorite),
            )}
          >
            <Icon
              name="star"
              size={13}
              weight={a.favorite ? "fill" : "regular"}
              className={a.favorite ? "text-primary" : "text-muted-foreground"}
            />
          </button>
          {(onAddToCollection || onDelete) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid={`artifact-list-more-${a.short_id}`}
                  aria-label="More actions"
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    "relative z-20 grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    REVEAL_MENU,
                  )}
                >
                  <Icon name="more" size={13} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                {onAddToCollection && (
                  <DropdownMenuItem
                    data-testid={`artifact-list-collections-${a.short_id}`}
                    onSelect={onAddToCollection}
                  >
                    <Icon name="collections" size={16} /> Add to collection
                  </DropdownMenuItem>
                )}
                {onDelete && (
                  <>
                    {onAddToCollection && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      data-testid={`artifact-list-delete-${a.short_id}`}
                      variant="destructive"
                      onSelect={onDelete}
                    >
                      <Icon name="delete" size={16} /> Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </span>
    </div>
  )
}

/** A collection's header inside the grouped list: 32px, disclosure, name, count, star. */
export function ListGroupHeader({
  title,
  count,
  open,
  onToggle,
  starred,
  onStar,
  testId,
}: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
  starred?: boolean
  onStar?: (next: boolean) => void
  testId: string
}) {
  return (
    <div className="group flex h-8 items-center gap-2 border-b border-border bg-secondary/40 pr-3 pl-2.5">
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Icon
          name="caret"
          size={12}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform duration-state",
            !open && "-rotate-90",
          )}
          aria-hidden
        />
        <span className="truncate text-xs font-semibold tracking-tight text-foreground">
          {title}
        </span>
        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
          {count}
        </span>
      </button>
      {onStar && (
        <button
          type="button"
          data-testid={`${testId}-star`}
          aria-pressed={!!starred}
          aria-label={starred ? `Unstar ${title}` : `Star ${title}`}
          onClick={() => onStar(!starred)}
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-md outline-none hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            reveal(!!starred),
          )}
        >
          <Icon
            name="star"
            size={13}
            weight={starred ? "fill" : "regular"}
            className={starred ? "text-primary" : "text-muted-foreground"}
          />
        </button>
      )}
    </div>
  )
}
