import type { Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { AuthorChip } from "@/components/shared/author-chip"
import { Thumb } from "@/components/shared/thumb"
import { Badge } from "@/components/ui/badge"
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
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"
import { CommentSignal } from "./comment-signal"
import { ProposalSignal } from "./proposal-signal"

// One card in the library grid, preview-first. The live render is the hero (bleeds to
// the top edge, carrying a single machine-register TYPE placard); a hairline-divided
// caption below holds the title in voice, a mono state line (version · freshness), and
// one split meta row — who made it on the left, activity (review · comments · views)
// on the right. Clean at rest; the actions (star, ⋯) reveal on hover, and the ink edge
// accent (a persistent "needs you" state) shows at rest.
//
// Stretched-link pattern: the open button's ::after covers the whole card (preview
// included), while the actions / author / tag chips sit above it (z-20) and stay
// independently clickable.
export function ArtifactCard({
  artifact: a,
  onOpen,
  onToggleFavorite,
  onPickTag,
  onEditTags,
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
  onPickTag: (tag: string) => void
  // Quick actions in the ⋯ menu — organize without opening the artifact. Tags
  // are gated per-item (owner/editor), collections apply to any signed-in
  // viewer (you're organizing your collections, not mutating the artifact).
  onEditTags?: () => void
  onAddToCollection?: () => void
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
  const isOwner = a.my_role === "owner"
  const showTags = !!onEditTags && (a.my_role === "owner" || a.my_role === "editor")
  const showDelete = isOwner && !!onDelete
  const showMenu = showTags || !!onAddToCollection || showDelete
  const author = a.author ?? null
  const hasAuthor = !!(author?.name || author?.login || a.author_login || a.author_name)
  const updated = a.updated_at ?? a.created_at ?? a.versions[0]?.created_at
  const versionDepth = Math.max(a.current_version, a.versions.length)
  const sourceDir = a.source_path ? dirOf(a.source_path) : ""
  const tags = a.tags ?? []
  const isPrivate = a.workspace_access === "none" && (a.link_role ?? "none") === "none"
  // Proposals you can act on (owner/editor) are a "needs you" signal — they soft-ink
  // the card edge (the `i_participated` tier) and the review count.
  const awaitingReview =
    (a.my_role === "owner" || a.my_role === "editor") && (a.open_proposals ?? 0) > 0

  // Machine-register state line under the title (house " · " join, matching the
  // workbench header): a synced file's folder, else its version when there's history,
  // then how fresh it is. The TYPE rides the placard, so it isn't repeated here.
  const stateLine = [
    sourceDir ? `${sourceDir}/` : versionDepth > 1 ? `v${a.current_version}` : "",
    updated ? `updated ${ago(updated)}` : "",
  ]
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
              className={cn(
                "size-5 shadow-(--shadow-sm) ring-1 ring-foreground/10 transition-opacity",
                !selected &&
                  !selectionActive &&
                  "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
              )}
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
                  className="relative border-border-soft bg-card opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
                >
                  <Icon name="more" size={16} />
                  <span
                    aria-hidden
                    className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
                {/* Same organize order as the workbench ⋯ menu: Tags, then
                    Add to collection; Delete stays last behind a separator. */}
                {showTags && (
                  <DropdownMenuItem
                    data-testid={`artifact-card-tags-${a.short_id}`}
                    onSelect={() => onEditTags?.()}
                  >
                    <Icon name="tag" size={16} />
                    Tags
                  </DropdownMenuItem>
                )}
                {onAddToCollection && (
                  <DropdownMenuItem
                    data-testid={`artifact-card-collections-${a.short_id}`}
                    onSelect={() => onAddToCollection()}
                  >
                    <Icon name="collections" size={16} />
                    Add to collection
                  </DropdownMenuItem>
                )}
                {showDelete && (
                  <>
                    {(showTags || onAddToCollection) && <DropdownMenuSeparator />}
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
            className={cn(
              "relative border-border-soft bg-card transition-opacity focus-visible:opacity-100 pointer-coarse:opacity-100",
              !a.favorite && "opacity-0 group-hover:opacity-100",
            )}
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
        </div>
      </div>

      <CardContent className="flex min-w-0 flex-col gap-2 border-t border-border-soft p-3.5">
        <button
          type="button"
          data-testid={`artifact-card-open-${a.short_id}`}
          onClick={onOpen}
          onMouseEnter={onPrefetch}
          onFocus={onPrefetch}
          aria-label={`Open ${a.title ?? a.short_id}`}
          className="flex w-full min-w-0 flex-col gap-0.5 text-left outline-none after:absolute after:inset-0 after:z-1 after:rounded-xl after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
        >
          {/* The title is the work — Geist voice, sized to the caption so the preview
              stays the hero. */}
          <span className="truncate font-serif text-base font-medium tracking-tight text-foreground">
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

        {/* People + activity: who made it on the left (avatar + name), the activity
            cluster on the right. The author is the one interactive island here (z-20);
            the rest clicks through to open. */}
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
          <span className={cn("inline-flex shrink-0 items-center gap-2.5", hasAuthor && "ml-auto")}>
            {/* Invite-only work is invisible to everyone but its members — the chip
                says so wherever the doc DOES surface (your library, Created by me). */}
            {isPrivate && (
              <Badge shape="pill" variant="outline" title="Only you and people you add">
                <Icon name="lock" size={12} /> Private
              </Badge>
            )}
            {/* A skill is reusable agent procedure (a bundle with a SKILL.md) — call it
                out wherever it surfaces so the shelf is spottable in the grid. */}
            {a.current_content_type === "derive/skill" && (
              <Badge shape="pill" variant="secondary" title="A skill: reusable agent procedure">
                Skill
              </Badge>
            )}
            {/* Review queue, then discussion, then passive views — most-actionable first. */}
            <ProposalSignal artifact={a} size={12} />
            <CommentSignal artifact={a} size={12} compact />
            {a.views !== undefined && a.views > 0 && (
              <span className="inline-flex items-center gap-1" title={`${a.views} viewers`}>
                <Icon name="views" size={12} />
                {a.views > 999 ? `${(a.views / 1000).toFixed(1)}k` : a.views}
                <span className="sr-only"> views</span>
              </span>
            )}
          </span>
        </div>

        {tags.length > 0 && (
          // One row only — chips are `nowrap` + clipped so a heavily-tagged artifact
          // can't grow the card taller than its siblings. First three are interactive
          // filter chips; a trailing "+N" counts the rest.
          <div className="relative z-20 flex min-w-0 items-center gap-1.5 overflow-hidden">
            {tags.slice(0, 3).map((t) => (
              <Badge
                key={t}
                asChild
                variant="outline"
                className="max-w-32 shrink-0 border-border-soft px-1.5 font-mono text-2xs text-muted-foreground hover:border-foreground/25 hover:text-foreground"
              >
                <button
                  type="button"
                  data-testid={`artifact-card-tag-${t}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onPickTag(t)
                  }}
                >
                  <span className="truncate">#{t}</span>
                </button>
              </Badge>
            ))}
            {tags.length > 3 && (
              <Badge
                variant="outline"
                className="shrink-0 border-border-soft px-1.5 font-mono text-2xs text-muted-foreground/70"
                title={tags
                  .slice(3)
                  .map((t) => `#${t}`)
                  .join(" ")}
              >
                +{tags.length - 3}
              </Badge>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
