import type { Artifact } from "@/api"
import { AuthorChip } from "@/components/author-chip"
import { Icon } from "@/components/icons"
import { Thumb } from "@/components/shared/thumb"
import { TypeTag } from "@/components/shared/type-tag"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { IconButton } from "@/components/ui/icon-button"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"
import { CommentSignal } from "./comment-signal"

export const dirOf = (path: string): string => {
  const i = path.lastIndexOf("/")
  return i < 0 ? "" : path.slice(0, i)
}

export function artifactTypeLabel(a: Artifact): string {
  // A skill rides the denormalized content type (derive/skill), so the grid badges it
  // without opening the bundle — string mirrored from @derive/core SKILL_CONTENT_TYPE.
  if (a.current_content_type === "derive/skill") return "Skill"
  if (a.kind === "bundle") return "Site"
  const ct = a.current_content_type
  if (ct === "text/x-derive-deck") return "Deck"
  if (ct === "text/markdown") return "MD"
  if (ct?.startsWith("text/html")) return "HTML"
  return "Doc"
}

// One card in the library grid: a full-bleed preview up top, then a padded
// content block. Stretched-link pattern — the open button's ::after covers the
// whole card so a click anywhere (preview included) opens it, while the star /
// more / tag chips sit above (z-20) and stay independently clickable. The card
// lifts + shadows on hover as one piece.
export function ArtifactCard({
  artifact: a,
  onOpen,
  onToggleFavorite,
  onPickTag,
  onDelete,
  onPrefetch,
}: {
  artifact: Artifact
  onOpen: () => void
  onToggleFavorite: () => void
  onPickTag: (tag: string) => void
  onDelete?: () => void
  // Warm the artifact (metadata + comments + rendered HTML) when the card is
  // hovered or focused, so the click that follows opens instantly.
  onPrefetch?: () => void
}) {
  const isOwner = a.my_role === "owner"
  // "Who last changed this" — only synced artifacts carry an author.
  const author = a.author ?? null
  const hasAuthor = !!(author?.name || author?.login || a.author_login || a.author_name)

  return (
    <div
      className={cn(
        // No hover transform: the preview is an iframe, and translating its
        // container makes the browser repaint it (a visible flash). The shadow
        // deepening carries the hover instead.
        "group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-sm)] transition-shadow duration-150 hover:shadow-[var(--shadow)]",
        // Needs-your-feedback items stand out in the grid: a tagged item gets the full
        // accent + ring; one you're just in the thread on gets a softer accent border.
        a.mentions_me
          ? "border-primary ring-1 ring-primary/30"
          : a.i_participated && "border-primary/60",
      )}
    >
      <div className="relative">
        <Thumb id={a.short_id} v={a.current_version} />
        <IconButton
          variant="chip"
          data-testid={`artifact-card-favorite-${a.short_id}`}
          title={a.favorite ? "Remove from favorites" : "Add to favorites"}
          aria-label="Toggle favorite"
          aria-pressed={a.favorite}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite()
          }}
          className={cn(
            "absolute right-2.5 top-2.5 z-20 transition-opacity",
            // Declutter the resting card: a favourited star always shows; an
            // unfavourited one reveals on hover/focus, like the more-actions chip.
            !a.favorite && "opacity-0 group-hover:opacity-100 focus:opacity-100",
          )}
        >
          <Icon
            name="star"
            size={14}
            weight={a.favorite ? "fill" : "regular"}
            className={a.favorite ? "text-foreground" : "text-muted-foreground"}
          />
        </IconButton>
        {isOwner && onDelete && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                variant="chip"
                data-testid={`artifact-card-more-${a.short_id}`}
                aria-label="More actions"
                onClick={(e) => e.stopPropagation()}
                className="absolute left-2.5 top-2.5 z-20 opacity-0 group-hover:opacity-100 focus:opacity-100"
              >
                <Icon name="more" size={14} />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem
                data-testid={`artifact-card-delete-${a.short_id}`}
                className="text-destructive focus:text-destructive"
                onSelect={() => onDelete()}
              >
                <Icon name="delete" size={16} />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2 border-t border-border-soft p-3.5">
        <button
          type="button"
          data-testid={`artifact-card-open-${a.short_id}`}
          onClick={onOpen}
          onMouseEnter={onPrefetch}
          onFocus={onPrefetch}
          aria-label={`Open ${a.title ?? a.short_id}`}
          className="flex w-full min-w-0 flex-col gap-1.5 text-left outline-none after:absolute after:inset-0 after:z-[1] after:rounded-lg after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
        >
          <span className="truncate font-display text-lg font-medium tracking-tight text-foreground">
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
          <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <TypeTag>{artifactTypeLabel(a)}</TypeTag>
            {(a.updated_at ?? a.created_at ?? a.versions[0]?.created_at) && (
              <span>
                updated {ago(a.updated_at ?? a.created_at ?? a.versions[0]?.created_at ?? "")}
              </span>
            )}
            <span className="ml-auto inline-flex items-center gap-2">
              <CommentSignal artifact={a} />
              {a.views !== undefined && a.views > 0 && (
                <span className="inline-flex items-center gap-1" title={`${a.views} viewers`}>
                  <Icon name="views" size={13} />{" "}
                  {a.views > 999 ? `${(a.views / 1000).toFixed(1)}k` : a.views}
                  <span className="sr-only"> views</span>
                </span>
              )}
            </span>
          </span>
        </button>
        {hasAuthor && (
          <div className="relative z-20 flex min-w-0">
            <AuthorChip
              name={author?.name ?? a.author_name ?? null}
              login={author?.login ?? a.author_login ?? null}
              avatar={author?.avatar ?? a.author_avatar ?? null}
              handle={author?.handle ?? null}
              data-testid={`artifact-card-author-${a.short_id}`}
            />
          </div>
        )}
        {(a.tags ?? []).length > 0 && (
          <div className="relative z-20 flex flex-wrap gap-1.5">
            {(a.tags ?? []).slice(0, 6).map((t) => (
              <button
                key={t}
                type="button"
                data-testid={`artifact-card-tag-${t}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onPickTag(t)
                }}
                className="rounded-md border border-border bg-card px-1.5 py-px font-mono text-2xs text-primary transition hover:border-primary"
              >
                #{t}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
