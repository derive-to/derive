import { cn } from "@/lib/utils"
import type { BuiltInTemplate, BuiltInTheme, ThemeMotif } from "./types"

const MOTIF_SURFACE: Record<ThemeMotif, string> = {
  editorial: "bg-card text-card-foreground",
  operator: "bg-foreground text-background",
  field: "bg-secondary text-secondary-foreground",
  institutional: "bg-muted text-foreground",
  signal: "bg-primary text-primary-foreground",
}

function Line({ width, strong = false }: { width: string; strong?: boolean }) {
  return (
    <span
      className={cn(
        "block h-1 rounded-full",
        strong ? "bg-current opacity-80" : "bg-current opacity-25",
        width,
      )}
    />
  )
}

function DeckArtwork({ template }: { template: BuiltInTemplate }) {
  return (
    <div className="grid h-full grid-cols-[1fr_4.5rem] grid-rows-[auto_1fr_auto] gap-3 p-4">
      <span className="font-mono text-2xs tracking-widest opacity-55">DERIVE / 01</span>
      <span className="text-right font-mono text-2xs tabular-nums opacity-55">
        {template.sections.length} slides
      </span>
      <div className="self-center">
        <Line width="w-4/5" strong />
        <div className="mt-2 flex flex-col gap-1.5">
          <Line width="w-full" />
          <Line width="w-2/3" />
        </div>
      </div>
      <div className="self-end">
        <div className="mb-2 size-5 border border-current opacity-40" />
        <Line width="w-full" />
      </div>
      <div className="col-span-2 border-t border-current opacity-25" />
    </div>
  )
}

function DocumentArtwork({ template }: { template: BuiltInTemplate }) {
  return (
    <div className="flex h-full justify-center p-4">
      <div className="flex w-3/4 flex-col border border-current bg-card p-3 text-card-foreground shadow-[var(--shadow-sm)]">
        <span className="font-mono text-2xs uppercase tracking-widest opacity-50">
          {template.category}
        </span>
        <div className="mt-3 flex flex-col gap-1.5">
          <Line width="w-4/5" strong />
          <Line width="w-1/2" />
        </div>
        <div className="mt-auto grid grid-cols-[2.2rem_1fr] gap-2 border-t border-current pt-2 opacity-60">
          <span className="font-mono text-2xs">01</span>
          <div className="flex flex-col gap-1.5">
            <Line width="w-full" />
            <Line width="w-3/4" />
          </div>
        </div>
      </div>
    </div>
  )
}

function ReportArtwork() {
  return (
    <div className="grid h-full grid-cols-[4rem_1fr] gap-3 p-4">
      <div className="flex flex-col justify-between border-r border-current pr-3 opacity-45">
        <span className="font-mono text-2xs">NOW</span>
        <span className="font-mono text-2xs">NEXT</span>
      </div>
      <div className="grid grid-rows-[auto_1fr] gap-4">
        <div className="flex items-start justify-between">
          <Line width="w-1/2" strong />
          <span className="size-2 rounded-full bg-current opacity-75" />
        </div>
        <div className="grid grid-cols-3 items-end gap-2 border-b border-current pb-2 opacity-55">
          <span className="h-1/3 bg-current" />
          <span className="h-3/4 bg-current" />
          <span className="h-1/2 bg-current" />
        </div>
      </div>
    </div>
  )
}

function SiteArtwork() {
  return (
    <div className="flex h-full flex-col p-4">
      <div className="flex items-center justify-between border-b border-current pb-2 opacity-55">
        <span className="font-mono text-2xs tracking-widest">PROJECT / HUB</span>
        <span className="flex gap-1">
          <i className="size-1 rounded-full bg-current" />
          <i className="size-1 rounded-full bg-current" />
          <i className="size-1 rounded-full bg-current" />
        </span>
      </div>
      <div className="grid flex-1 grid-cols-[1.25fr_.75fr] gap-3 pt-4">
        <div className="flex flex-col justify-center gap-2">
          <Line width="w-full" strong />
          <Line width="w-2/3" strong />
          <Line width="w-1/2" />
        </div>
        <div className="grid grid-cols-2 gap-1.5 opacity-35">
          <span className="border border-current" />
          <span className="border border-current" />
          <span className="col-span-2 border border-current" />
        </div>
      </div>
    </div>
  )
}

function AgentArtwork({ context }: { context: boolean }) {
  return (
    <div className="grid h-full place-items-center p-4">
      <div className="relative grid w-full grid-cols-[1fr_2.5rem_1fr] items-center">
        <div className="border border-current p-2">
          <span className="block font-mono text-2xs opacity-55">
            {context ? "MANIFEST" : "SOURCE"}
          </span>
          <Line width="mt-2 w-3/4" strong />
        </div>
        <span className="h-px bg-current opacity-40" />
        <div className="border border-current bg-current p-2 text-background">
          <span className="block font-mono text-2xs opacity-75">
            {context ? "CONTEXT" : "OUTPUT"}
          </span>
          <Line width="mt-2 w-full" strong />
        </div>
      </div>
    </div>
  )
}

export function TemplateArtwork({
  template,
  theme,
  className,
}: {
  template: BuiltInTemplate
  theme?: BuiltInTheme
  className?: string
}) {
  const motif = theme?.motif ?? (template.category === "Deck" ? "editorial" : "institutional")
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative aspect-[16/10] overflow-hidden rounded-lg border border-current/15",
        MOTIF_SURFACE[motif],
        className,
      )}
    >
      {template.category === "Deck" ? (
        <DeckArtwork template={template} />
      ) : template.category === "Doc" ? (
        <DocumentArtwork template={template} />
      ) : template.category === "Report" ? (
        <ReportArtwork />
      ) : template.category === "Site" ? (
        <SiteArtwork />
      ) : (
        <AgentArtwork context={template.kind === "context"} />
      )}
    </div>
  )
}

export function ThemeArtwork({ theme, className }: { theme: BuiltInTheme; className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative aspect-[16/10] overflow-hidden rounded-lg border border-current/15 p-4",
        MOTIF_SURFACE[theme.motif],
        className,
      )}
    >
      <div className="flex items-center justify-between font-mono text-2xs tracking-widest opacity-55">
        <span>THEME</span>
        <span>Aa</span>
      </div>
      {theme.motif === "operator" ? (
        <div className="mt-6 grid grid-cols-4 items-end gap-2 border-b border-current pb-2 opacity-65">
          <span className="h-6 bg-current" />
          <span className="h-14 bg-current" />
          <span className="h-9 bg-current" />
          <span className="h-12 bg-current" />
        </div>
      ) : theme.motif === "signal" ? (
        <div className="mt-5 max-w-36 text-3xl font-black leading-none tracking-tighter">
          ONE CLEAR IDEA.
        </div>
      ) : theme.motif === "field" ? (
        <div className="mt-5 rotate-[-1deg] border border-current bg-card p-3 text-card-foreground shadow-[var(--shadow-sm)]">
          <Line width="w-4/5" strong />
          <Line width="mt-2 w-full" />
          <Line width="mt-1.5 w-2/3" />
        </div>
      ) : (
        <div className="mt-7 grid grid-cols-[1fr_3rem] gap-3">
          <div>
            <Line width="w-full" strong />
            <Line width="mt-2 w-2/3" />
          </div>
          <div className="border border-current" />
        </div>
      )}
      <div className="absolute right-4 bottom-4 left-4 border-t border-current opacity-30" />
    </div>
  )
}
