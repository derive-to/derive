import { cn } from "@/lib/utils"
import type { BuiltInTemplate } from "./types"

const SURFACE_BY_CATEGORY: Record<string, string> = {
  Deck: "bg-card text-card-foreground",
  Doc: "bg-muted text-foreground",
  Report: "bg-foreground text-background",
  Site: "bg-secondary text-secondary-foreground",
  Agent: "bg-primary text-primary-foreground",
}

const sectionLabel = (template: BuiltInTemplate, index: number) =>
  template.sections[index] ?? template.outcome

function PreviewHeader({ template }: { template: BuiltInTemplate }) {
  return (
    <div className="flex items-center justify-between font-mono text-2xs tracking-widest opacity-55">
      <span>
        DERIVE / {template.kind === "context" ? "CONTEXT" : template.category.toUpperCase()}
      </span>
      <span>{template.format.toUpperCase()}</span>
    </div>
  )
}

function DeckPreview({ template }: { template: BuiltInTemplate }) {
  return (
    <div className="grid h-[calc(100%-1rem)] grid-cols-[1fr_5.5rem] items-end gap-4 pt-4">
      <div className="pb-2">
        <p className="line-clamp-2 font-serif text-lg font-medium leading-[1.05] tracking-tight">
          {sectionLabel(template, 0)}
        </p>
        <div className="mt-3 h-px w-full bg-current opacity-20" />
        <p className="mt-2 line-clamp-2 text-2xs leading-relaxed opacity-55">{template.outcome}</p>
      </div>
      <div className="grid gap-1.5 pb-2 font-mono text-2xs uppercase tracking-wide opacity-65">
        {template.sections.slice(1, 4).map((section, index) => (
          <div key={section} className="border-t border-current/25 pt-1.5">
            {String(index + 2).padStart(2, "0")} {section}
          </div>
        ))}
      </div>
    </div>
  )
}

function DocPreview({ template }: { template: BuiltInTemplate }) {
  return (
    <div className="grid h-[calc(100%-1rem)] grid-cols-[1fr_1.15fr] items-center gap-4 pt-3">
      <div>
        <div className="mb-2 size-5 border border-current opacity-35" />
        <p className="line-clamp-3 font-serif text-lg font-medium leading-[1.05] tracking-tight">
          {sectionLabel(template, 0)}
        </p>
      </div>
      <div className="grid gap-2">
        {template.sections.slice(1, 4).map((section, index) => (
          <div
            key={section}
            className="grid grid-cols-[1rem_1fr] gap-1.5 border-t border-current/20 pt-1.5"
          >
            <span className="font-mono text-2xs opacity-45">{index + 2}</span>
            <span className="line-clamp-1 text-2xs font-medium">{section}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function SitePreview({ template }: { template: BuiltInTemplate }) {
  return (
    <div className="flex h-[calc(100%-1rem)] flex-col justify-between pt-4">
      <div className="grid grid-cols-[1fr_5rem] items-start gap-3">
        <p className="line-clamp-2 font-serif text-xl font-medium leading-none tracking-tight">
          {sectionLabel(template, 0)}
        </p>
        <span className="justify-self-end rounded-full border border-current/30 px-2 py-1 font-mono text-2xs uppercase tracking-wide">
          Action →
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {template.sections.slice(1, 4).map((section) => (
          <div key={section} className="min-h-10 border border-current/20 p-1.5">
            <span className="line-clamp-2 text-2xs font-medium leading-tight">{section}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ReportPreview({ template }: { template: BuiltInTemplate }) {
  return (
    <div className="grid h-[calc(100%-1rem)] grid-cols-[.72fr_1.28fr] items-end gap-4 pt-3">
      <div className="pb-2">
        <span className="font-serif text-4xl font-medium leading-none tracking-tight">
          {String(template.sections.length).padStart(2, "0")}
        </span>
        <p className="mt-1 font-mono text-2xs uppercase tracking-widest opacity-55">signals</p>
      </div>
      <div className="grid gap-2 pb-2">
        {template.sections.slice(0, 3).map((section, index) => (
          <div
            key={section}
            className="grid grid-cols-[1fr_auto] items-end gap-2 border-b border-current/20 pb-1.5"
          >
            <span className="line-clamp-1 text-2xs font-medium">{section}</span>
            <span className="font-mono text-2xs opacity-45">0{index + 1}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function AgentPreview({ template }: { template: BuiltInTemplate }) {
  return (
    <div className="flex h-[calc(100%-1rem)] items-center pt-3">
      <div className="grid w-full grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-1.5">
        {template.sections.slice(0, 3).map((section, index) => (
          <div key={section} className="contents">
            {index > 0 ? <span className="text-xs opacity-45">→</span> : null}
            <div className="grid min-h-14 place-items-center border border-current/25 p-1.5 text-center">
              <span className="line-clamp-3 text-2xs font-medium leading-tight">{section}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** A source-free structural preview using each Template's real section contract. */
export function TemplateArtwork({
  template,
  className,
}: {
  template: BuiltInTemplate
  className?: string
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative aspect-[16/10] overflow-hidden rounded-lg border border-current/15 p-4",
        SURFACE_BY_CATEGORY[template.category] ?? SURFACE_BY_CATEGORY.Doc,
        className,
      )}
    >
      <PreviewHeader template={template} />
      {template.category === "Deck" ? <DeckPreview template={template} /> : null}
      {template.category === "Doc" ? <DocPreview template={template} /> : null}
      {template.category === "Site" ? <SitePreview template={template} /> : null}
      {template.category === "Report" ? <ReportPreview template={template} /> : null}
      {template.category === "Agent" ? <AgentPreview template={template} /> : null}
    </div>
  )
}
