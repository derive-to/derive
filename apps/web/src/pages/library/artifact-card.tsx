import type { Artifact } from "@/api"
import { AuthorChip } from "@/components/author-chip"
import { Icon } from "@/components/icons"
import { Thumb } from "@/components/shared/thumb"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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

// One card in the library grid: the render mounted in an inset frame (a slim mat
// on the Card chassis — concentric radii: rounded-lg frame inside the rounded-xl
// card), then a caption. Artifacts with version history grow a stacked deck of
// under-edges below the frame ("there is history here").
//
// Stretched-link pattern — the open button's ::after covers the whole card so a
// click anywhere (preview included) opens it, while the star / more / author /
// tag chips sit above (z-20) and stay independently clickable. Hover is an
// instant edge brighten + preview wake (never a shadow — dark has none, and a
// lifting iframe would repaint).
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
  const updated = a.updated_at ?? a.created_at ?? a.versions[0]?.created_at
  // The list endpoint sends `versions: []` (revision detail is a detail-page
  // concern), so version history reads off `current_version` — the stable head
  // ordinal, bumped on every publish. > 1 means "there is history here".
  const versionDepth = Math.max(a.current_version, a.versions.length)

  return (
    <Card
      className={cn(
        // No hover transform: the preview is an iframe, and translating its
        // container makes the browser repaint it (a visible flash). A neutral
        // edge brighten carries the hover instead. p-1 is the mat: 12px card
        // radius − 4px padding = 8px frame radius (rounded-lg on the Thumb —
        // --radius-xl − --spacing(1) = --radius-lg, so the named steps encode
        // the concentric math). gap-3 is the frame→caption rhythm; the version
        // deck hangs 6px of it, leaving 6px of air before the title.
        "group relative isolate gap-3 p-1",
        // Needs-your-feedback items stand out in the grid: a tagged item gets the full
        // accent + ring; one you're just in the thread on gets a softer accent border
        // (amber = "this matters" — the sanctioned attention signal, like unread).
        a.mentions_me
          ? "border-primary ring-1 ring-primary/30"
          : a.i_participated
            ? "border-primary/60"
            : "border-border hover:border-foreground/25",
      )}
    >
      <div className="relative">
        {/* Format + version-depth placards ride on the render (scrim-backed, always
            visible), and version history stacks a deck of under-edges below the
            frame — see Thumb. Recognition cues live where the eye already is. */}
        <Thumb
          id={a.short_id}
          v={a.current_version}
          typeLabel={artifactTypeLabel(a)}
          version={versionDepth > 1 ? a.current_version : undefined}
          versionCount={versionDepth}
          className="rounded-lg"
        />
        <Button
          size="icon"
          variant="outline"
          data-testid={`artifact-card-favorite-${a.short_id}`}
          title={a.favorite ? "Remove from favorites" : "Add to favorites"}
          aria-label="Toggle favorite"
          aria-pressed={a.favorite}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite()
          }}
          className={cn(
            "absolute right-2 top-2 z-20 transition-opacity",
            // Declutter the resting card: a favourited star always shows; an
            // unfavourited one reveals on hover/focus, like the more-actions chip.
            !a.favorite && "opacity-0 group-hover:opacity-100 focus:opacity-100",
          )}
        >
          {/* A favorited star keeps the brand tint — pinned/favorited is a
              sanctioned amber moment. */}
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
        {isOwner && onDelete && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="outline"
                data-testid={`artifact-card-more-${a.short_id}`}
                aria-label="More actions"
                onClick={(e) => e.stopPropagation()}
                className="absolute left-2 top-2 z-20 opacity-0 group-hover:opacity-100 focus:opacity-100"
              >
                <Icon name="more" size={16} />
                <span
                  aria-hidden
                  className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem
                data-testid={`artifact-card-delete-${a.short_id}`}
                variant="destructive"
                onSelect={() => onDelete()}
              >
                <Icon name="delete" size={16} />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <CardContent className="flex min-w-0 flex-col gap-2 p-2 pt-0">
        <button
          type="button"
          data-testid={`artifact-card-open-${a.short_id}`}
          onClick={onOpen}
          onMouseEnter={onPrefetch}
          onFocus={onPrefetch}
          aria-label={`Open ${a.title ?? a.short_id}`}
          className="flex w-full min-w-0 flex-col gap-1 text-left outline-none after:absolute after:inset-0 after:z-[1] after:rounded-xl after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
        >
          {/* The title is the work, not the tool — serif voice (large enough here). */}
          <span className="truncate font-serif text-lg font-medium tracking-tight text-foreground">
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
        {/* Poster/time meta row: who last changed this · when, with trailing signals.
            Machine register (mono) for the time; the author chip is the one
            interactive island (z-20), the rest of the row clicks through to open. */}
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-2xs tabular-nums text-muted-foreground">
          {hasAuthor && (
            <>
              <AuthorChip
                name={author?.name ?? a.author_name ?? null}
                login={author?.login ?? a.author_login ?? null}
                avatar={author?.avatar ?? a.author_avatar ?? null}
                handle={author?.handle ?? null}
                size="xs"
                className="relative z-20"
                data-testid={`artifact-card-author-${a.short_id}`}
              />
              <span aria-hidden className="shrink-0 text-muted-foreground/50">
                ·
              </span>
            </>
          )}
          {updated && (
            <time
              dateTime={new Date(updated).toISOString()}
              title={new Date(updated).toLocaleString()}
              className="shrink-0"
            >
              {ago(updated)}
            </time>
          )}
          <span className="ml-auto inline-flex shrink-0 items-center gap-2 pl-1">
            <CommentSignal artifact={a} size={12} />
            {a.views !== undefined && a.views > 0 && (
              <span className="inline-flex items-center gap-1" title={`${a.views} viewers`}>
                <Icon name="views" size={12} />
                {a.views > 999 ? `${(a.views / 1000).toFixed(1)}k` : a.views}
                <span className="sr-only"> views</span>
              </span>
            )}
          </span>
        </div>
        {(a.tags ?? []).length > 0 && (
          <div className="relative z-20 flex flex-wrap gap-1.5">
            {/* Tag chips are Badges rendered as buttons (asChild) — the chip
                metrics and focus grammar come from the primitive; only the
                machine register + hover brighten are local. */}
            {(a.tags ?? []).slice(0, 6).map((t) => (
              <Badge
                key={t}
                asChild
                variant="outline"
                className="px-1.5 font-mono text-2xs hover:border-foreground/25 hover:text-foreground"
              >
                <button
                  type="button"
                  data-testid={`artifact-card-tag-${t}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onPickTag(t)
                  }}
                >
                  #{t}
                </button>
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
