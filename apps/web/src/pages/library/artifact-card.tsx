import type { Artifact } from "@/api"
import { Icon } from "@/components/icons"
import { AuthorChip } from "@/components/shared/author-chip"
import { Thumb } from "@/components/shared/thumb"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
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

// One card in the library grid, rebuilt preview-first: the live render bleeds to
// the card's top edge as the hero, carrying a single machine-register `TYPE · vN`
// chip; a hairline-divided caption below holds the title and one split meta row —
// identity (who · when) on the left, signals (feedback · views) on the right.
// The card is clean at rest and reveals its actions (star, ⋯ menu) on hover.
//
// Stretched-link pattern: the open button's ::after covers the whole card, so a
// click anywhere (preview included) opens it, while the star / menu / author / tag
// chips sit above (z-20) and stay independently clickable. Hover is an instant
// hairline-strengthen + the preview waking — no transitioned shadow (a paint prop,
// not a sanctioned move/scale/fade) and no transform (either would repaint the
// iframe); the resting soft shadow carries the card's lift.
export function ArtifactCard({
  artifact: a,
  onOpen,
  onToggleFavorite,
  onPickTag,
  onEditTags,
  onAddToCollection,
  onDelete,
  onPrefetch,
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
}) {
  const isOwner = a.my_role === "owner"
  const showTags = !!onEditTags && (a.my_role === "owner" || a.my_role === "editor")
  const showDelete = isOwner && !!onDelete
  const showMenu = showTags || !!onAddToCollection || showDelete
  const author = a.author ?? null
  const hasAuthor = !!(author?.name || author?.login || a.author_login || a.author_name)
  const updated = a.updated_at ?? a.created_at ?? a.versions[0]?.created_at
  // The list endpoint sends `versions: []`, so history reads off `current_version`
  // (the stable head ordinal). > 1 means "there is history here" → show the vN.
  const versionDepth = Math.max(a.current_version, a.versions.length)
  const tags = a.tags ?? []

  return (
    <Card
      className={cn(
        // Full-bleed preview: no mat, no inner padding — the caption owns its own.
        // A resting soft shadow (zeroed in dark by the theme token) gives the card
        // its lift; hover is the instant hairline-strengthen + preview wake, with no
        // transitioned shadow and no transform (either repaints the iframe).
        "group relative isolate flex flex-col gap-0 overflow-hidden p-0 shadow-(--shadow-sm)",
        // Needs-your-feedback items stand out: a tagged item gets the full accent +
        // ring; one you're just in the thread on gets a softer accent border (the
        // ink accent = "this matters", the sanctioned attention signal, like unread).
        a.mentions_me
          ? "border-primary ring-1 ring-primary/30"
          : a.i_participated
            ? "border-primary/60"
            : "border-border hover:border-foreground/25",
      )}
    >
      <div className="relative">
        <Thumb
          id={a.short_id}
          v={a.current_version}
          typeLabel={artifactTypeLabel(a)}
          version={versionDepth > 1 ? a.current_version : undefined}
          hasPreview={a.has_preview}
        />
        {/* Action cluster — one top-right corner above the stretched link (z-20).
            Revealed on hover/focus for fine pointers, ALWAYS shown on coarse (touch)
            pointers (no hover to reveal them). A favourited star also persists at
            rest. Adaptive translucent pills read over any render, both themes. */}
        <div className="absolute right-2 top-2 z-20 flex items-center gap-1.5">
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
              // A favourited star always shows; an unfavourited one reveals on
              // hover/focus so the resting wall of previews stays calm.
              !a.favorite && "opacity-0 group-hover:opacity-100",
            )}
          >
            {/* A favorited star keeps the brand ink — pinned/favorited is a
                sanctioned ink moment. */}
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
          {/* The title is the work, not the tool — Geist voice, sized to caption so
              the preview stays the hero. */}
          <span className="truncate font-serif text-base font-medium tracking-tight text-foreground">
            {a.title ?? a.short_id}
          </span>
          {/* For a synced file: its folder location (the path lives in source_path). */}
          {a.source_path && dirOf(a.source_path) && (
            <span
              className="truncate font-mono text-2xs text-muted-foreground"
              title={a.source_path}
            >
              {dirOf(a.source_path)}/
            </span>
          )}
        </button>

        {/* Meta row, two glanceable clusters: provenance (who · when) left, activity
            (feedback · views) right. The author is avatar-only — a repeated name on
            a wall of your own work is noise, but the tint still says "who" for
            shared/synced items (name in its tooltip). It's the one interactive
            island here (z-20); the rest clicks through to open. Mono throughout.
            mt-auto pins it (and any tags) to the card's bottom edge, so equal-height
            grid rows anchor their meta rather than float empty space below it. */}
        <div className="mt-auto flex min-w-0 items-center gap-2 font-mono text-2xs tabular-nums text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5">
            {hasAuthor && (
              <AuthorChip
                name={author?.name ?? a.author_name ?? null}
                login={author?.login ?? a.author_login ?? null}
                avatar={author?.avatar ?? a.author_avatar ?? null}
                handle={author?.handle ?? null}
                size="xs"
                showName={false}
                className="relative z-20 shrink-0"
                data-testid={`artifact-card-author-${a.short_id}`}
              />
            )}
            {updated && (
              <time
                dateTime={new Date(updated).toISOString()}
                title={new Date(updated).toLocaleString()}
                className="truncate"
              >
                {ago(updated)}
              </time>
            )}
          </span>
          <span className="ml-auto inline-flex shrink-0 items-center gap-2.5">
            {/* Private work is invisible to everyone but its members — the chip
                says so wherever the doc DOES surface (your library, Created by me). */}
            {a.visibility === "private" && (
              <Badge shape="pill" variant="outline" title="Only you and people you add">
                <Icon name="lock" size={12} /> Private
              </Badge>
            )}
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
          // can't grow the card taller than its siblings (steady grid rhythm). The
          // first three are interactive filter chips; a trailing "+N" counts the rest.
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
