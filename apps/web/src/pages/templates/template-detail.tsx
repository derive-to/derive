import { Icon } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { BUILT_IN_THEMES } from "./catalog"
import { TemplateArtwork, ThemeArtwork } from "./template-artwork"
import type { BuiltInTemplate, BuiltInTheme } from "./types"

function ThemePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <fieldset className="grid grid-cols-5 gap-1.5">
      <legend className="sr-only">Choose a theme</legend>
      {BUILT_IN_THEMES.map((theme) => (
        <button
          key={theme.id}
          type="button"
          data-testid={`template-theme-${theme.id}`}
          aria-label={theme.title}
          aria-pressed={value === theme.id}
          onClick={() => onChange(theme.id)}
          className={cn(
            "rounded-lg border bg-card p-1 outline-none hover:border-foreground/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            value === theme.id && "border-foreground/40 bg-secondary",
          )}
        >
          <ThemeArtwork theme={theme} className="aspect-square rounded-md p-1.5" />
        </button>
      ))}
    </fieldset>
  )
}

export function TemplateDetail({
  template,
  theme,
  onTheme,
  onUse,
}: {
  template: BuiltInTemplate
  theme?: BuiltInTheme
  onTheme: (id: string) => void
  onUse: () => void
}) {
  const usesTheme = template.themeMode !== "fixed"
  return (
    <aside className="flex flex-col gap-5 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto lg:pr-1">
      <TemplateArtwork template={template} theme={theme} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" shape="pill">
          {template.kind === "context" ? "Context" : template.category}
        </Badge>
        <Badge variant="outline" shape="pill">
          Built-in v1
        </Badge>
        {usesTheme && (
          <Badge variant="outline" shape="pill">
            Theme-ready
          </Badge>
        )}
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

      {usesTheme && theme && (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-foreground">Theme</p>
            <span className="text-xs text-muted-foreground">{theme.title}</span>
          </div>
          <ThemePicker value={theme.id} onChange={onTheme} />
        </div>
      )}

      <Button size="lg" onClick={onUse} data-testid="template-use">
        <Icon name={template.kind === "context" ? "context" : "plus"} />
        {template.kind === "context" ? "Create context manifest" : "Use this template"}
      </Button>
      <p className="-mt-2 text-xs text-pretty text-muted-foreground">
        {template.kind === "context"
          ? "Publish the safe manifest first, then bind a runner and sources. Credentials never travel with a template."
          : "Opens an independent draft. Editing or publishing it never changes the template."}
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

export function ThemeDetail({ theme, onUse }: { theme: BuiltInTheme; onUse: () => void }) {
  return (
    <aside className="flex flex-col gap-5 lg:sticky lg:top-6">
      <ThemeArtwork theme={theme} />
      <Badge variant="outline" shape="pill">
        Theme · built-in v1
      </Badge>
      <div className="flex flex-col gap-2">
        <h2 className="font-serif text-2xl font-medium leading-tight tracking-tight text-foreground">
          {theme.title}
        </h2>
        <p className="text-sm text-pretty text-muted-foreground">{theme.description}</p>
      </div>
      <div className="border-y py-3">
        <p className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
          Register
        </p>
        <p className="mt-1 text-sm font-medium text-foreground">{theme.tone}</p>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-foreground">Best for</p>
        <div className="flex flex-wrap gap-1.5">
          {theme.bestFor.map((item) => (
            <Badge key={item} variant="secondary">
              {item}
            </Badge>
          ))}
        </div>
      </div>
      <Button size="lg" onClick={onUse} data-testid="theme-use">
        <Icon name="templates" /> Use with a template
      </Button>
      <p className="-mt-2 text-xs text-pretty text-muted-foreground">
        Themes change the visual recipe, not the content structure. You can switch before
        publishing.
      </p>
    </aside>
  )
}
