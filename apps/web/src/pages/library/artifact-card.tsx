import { useRef } from "react"
import type { Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { AuthorChip } from "@/components/shared/author-chip"
import { Thumb } from "@/components/shared/thumb"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { artifactTypeLabel, dirOf } from "@/lib/artifact"
import { OVER_CONTENT, REVEAL_MENU, reveal } from "@/lib/interaction"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"
import { NeedsYou, needsYouCount } from "./needs-you"

// One card in the library grid, preview-first. The live render is the hero (bleeds to
// the top edge, carrying a single machine-register TYPE placard); a hairline-divided
// caption below holds the title in voice, a mono state line (folder · freshness), and
// one split meta row — who made it on the left, its state on the right. Clean at rest; the actions (star, ⋯) reveal on hover, and the ink edge
// accent (a persistent "needs you" state) shows at rest.
//
// Stretched-link pattern: the open button's ::after covers the whole card (preview
// included), while the actions and author sit above it (z-20) and stay independently
// clickable.
export function ArtifactCard({
  artifact: a,
  onOpen,
  onToggleFavorite,
  onAddToCollection,
  onArchive,
  onDelete,
  onPrefetch,
  selected = false,
  selectionActive = false,
  onSelect,
}: {
  artifact: Artifact
  onOpen: () => void
  onToggleFavorite?: () => void
  // Quick action in the ⋯ menu — organize without opening the artifact.
  // Collections apply to any signed-in viewer (you're organizing your
  // collections, not mutating the artifact).
  onAddToCollection?: () => void
  onArchive?: () => void
  onDelete?: () => void
  // Warm the artifact (metadata + comments + rendered HTML) when the card is
  // hovered or focused, so the click that follows opens instantly.
  onPrefetch?: () => void
  // Multi-select. The checkbox is the ONLY selection affordance: a plain click on
  // the card still opens the artifact, even mid-selection, so the library's one
  // lifelong gesture never changes meaning underneath you.
  selected?: boolean
  // Any selection in progress — every checkbox is pinned visible, not just the
  // hovered card's, so the set you've built is legible at a glance.
  selectionActive?: boolean
  onSelect?: (shift: boolean) => void
}) {
  const titleRef = useRef<HTMLSpanElement>(null)
  const isOwner = a.my_role === "owner"
  const showDelete = isOwner && !!onDelete
  const canEdit = a.my_role === "owner" || a.my_role === "editor"
  const showArchive = canEdit && !a.removed && !!onArchive
  const showMenu = !!onAddToCollection || showArchive || showDelete
  const author = a.author ?? null
  // Every card names its author, including yours. Hiding it on your own work made the
  // row's meaning depend on who was looking: a card with no chip could mean "you made
  // it" or "we don't know who did", and scanning a mixed library for someone else's
  // work meant reading the absences.
  const hasAuthor = !!(author?.name || author?.login || a.author_login || a.author_name)
  const updated = a.updated_at ?? a.created_at ?? a.versions[0]?.created_at
  const _versionDepth = Math.max(a.current_version, a.versions.length)
  const sourceDir = a.source_path ? dirOf(a.source_path) : ""
  const isPrivate = a.workspace_access === "none" && (a.link_role ?? "none") === "none"
  // Proposals you can act on (owner/editor) are a "needs you" signal — they soft-ink
  // the card edge (the `i_participated` tier) and the review count.
  const awaitingReview =
    (a.my_role === "owner" || a.my_role === "editor") && (a.open_proposals ?? 0) > 0

  // Machine-register state line under the title (house " · " join, matching the
  // workbench header): a synced file's folder, else its version when there's history,
  // then how fresh it is. The TYPE rides the placard, so it isn't repeated here.
  // Relative time, plus the folder for a synced doc (that is where it lives). The
  // version number and type prefix are dropped — the render already shows the type.
  const stateLine = [sourceDir ? `${sourceDir}/` : "", updated ? ago(updated) : ""]
    .filter(Boolean)
    .join(" · ")

  return (
    <Card
      data-selected={selected || undefined}
      className={cn(
        "group relative isolate flex flex-col gap-0 overflow-hidden p-0 shadow-(--shadow-sm)",
        // Selection outranks every ambient signal: while you're building a set, the one
        // thing the card must answer is "am I in it?".
        selected
          ? "border-primary ring-2 ring-primary/40"
          : // A direct @mention gets the full accent + ring; a thread you're in — or
            // proposals waiting on your review — gets a softer accent border. The ink
            // accent is the sanctioned attention signal, shown at rest.
            a.mentions_me
            ? "border-primary ring-1 ring-primary/30"
            : a.i_participated || awaitingReview
              ? "border-primary/60"
              : "border-border hover:border-foreground/25",
      )}
    >
      <div className="relative">
        <Thumb
          id={a.short_id}
          v={a.current_version}
          typeLabel={artifactTypeLabel(a)}
          hasPreview={a.has_preview}
        />
        {/* The select box, opposite the actions cluster. Hidden at rest on a mouse (the
            grid stays a gallery), pinned visible once ANY card is selected, and always
            visible on touch — where there is no hover to reveal it. The ring keeps it
            legible over a busy render. */}
        {onSelect && (
          <div className="absolute top-2 left-2 z-20">
            <Checkbox
              data-testid={`artifact-card-select-${a.short_id}`}
              aria-label={`Select ${a.title ?? a.short_id}`}
              checked={selected}
              // Read the modifier off the CLICK: Radix's onCheckedChange can't see the
              // shift key, and shift-click (extend the range) is the gesture that makes
              // selecting twenty cards bearable. The parent owns the set, so letting the
              // click drive it — not onCheckedChange — keeps one source of truth.
              onClick={(e) => {
                e.stopPropagation()
                onSelect(e.shiftKey)
              }}
              // Same plate as the action buttons opposite it (OVER_CONTENT): the
              // cluster that appears on hover was a bare ringed checkbox on one side
              // and two outlined buttons on the other, which read as two different
              // controls arriving at once.
              className={cn("size-7 rounded-lg", OVER_CONTENT, reveal(selected || selectionActive))}
            />
          </div>
        )}
        {/* Actions — top-right over the render, revealed on hover/focus (always shown
            on touch; a favourited star persists). Translucent pills read over any
            render, both themes. */}
        <div className="absolute top-2 right-2 z-20 flex items-center gap-1.5">
          {showMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="outline"
                  data-testid={`artifact-card-more-${a.short_id}`}
                  aria-label="More actions"
                  onClick={(e) => e.stopPropagation()}
                  className={cn("relative border-border-soft bg-card", REVEAL_MENU)}
                >
                  <Icon name="more" size={16} />
                  <span
                    aria-hidden
                    className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
                {/* Delete stays last, behind a separator — same as the workbench ⋯ menu. */}
                {onAddToCollection && (
                  <DropdownMenuItem
                    data-testid={`artifact-card-collections-${a.short_id}`}
                    onSelect={() => onAddToCollection()}
                  >
                    <Icon name="collections" size={16} />
                    Add to collection
                  </DropdownMenuItem>
                )}
                {showArchive && (
                  <DropdownMenuItem
                    data-testid={`artifact-card-archive-${a.short_id}`}
                    onSelect={() => onArchive?.()}
                  >
                    <Icon name={a.archived ? "undo" : "archive"} size={16} />
                    {a.archived ? "Restore to library" : "Archive"}
                  </DropdownMenuItem>
                )}
                {showDelete && (
                  <>
                    {(onAddToCollection || showArchive) && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      data-testid={`artifact-card-delete-${a.short_id}`}
                      variant="destructive"
                      onSelect={() => onDelete?.()}
                    >
                      <Icon name="delete" size={16} />
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {onToggleFavorite && (
            <Button
              size="icon-sm"
              variant="outline"
              data-testid={`artifact-card-favorite-${a.short_id}`}
              aria-label="Toggle favorite"
              aria-pressed={a.favorite}
              onClick={(e) => {
                e.stopPropagation()
                onToggleFavorite()
              }}
              className={cn("relative border-border-soft bg-card", reveal(!!a.favorite))}
            >
              <Icon
                name="star"
                size={16}
                weight={a.favorite ? "fill" : "regular"}
                className={a.favorite ? "text-primary" : "text-muted-foreground"}
              />
              <span
                aria-hidden
                className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
              />
            </Button>
          )}
        </div>
      </div>

      <CardContent className="flex min-w-0 flex-col gap-2 border-t border-border-soft p-3.5">
        <button
          type="button"
          data-testid={`artifact-card-open-${a.short_id}`}
          onClick={() => {
            // Claim the shared morph name for THIS card only (duplicate names skip the
            // whole transition), then open. Cleared lazily: the next claimant strips it.
            for (const el of document.querySelectorAll<HTMLElement>("[data-vt-doc-title]")) {
              el.style.viewTransitionName = ""
              delete el.dataset.vtDocTitle
            }
            const t = titleRef.current
            if (t) {
              t.style.viewTransitionName = "doc-title"
              t.dataset.vtDocTitle = "1"
            }
            onOpen()
          }}
          onMouseEnter={onPrefetch}
          // Touch never fires mouseenter — pointerdown lands ~100ms before the click
          // completes, so a tap gets the same head start a hover gives a mouse.
          onPointerDown={onPrefetch}
          onFocus={onPrefetch}
          aria-label={`Open ${a.title ?? a.short_id}`}
          className="flex w-full min-w-0 flex-col gap-0.5 text-left outline-none after:absolute after:inset-0 after:z-1 after:rounded-xl after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
        >
          {/* The title is the work — Geist voice, sized to the caption so the preview
              stays the hero. On open it takes the shared view-transition name JUST IN
              TIME (names must be unique per snapshot, so only the clicked card may
              carry it): the router's view transition then morphs this text into the
              workbench header's title instead of cutting — the one detail that makes
              opening a document read as a physical motion. */}
          <span
            ref={titleRef}
            className="truncate font-serif text-base font-medium tracking-tight text-foreground"
          >
            {a.title ?? a.short_id}
          </span>
          {stateLine && (
            <span
              className="truncate font-mono text-2xs tabular-nums text-muted-foreground"
              title={sourceDir ? (a.source_path ?? undefined) : undefined}
            >
              {stateLine}
            </span>
          )}
        </button>

        {/* One line, three facts at most: who made it, whether it is private, and
            whether it wants you. The card used to carry nine — a version
            number, a type prefix, a Skill pill, a view count, and two separate activity
            counts — which is a lot of ink for a surface whose job is to let you pick
            something and open it. */}
        {(hasAuthor || isPrivate || needsYouCount(a) > 0) && (
          <div className="flex min-w-0 items-center gap-2 font-mono text-2xs tabular-nums text-muted-foreground">
            {hasAuthor && (
              <AuthorChip
                name={author?.name ?? a.author_name ?? null}
                login={author?.login ?? a.author_login ?? null}
                avatar={author?.avatar ?? a.author_avatar ?? null}
                handle={author?.handle ?? null}
                size="xs"
                className="relative z-20 min-w-0"
                data-testid={`artifact-card-author-${a.short_id}`}
              />
            )}
            <span className={cn("inline-flex shrink-0 items-center gap-2", hasAuthor && "ml-auto")}>
              {/* A glyph, not a worded pill: private is a state a lot of artifacts are
                  in, and the lock is already understood. */}
              {isPrivate && (
                <span
                  role="img"
                  aria-label="Private"
                  title="Private. Only you and people you add."
                  className="inline-flex opacity-70"
                >
                  <Icon name="lock" size={12} />
                </span>
              )}
              <NeedsYou artifact={a} />
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
