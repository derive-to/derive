import { Link } from "@tanstack/react-router"
import type { Collection } from "@/api"
import { Icon } from "@/components/icons"
import { Thumb } from "@/components/shared/thumb"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"

// A shelf as a row, with the artifacts inside it running along the strip.
//
// The card version spent ~130px on a name and a count — the least interesting thing we
// know about a collection, at the largest possible size — while the artifacts, the one
// thing no competitor can show, weren't on screen at all. Here the strip IS the count:
// a busy shelf looks busy without reading a number, and you find one by recognising its
// contents rather than by reading labels.
export function CollectionRow({
  col,
  onStar,
}: {
  col: Collection
  onStar?: (next: boolean) => void
}) {
  const preview = col.preview ?? []
  const count = col.count ?? 0
  const hidden = Math.max(0, count - preview.length)
  const synced = col.kind === "repo" || col.kind === "pr"

  return (
    <div className="group relative flex items-center gap-3 border-b border-border-soft px-1 py-2.5 last:border-b-0 hover:bg-accent/40">
      <div className="min-w-0 basis-52 shrink-0">
        <Link
          to="/"
          search={{ collection: col.id }}
          data-testid={`collection-row-${col.id}`}
          // Stretched link: the whole row opens the shelf; the star sits above it.
          className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
        >
          <span className="flex items-center gap-1.5">
            {col.starred && <Icon name="star" size={12} weight="fill" className="text-primary" />}
            <span className="truncate text-sm font-medium tracking-tight">{col.title}</span>
          </span>
        </Link>
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
              <span className="text-success">synced</span>
            </>
          )}
        </div>
      </div>

      {/* An empty shelf says so. A row of nothing is the same mistake the blank card
          made, just wider. */}
      {preview.length === 0 ? (
        <span className="flex-1 font-mono text-2xs text-muted-foreground/70">
          Nothing filed here yet
        </span>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {preview.map((p) => (
            <Thumb
              key={p.short_id}
              id={p.short_id}
              v={p.current_version}
              hasPreview={p.has_preview}
              // Small, fixed, and clipped: the strip must not reflow as covers load, and
              // a shelf with twelve artifacts must not be twelve times as tall.
              className="w-16 shrink-0 rounded-sm"
            />
          ))}
          {hidden > 0 && (
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">+{hidden}</span>
          )}
        </div>
      )}

      {onStar && (
        <button
          type="button"
          data-testid={`collection-row-star-${col.id}`}
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
    </div>
  )
}
