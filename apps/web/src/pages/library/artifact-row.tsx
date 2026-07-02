import { Folder } from "lucide-react"
import type { Artifact } from "@/api"
import { AuthorChip } from "@/components/author-chip"
import { FollowButton } from "@/components/follow-button"
import { Icon } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"
import { artifactTypeLabel, dirOf } from "./artifact-card"
import { CommentSignal } from "./comment-signal"

/**
 * A compact list row for the library (the default for collections / synced repos,
 * where a flat thumbnail grid is noise for hundreds of docs). Reads top-to-bottom:
 * title, when it was last updated, then a meta line of type + folder location + tags.
 * Same stretched-link + independently-clickable-controls pattern as ArtifactCard.
 */
export function ArtifactRow({
  artifact: a,
  onOpen,
  onToggleFavorite,
  onPickTag,
  onPickAuthor,
  onDelete,
  onPrefetch,
}: {
  artifact: Artifact
  onOpen: () => void
  onToggleFavorite: () => void
  onPickTag: (tag: string) => void
  // Clicking the author filters the list by their GitHub login. Omit to render
  // the author as a non-filtering chip (still links to a known profile).
  onPickAuthor?: (login: string) => void
  onDelete?: () => void
  onPrefetch?: () => void
}) {
  const isOwner = a.my_role === "owner"
  const updated = a.updated_at ?? a.created_at ?? a.versions[0]?.created_at
  const dir = a.source_path ? dirOf(a.source_path) : ""
  const tags = a.tags ?? []
  // "Who last changed this": prefer the resolved author (carries the Derive handle),
  // fall back to the denormalized fields. Present only for synced artifacts.
  const author = a.author ?? null
  const authorLogin = author?.login ?? a.author_login ?? null
  const hasAuthor = !!(author?.name || authorLogin || a.author_name)

  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5 transition-colors hover:bg-hover",
        a.mentions_me
          ? "border-primary ring-1 ring-primary/30"
          : a.i_participated && "border-primary/60",
      )}
    >
      <button
        type="button"
        data-testid={`artifact-row-open-${a.short_id}`}
        onClick={onOpen}
        onMouseEnter={onPrefetch}
        onFocus={onPrefetch}
        aria-label={`Open ${a.title ?? a.short_id}`}
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left outline-none after:absolute after:inset-0 after:z-[1] after:rounded-lg after:content-[''] focus-visible:after:ring-[3px] focus-visible:after:ring-inset focus-visible:after:ring-ring/50"
      >
        <span className="truncate text-base font-semibold text-foreground">
          {a.title ?? a.short_id}
        </span>
        {updated && (
          <span className="font-mono text-2xs text-muted-foreground">updated {ago(updated)}</span>
        )}
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-2xs text-muted-foreground">
          <Badge variant="secondary">{artifactTypeLabel(a)}</Badge>
          {dir && (
            <span className="inline-flex items-center gap-1 truncate" title={a.source_path ?? ""}>
              <Folder className="size-3 shrink-0 text-primary" aria-hidden />
              {dir}/
            </span>
          )}
          {a.views !== undefined && a.views > 0 && (
            <span className="inline-flex items-center gap-1" title={`${a.views} viewers`}>
              <Icon name="views" size={12} />
              {a.views > 999 ? `${(a.views / 1000).toFixed(1)}k` : a.views}
            </span>
          )}
          <CommentSignal artifact={a} size={12} className="relative z-20" />
        </span>
      </button>

      {/* "Who last changed this" — above the stretched link so the click-to-filter
          button (and the profile link) stay independently clickable. */}
      {hasAuthor && (
        <div className="relative z-20 hidden shrink-0 items-center sm:flex">
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
          {author?.handle && <FollowButton username={author.handle} size="xs" className="ml-2" />}
        </div>
      )}

      {/* Tags sit above the stretched link so they stay independently clickable. */}
      {tags.length > 0 && (
        <div className="relative z-20 hidden max-w-[40%] flex-wrap justify-end gap-1.5 sm:flex">
          {tags.slice(0, 4).map((t) => (
            <button
              key={t}
              type="button"
              data-testid={`artifact-row-tag-${t}`}
              onClick={(e) => {
                e.stopPropagation()
                onPickTag(t)
              }}
              className="rounded-md border border-border bg-card px-1.5 py-px font-mono text-2xs text-primary hover:border-primary"
            >
              #{t}
            </button>
          ))}
        </div>
      )}

      <Button
        size="icon"
        variant="outline"
        data-testid={`artifact-row-favorite-${a.short_id}`}
        title={a.favorite ? "Remove from favorites" : "Add to favorites"}
        aria-label="Toggle favorite"
        aria-pressed={a.favorite}
        onClick={(e) => {
          e.stopPropagation()
          onToggleFavorite()
        }}
        className={cn("relative z-20", a.favorite ? "border-primary" : "opacity-90")}
      >
        <Icon name="star" size={14} className={cn(!a.favorite && "text-muted-foreground")} />
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
              data-testid={`artifact-row-more-${a.short_id}`}
              aria-label="More actions"
              onClick={(e) => e.stopPropagation()}
              className="relative z-20 opacity-0 group-hover:opacity-100 focus:opacity-100"
            >
              <Icon name="more" size={14} />
              <span
                aria-hidden
                className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem
              data-testid={`artifact-row-delete-${a.short_id}`}
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
  )
}

/** Most-recently-updated first; falls back to created/version time, then title. */
export const byRecency = (a: Artifact, b: Artifact): number => {
  const ta = a.updated_at ?? a.created_at ?? a.versions[0]?.created_at ?? ""
  const tb = b.updated_at ?? b.created_at ?? b.versions[0]?.created_at ?? ""
  if (ta !== tb) return tb.localeCompare(ta)
  return (a.title ?? a.short_id).localeCompare(b.title ?? b.short_id)
}
