import { Link } from "@tanstack/react-router"
import type { Collection } from "@/api"
import { Icon } from "@/components/icons"
import { Thumb } from "@/components/shared/thumb"
import { reveal } from "@/lib/interaction"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"

/** Covers per shelf. Four fills a normal library width at a legible size; a fifth
 *  would shrink them all to make room for one more. */
const STRIP = 4

// A shelf: its name, then the artifacts inside it at a size you can actually read.
//
// The covers were 64px wide in the first cut, which is not a preview of a web page —
// it's a smudge. They're 96px tall now, which is the smallest size at which a heading
// and a layout are recognisable, and that decides the block: title and metadata on top,
// the strip beneath them at full width, rather than a title column competing with the
// covers for the same horizontal space.
export function CollectionRow({
  col,
  onStar,
}: {
  col: Collection
  onStar?: (next: boolean) => void
}) {
  const preview = (col.preview ?? []).slice(0, STRIP)
  const count = col.count ?? 0
  const hidden = Math.max(0, count - preview.length)
  const synced = col.kind === "repo" || col.kind === "pr"

  return (
    <div className="group relative rounded-xl px-3 py-3 transition-colors hover:bg-accent/40">
      <div className="flex items-start gap-2">
        <Link
          to="/"
          search={{ collection: col.id }}
          data-testid={`collection-row-${col.id}`}
          // Stretched link: the whole shelf opens it; the star sits above at z-20.
          className="min-w-0 flex-1 after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
        >
          <div className="truncate text-sm font-semibold tracking-tight text-foreground">
            {col.title}
          </div>
          <div className="flex items-center gap-1.5 font-mono text-2xs text-muted-foreground">
            <span>
              {count} {count === 1 ? "artifact" : "artifacts"}
            </span>
            {col.last_activity && (
              <>
                <span aria-hidden>·</span>
                <span>{ago(col.last_activity)}</span>
              </>
            )}
            {synced && (
              <>
                <span aria-hidden>·</span>
                <span title={col.repo ?? "Mirrored from a repository"}>synced</span>
              </>
            )}
            {col.workspace_access === "none" && (
              <>
                <span aria-hidden>·</span>
                <span
                  className="inline-flex items-center gap-1"
                  title="Only its members can open this"
                >
                  <Icon name="lock" size={10} /> private
                </span>
              </>
            )}
          </div>
        </Link>

        {/* One star, and it is the control — not a state read-out beside the title and a
            button over here doing the same job. Filled means starred. */}
        {onStar && (
          <button
            type="button"
            data-testid={`collection-star-${col.id}`}
            aria-pressed={!!col.starred}
            aria-label={col.starred ? `Unstar ${col.title}` : `Star ${col.title}`}
            title={col.starred ? "Unstar — remove from your sidebar" : "Star — pin to your sidebar"}
            onClick={(e) => {
              e.preventDefault()
              onStar(!col.starred)
            }}
            className={cn(
              "relative z-20 grid size-7 shrink-0 place-items-center rounded-lg outline-none",
              "hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              reveal(!!col.starred),
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
      </div>

      {/* An empty shelf says so in words. A row of nothing is the same mistake the blank
          card made, just wider. */}
      {preview.length === 0 ? (
        <p className="mt-2 font-mono text-2xs text-muted-foreground/70">Nothing filed here yet</p>
      ) : (
        <div className="mt-2.5 flex items-end gap-2 overflow-hidden">
          {preview.map((p) => (
            <Thumb
              key={p.short_id}
              id={p.short_id}
              v={p.current_version}
              hasPreview={p.has_preview}
              // Height fixed, width derived: every shelf is exactly as tall as every
              // other one, so the list doesn't ripple as covers load.
              className="h-24 w-auto shrink-0 rounded-md"
            />
          ))}
          {hidden > 0 && (
            <span className="shrink-0 pb-1 font-mono text-2xs text-muted-foreground">
              +{hidden}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
