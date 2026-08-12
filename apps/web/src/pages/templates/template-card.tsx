import { Icon } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { TemplateArtwork } from "./template-artwork"
import type { BuiltInTemplate } from "./types"

export function TemplateCard({
  template,
  selected,
  featured = false,
  onSelect,
  onUse,
}: {
  template: BuiltInTemplate
  selected: boolean
  featured?: boolean
  onSelect: () => void
  onUse: () => void
}) {
  return (
    <article
      className={cn(
        "group min-w-0 overflow-hidden rounded-xl border bg-card hover:border-foreground/25",
        selected && "border-foreground/35 bg-secondary",
      )}
    >
      <button
        type="button"
        data-testid={`template-card-${template.id}`}
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          "flex w-full min-w-0 flex-col gap-3 p-3 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          featured && "sm:grid sm:grid-cols-[1.08fr_.92fr] sm:items-center sm:gap-4",
        )}
      >
        <TemplateArtwork template={template} className={cn("w-full", featured && "sm:order-2")} />
        <span className="flex min-w-0 flex-col gap-2 px-1 pb-1">
          <span className="flex items-center gap-2">
            <Badge variant="outline" shape="pill">
              {template.kind === "context" ? "Context" : template.category}
            </Badge>
            {template.featured && (
              <span className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
                Featured
              </span>
            )}
          </span>
          <span className="font-serif text-lg font-medium leading-tight tracking-tight text-foreground">
            {template.title}
          </span>
          <span className="line-clamp-2 text-sm text-pretty text-muted-foreground">
            {template.description}
          </span>
        </span>
      </button>
      <div className="border-t p-2 lg:hidden">
        <Button className="w-full" size="sm" onClick={onUse} data-testid="template-card-use">
          <Icon name="sparkles" /> {template.kind === "context" ? "Set up" : "Make it mine"}
        </Button>
      </div>
    </article>
  )
}
