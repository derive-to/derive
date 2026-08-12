import { Icon } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TemplateArtwork } from "./template-artwork"
import type { BuiltInTemplate } from "./types"

export function TemplateDetail({
  template,
  onUse,
}: {
  template: BuiltInTemplate
  onUse: () => void
}) {
  return (
    <aside className="flex flex-col gap-5 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto lg:pr-1">
      <TemplateArtwork template={template} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" shape="pill">
          {template.kind === "context" ? "Context" : template.category}
        </Badge>
        <Badge variant="outline" shape="pill">
          Built-in v1
        </Badge>
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="font-serif text-2xl font-medium leading-tight tracking-tight text-foreground">
          {template.title}
        </h2>
        <p className="text-sm text-pretty text-muted-foreground">{template.description}</p>
      </div>
      <div className="border-y py-3">
        <p className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">Outcome</p>
        <p className="mt-1 text-sm font-medium text-pretty text-foreground">{template.outcome}</p>
      </div>

      <Button size="lg" onClick={onUse} data-testid="template-use">
        <Icon name="sparkles" />
        {template.kind === "context" ? "Set up with Derive" : "Make it mine"}
      </Button>
      <p className="-mt-2 text-xs text-pretty text-muted-foreground">
        {template.kind === "context"
          ? "Derive adapts the safe manifest to your job, then helps connect local sources and authority."
          : "Brief Derive in your own words. It will adapt this shape, build the draft, and show you the result."}
      </p>

      <div className="flex flex-col gap-3 border-t pt-4">
        <h3 className="text-sm font-medium text-foreground">Working inputs</h3>
        <ul className="flex flex-col gap-2">
          {template.inputs.map((item) => (
            <li key={item.name} className="grid grid-cols-[auto_1fr] gap-2 text-sm">
              <span className="mt-1.5 size-1.5 rounded-full bg-muted-foreground/55" />
              <span>
                <b className="font-medium text-foreground">{item.name}</b>
                {item.required && <span className="text-muted-foreground"> · required</span>}
                <span className="block text-muted-foreground">{item.description}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-3 border-t pt-4">
        <h3 className="text-sm font-medium text-foreground">Shape</h3>
        <ol className="grid grid-cols-2 gap-x-3 gap-y-2">
          {template.sections.map((section, index) => (
            <li key={section} className="flex gap-2 text-xs text-muted-foreground">
              <span className="font-mono text-2xs tabular-nums">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span>{section}</span>
            </li>
          ))}
        </ol>
      </div>

      {template.starterPrompts && (
        <div className="flex flex-col gap-3 border-t pt-4">
          <h3 className="text-sm font-medium text-foreground">Starter prompts</h3>
          <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
            {template.starterPrompts.map((prompt) => (
              <li key={prompt}>“{prompt}”</li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  )
}
