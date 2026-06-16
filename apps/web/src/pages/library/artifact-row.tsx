import { Folder } from "lucide-react"
import type { Artifact } from "@/api"
import { Icon } from "@/components/icons"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"
import { artifactTypeLabel, dirOf } from "./artifact-card"

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
  onDelete,
  onPrefetch,
}: {
  artifact: Artifact
  onOpen: () => void
  onToggleFavorite: () => void
  onPickTag: (tag: string) => void
  onDelete?: () => void
  onPrefetch?: () => void
}) {
  const isOwner = a.my_role === "owner"
  const updated = a.updated_at ?? a.created_at ?? a.versions[0]?.created_at
  const dir = a.source_path ? dirOf(a.source_path) : ""
  const tags = a.tags ?? []

  return (
    <div className="group relative flex items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-2.5 transition-colors hover:border-primary hover:bg-hover">
      <button
        type="button"
        data-testid={`artifact-row-open-${a.short_id}`}
        onClick={onOpen}
        onMouseEnter={onPrefetch}
        onFocus={onPrefetch}
        aria-label={`Open ${a.title ?? a.short_id}`}
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left outline-none after:absolute after:inset-0 after:z-[1] after:rounded-lg after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
      >
        <span className="truncate font-display text-base font-semibold text-foreground transition-colors group-hover:text-primary">
          {a.title ?? a.short_id}
        </span>
        {updated && (
          <span className="font-mono text-2xs text-muted-foreground">updated {ago(updated)}</span>
        )}
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-2xs text-muted-foreground">
          <span className="rounded-[5px] border border-border-soft bg-secondary px-1.5 py-px text-foreground">
            {artifactTypeLabel(a)}
          </span>
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
        </span>
      </button>

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
              className="rounded-md border border-border bg-card px-1.5 py-px font-mono text-2xs text-primary transition hover:border-primary"
            >
              #{t}
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        data-testid={`artifact-row-favorite-${a.short_id}`}
        title={a.favorite ? "Remove from favorites" : "Add to favorites"}
        aria-label="Toggle favorite"
        aria-pressed={a.favorite}
        onClick={(e) => {
          e.stopPropagation()
          onToggleFavorite()
        }}
        className={cn(
          "relative z-20 grid size-7 shrink-0 place-items-center rounded-md border bg-card transition hover:border-primary",
          a.favorite ? "border-gold text-gold" : "border-border text-muted-foreground opacity-90",
        )}
      >
        <Icon name="star" size={14} className={cn(!a.favorite && "text-muted-foreground")} />
      </button>

      {isOwner && onDelete && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid={`artifact-row-more-${a.short_id}`}
              aria-label="More actions"
              onClick={(e) => e.stopPropagation()}
              className="relative z-20 grid size-7 shrink-0 place-items-center rounded-md border border-border bg-card text-muted-foreground opacity-0 transition hover:border-primary group-hover:opacity-100 focus:opacity-100"
            >
              <Icon name="more" size={14} />
            </button>
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
