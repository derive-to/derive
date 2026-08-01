import { Link } from "@tanstack/react-router"
import type { Collection } from "@/api"
import { Icon } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

// A shelf, as a card. The rail used to enumerate every collection; this is where they
// live instead — a view you switch to, not a permanent list you scroll past.
//
// What a shelf card states is chosen, not everything known: the name, how much is in it,
// whether it mirrors a repo, and whether you starred it. Member faces are deliberately
// absent — the collection header carries them, and a grid of avatars reads as social
// rather than as a place to work.
export function CollectionCard({
  col,
  onStar,
}: {
  col: Collection
  onStar?: (next: boolean) => void
}) {
  const count = col.count ?? 0
  const synced = col.kind === "repo" || col.kind === "pr"
  return (
    <Card className="group relative overflow-hidden transition-shadow hover:shadow-[var(--shadow)]">
      {/* The star sits above the stretched link so it stays independently clickable. */}
      {onStar && (
        <button
          type="button"
          data-testid={`collection-card-star-${col.id}`}
          aria-pressed={!!col.starred}
          aria-label={col.starred ? `Unstar ${col.title}` : `Star ${col.title}`}
          title={col.starred ? "Unstar — remove from your sidebar" : "Star — pin to your sidebar"}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onStar(!col.starred)
          }}
          className={cn(
            "absolute top-2 right-2 z-20 grid size-7 place-items-center rounded-lg outline-none",
            "hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
            // A star you set stays visible; an unset one reveals on hover, so a wall of
            // hollow stars doesn't compete with the names.
            col.starred
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
          )}
        >
          <Icon
            name="star"
            size={15}
            weight={col.starred ? "fill" : "regular"}
            className={col.starred ? "text-primary" : "text-muted-foreground"}
          />
        </button>
      )}

      <CardContent className="flex flex-col gap-2 p-3.5">
        <Link
          to="/"
          search={{ collection: col.id }}
          data-testid={`collection-card-${col.id}`}
          // Stretched link: the whole card opens the shelf, the star above stays its own
          // target (the same pattern as an artifact card).
          className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
        >
          <span className="flex items-center gap-1.5 pr-7">
            <Icon
              name={synced ? "collection" : "collections"}
              size={15}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate font-medium tracking-tight">{col.title}</span>
          </span>
        </Link>

        <div className="flex min-w-0 items-center gap-2 font-mono text-2xs tabular-nums text-muted-foreground">
          <span>
            {count} {count === 1 ? "document" : "documents"}
          </span>
          <span className="flex-1" />
          {/* Only the exceptional states get a chip: a mirror, and invite-only. A
              workspace-open manual collection is the norm and says nothing. */}
          {synced && (
            <Badge shape="pill" variant="outline" title={col.repo ?? "Mirrored from a repository"}>
              Synced
            </Badge>
          )}
          {col.workspace_access === "none" && (
            <Badge shape="pill" variant="outline" title="Only its members can open this">
              <Icon name="lock" size={11} /> Private
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
