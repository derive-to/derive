import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { TemplateArtwork, ThemeArtwork } from "./template-artwork"
import type { BuiltInTemplate, BuiltInTheme } from "./types"

export function TemplateCard({
  template,
  selected,
  featured = false,
  onSelect,
}: {
  template: BuiltInTemplate
  selected: boolean
  featured?: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      data-testid={`template-card-${template.id}`}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "group flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-3 text-left outline-none hover:border-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        selected && "border-foreground/35 bg-secondary",
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
  )
}

export function ThemeCard({
  theme,
  selected,
  onSelect,
}: {
  theme: BuiltInTheme
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      data-testid={`theme-card-${theme.id}`}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "group flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-3 text-left outline-none hover:border-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        selected && "border-foreground/35 bg-secondary",
      )}
    >
      <ThemeArtwork theme={theme} />
      <span className="flex flex-col gap-1 px-1 pb-1">
        <span className="font-serif text-lg font-medium tracking-tight text-foreground">
          {theme.title}
        </span>
        <span className="text-sm text-muted-foreground">{theme.tone}</span>
      </span>
    </button>
  )
}
