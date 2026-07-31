import type { Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { AuthorChip } from "@/components/shared/author-chip"
import { FollowButton } from "@/components/shared/follow-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { artifactTypeLabel, dirOf } from "@/lib/artifact"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"
import { CommentSignal } from "./comment-signal"
import { ProposalSignal } from "./proposal-signal"

/**
 * A compact list row for the library (the default for collections / synced repos,
 * where a flat thumbnail grid is noise for hundreds of docs). Reads top-to-bottom:
 * title, when it was last updated, then a meta line of type + folder location.
 * Same stretched-link + independently-clickable-controls pattern as ArtifactCard.
 */
export function ArtifactRow({
  artifact: a,
  onOpen,
  onToggleFavorite,
  onPickAuthor,
  onAddToCollection,
  onDelete,
  onPrefetch,
  selected = false,
  selectionActive = false,
  onSelect,
}: {
  artifact: Artifact
  onOpen: () => void
  onToggleFavorite: () => void
  // Clicking the author filters the list by their GitHub login. Omit to render
  // the author as a non-filtering chip (still links to a known profile).
  onPickAuthor?: (login: string) => void
  // Quick action in the ⋯ menu — organize without opening the artifact.
  // Collections apply to any signed-in viewer (you're organizing your
  // collections, not mutating the artifact).
  onAddToCollection?: () => void
  onDelete?: () => void
  onPrefetch?: () => void
  // Multi-select — the row's twin of the card's checkbox, same rules: the box is the
  // only selection gesture, so a click on the row still opens the artifact.
  selected?: boolean
  selectionActive?: boolean
  onSelect?: (shift: boolean) => void
}) {
  const isOwner = a.my_role === "owner"
  const showDelete = isOwner && !!onDelete
  const showMenu = !!onAddToCollection || showDelete
  const updated = a.updated_at ?? a.created_at ?? a.versions[0]?.created_at
  const dir = a.source_path ? dirOf(a.source_path) : ""
  // "Who last changed this": prefer the resolved author (carries the Derive handle),
  // fall back to the denormalized fields. Present only for synced artifacts.
  const author = a.author ?? null
  const authorLogin = author?.login ?? a.author_login ?? null
  const hasAuthor = !!(author?.name || authorLogin || a.author_name)
  // Proposals you can act on (owner/editor) soft-ink the row edge — the same
  // "needs you" accent as a thread you're in (see ProposalSignal + ArtifactCard).
  const awaitingReview =
    (a.my_role === "owner" || a.my_role === "editor") && (a.open_proposals ?? 0) > 0

  return (
    <div
      data-selected={selected || undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 hover:bg-secondary",
        // Selection outranks the ambient accents — see ArtifactCard.
        selected
          ? "border-primary ring-2 ring-primary/40"
          : // Needs-your-feedback accents — the ink accent is the sanctioned attention signal.
            a.mentions_me
            ? "border-primary ring-1 ring-primary/30"
            : a.i_participated || awaitingReview
              ? "border-primary/60"
              : "border-border",
      )}
    >
      {/* Leading edge, ahead of the title. It holds its column at rest (opacity, not
          display) so revealing it on hover never reflows the row. */}
      {onSelect && (
        <Checkbox
          data-testid={`artifact-row-select-${a.short_id}`}
          aria-label={`Select ${a.title ?? a.short_id}`}
          checked={selected}
          onClick={(e) => {
            e.stopPropagation()
            onSelect(e.shiftKey)
          }}
          className={cn(
            "relative z-20 shrink-0 transition-opacity",
            !selected &&
              !selectionActive &&
              "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
          )}
        />
      )}
      <button
        type="button"
        data-testid={`artifact-row-open-${a.short_id}`}
        onClick={onOpen}
        onMouseEnter={onPrefetch}
        // Touch never fires mouseenter — pointerdown lands ~100ms before the click
        // completes, so a tap gets the same head start a hover gives a mouse.
        onPointerDown={onPrefetch}
        onFocus={onPrefetch}
        aria-label={`Open ${a.title ?? a.short_id}`}
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left outline-none after:absolute after:inset-0 after:z-1 after:rounded-lg after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
      >
        {/* The title is the work — Geist voice (text-base clears the size floor). */}
        <span className="truncate font-serif text-base font-medium tracking-tight text-foreground">
          {a.title ?? a.short_id}
        </span>
        {updated && (
          <span className="font-mono text-2xs text-muted-foreground">updated {ago(updated)}</span>
        )}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-2xs tabular-nums text-muted-foreground">
          <Badge shape="pill">{artifactTypeLabel(a)}</Badge>
          {/* Invite-only work is invisible to everyone but its members — the chip
              says so wherever the doc DOES surface (your library, Created by me). */}
          {a.workspace_access === "none" && (a.link_role ?? "none") === "none" && (
            <Badge shape="pill" variant="outline" title="Only you and people you add">
              <Icon name="lock" size={12} /> Private
            </Badge>
          )}
          {dir && (
            <span className="inline-flex items-center gap-1 truncate" title={a.source_path ?? ""}>
              {/* Neutral metadata — a folder path is not a brand moment. */}
              <Icon name="collection" size={12} />
              {dir}/
            </span>
          )}
          <ProposalSignal artifact={a} size={12} className="relative z-20" />
          <CommentSignal artifact={a} size={12} className="relative z-20" />
          {a.views !== undefined && a.views > 0 && (
            <span className="inline-flex items-center gap-1" title={`${a.views} viewers`}>
              <Icon name="views" size={12} />
              {a.views > 999 ? `${(a.views / 1000).toFixed(1)}k` : a.views}
            </span>
          )}
        </span>
      </button>

      {/* "Who last changed this" — above the stretched link so the click-to-filter
          button (and the profile link) stay independently clickable. */}
      {hasAuthor && (
        <div className="relative z-20 hidden shrink-0 items-center gap-2 sm:flex">
          <AuthorChip
            name={author?.name ?? a.author_name ?? null}
            login={authorLogin}
            avatar={author?.avatar ?? a.author_avatar ?? null}
            handle={author?.handle ?? null}
            onClick={onPickAuthor && authorLogin ? () => onPickAuthor(authorLogin) : undefined}
            data-testid={`artifact-row-author-${a.short_id}`}
          />
          {/* Ambient follow: when the author is a known Derive person, follow them right
              from the row (self-hides for your own work / signed-out). */}
          {author?.handle && <FollowButton username={author.handle} size="xs" />}
        </div>
      )}

      <Button
        size="icon"
        variant="outline"
        data-testid={`artifact-row-favorite-${a.short_id}`}
        aria-label="Toggle favorite"
        aria-pressed={a.favorite}
        onClick={(e) => {
          e.stopPropagation()
          onToggleFavorite()
        }}
        className="relative z-20"
      >
        {/* Favorited = ink-filled star (the sanctioned brand tint); muted when off. */}
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

      {showMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="outline"
              data-testid={`artifact-row-more-${a.short_id}`}
              aria-label="More actions"
              onClick={(e) => e.stopPropagation()}
              className="relative z-20 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
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
                data-testid={`artifact-row-collections-${a.short_id}`}
                onSelect={() => onAddToCollection()}
              >
                <Icon name="collections" size={16} />
                Add to collection
              </DropdownMenuItem>
            )}
            {showDelete && (
              <>
                {onAddToCollection && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  data-testid={`artifact-row-delete-${a.short_id}`}
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
    </div>
  )
}

/** Most-recently-updated first; falls back to created/version time, then title. */
export const byRecency = (a: Artifact, b: Artifact): number => {
  const ta = a.updated_at ?? a.created_at ?? a.versions[0]?.created_at ?? ""
  const tb = b.updated_at ?? b.created_at ?? b.versions[0]?.created_at ?? ""
  if (ta !== tb) return tb.localeCompare(ta)
  return (a.title ?? a.short_id).localeCompare(b.title ?? b.short_id)
}
