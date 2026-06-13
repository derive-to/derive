import { Star } from "lucide-react"
import type { Artifact } from "@/api"
import { Thumb } from "@/components/shared/thumb"
import { cn } from "@/lib/utils"

// One card in the library grid. Stretched-link pattern: the open button's
// ::after covers the whole card so a click anywhere (thumbnail included) opens
// it, while the star + tag chips sit above (z-20) and stay independently
// clickable. `group` lets the thumb + title pick up the accent on hover.
export function ArtifactCard({
  artifact: a,
  onOpen,
  onToggleFavorite,
  onPickTag,
}: {
  artifact: Artifact
  onOpen: () => void
  onToggleFavorite: () => void
  onPickTag: (tag: string) => void
}) {
  return (
    <div className="group relative flex cursor-pointer flex-col gap-2 rounded-lg border border-border bg-card p-3.5 transition-all hover:-translate-y-0.5 hover:border-primary hover:shadow-[var(--shadow)] active:translate-y-0">
      <div className="relative">
        <Thumb id={a.short_id} v={a.current_version} />
        <button
          type="button"
          title={a.favorite ? "Remove from favorites" : "Add to favorites"}
          aria-label="Toggle favorite"
          aria-pressed={a.favorite}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite()
          }}
          className={cn(
            "absolute right-2.5 top-2.5 z-20 grid size-7 place-items-center rounded-md border bg-card transition hover:border-primary",
            a.favorite ? "border-gold text-gold" : "border-border text-muted-foreground opacity-90",
          )}
        >
          <Star className={cn("size-3.5", a.favorite && "fill-current")} />
        </button>
      </div>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${a.title ?? a.short_id}`}
        className="flex w-full flex-col gap-1.5 text-left outline-none after:absolute after:inset-0 after:z-[1] after:rounded-lg after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
      >
        <span className="font-display text-lg font-semibold text-foreground transition-colors group-hover:text-primary">
          {a.title ?? a.short_id}
        </span>
        <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <span className="rounded-[5px] border border-border-soft bg-secondary px-1.5 py-px">
            {a.kind}
          </span>
          <span>v{a.current_version}</span>
          {a.views !== undefined && a.views > 0 && (
            <span className="ml-auto" title={`${a.views} viewers`}>
              👁 {a.views > 999 ? `${(a.views / 1000).toFixed(1)}k` : a.views}
            </span>
          )}
        </span>
      </button>
      {(a.tags ?? []).length > 0 && (
        <div className="relative z-20 flex flex-wrap gap-1.5">
          {(a.tags ?? []).slice(0, 6).map((t) => (
            <button
              key={t}
              type="button"
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
  )
}
