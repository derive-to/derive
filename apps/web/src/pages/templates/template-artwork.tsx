import { cn } from "@/lib/utils"
import type { BuiltInTemplate } from "./types"

const SURFACE_BY_CATEGORY: Record<string, string> = {
  Deck: "bg-card text-card-foreground",
  Doc: "bg-muted text-foreground",
  Report: "bg-foreground text-background",
  Site: "bg-secondary text-secondary-foreground",
  Agent: "bg-primary text-primary-foreground",
}

function Line({ className, strong = false }: { className: string; strong?: boolean }) {
  return (
    <span
      className={cn(
        "block h-1 rounded-full bg-current",
        strong ? "opacity-80" : "opacity-25",
        className,
      )}
    />
  )
}

/** A compact abstract preview: enough category signal without pretending to render source. */
export function TemplateArtwork({
  template,
  className,
}: {
  template: BuiltInTemplate
  className?: string
}) {
  const isAgent = template.category === "Agent"
  const label = isAgent
    ? template.kind === "context"
      ? "CONTEXT"
      : "AGENT"
    : template.category.toUpperCase()
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative aspect-[16/10] overflow-hidden rounded-lg border border-current/15 p-4",
        SURFACE_BY_CATEGORY[template.category] ?? SURFACE_BY_CATEGORY.Doc,
        className,
      )}
    >
      <div className="flex items-center justify-between font-mono text-2xs tracking-widest opacity-55">
        <span>DERIVE / {label}</span>
        <span className="tabular-nums">
          {template.sections.length} {isAgent ? "steps" : "sections"}
        </span>
      </div>
      <div className="grid h-[calc(100%-1rem)] grid-cols-[1fr_4.5rem] items-center gap-3">
        <div>
          <Line className="w-4/5" strong />
          <div className="mt-2 grid gap-1.5">
            <Line className="w-full" />
            <Line className="w-2/3" />
          </div>
        </div>
        <div className="self-end pb-3">
          <div className="mb-2 size-5 border border-current opacity-40" />
          <Line className="w-full" />
        </div>
      </div>
      <div className="absolute inset-x-4 bottom-4 border-t border-current opacity-25" />
    </div>
  )
}
