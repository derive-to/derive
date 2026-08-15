import { cn } from "@/lib/utils"
import type { BuiltInTemplate } from "./types"

const SURFACE_BY_CATEGORY: Record<string, string> = {
  Deck: "bg-brand text-brand-foreground",
  Doc: "bg-info text-info-foreground",
  Site: "bg-success text-success-foreground",
  Report: "bg-warning text-warning-foreground",
  Agent: "bg-primary text-primary-foreground",
}

/** A source-free structural preview using each Template's real section contract. */
export function TemplateArtwork({
  template,
  className,
}: {
  template: BuiltInTemplate
  className?: string
}) {
  const category = template.category
  const sections = template.sections.slice(0, 4)

  return (
    <div
      aria-hidden="true"
      className={cn(
        "h-36 overflow-hidden rounded-lg p-4",
        SURFACE_BY_CATEGORY[category],
        className,
      )}
    >
      <div className="flex items-center justify-between font-mono text-2xs tracking-widest opacity-55">
        <span>DERIVE / {category}</span>
        <span>{template.format}</span>
      </div>

      <div className="grid h-[calc(100%-1rem)] grid-cols-[1fr_1.15fr] items-center gap-3 pt-3">
        <div className="min-w-0 pb-2">
          <p className="line-clamp-3 font-serif text-lg font-medium leading-[1.05] tracking-tight">
            {sections[0]}
          </p>
        </div>
        <div className="grid gap-1.5 pb-2">
          {sections.slice(1).map((section) => (
            <div
              key={section}
              className="line-clamp-2 min-w-0 border-t border-current/25 pt-1.5 text-2xs font-medium"
            >
              {section}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
