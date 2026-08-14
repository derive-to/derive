import type { ReactNode } from "react"
import type { TemplateLibraryEntry } from "@/api"
import { Badge } from "@/components/ui/badge"

export function TemplateEntryCard({
  entry,
  actions,
}: {
  entry: TemplateLibraryEntry
  actions: ReactNode
}) {
  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" shape="pill">
          {entry.kind === "context" ? "Context" : entry.category}
        </Badge>
        <Badge variant="outline" shape="pill">
          Source v{entry.source_version}
        </Badge>
      </div>
      <div className="min-w-0">
        <h3 className="font-serif text-xl font-medium tracking-tight text-foreground [overflow-wrap:anywhere]">
          {entry.title}
        </h3>
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{entry.description}</p>
      </div>
      {entry.inputs.length > 0 ? (
        <p className="line-clamp-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          Needs:{" "}
          {entry.inputs
            .map((input) => `${input.name}${input.required ? " · required" : ""}`)
            .join(" · ")}
        </p>
      ) : null}
      {entry.sections.length > 0 ? (
        <p className="line-clamp-1 font-mono text-2xs uppercase tracking-wider text-muted-foreground [overflow-wrap:anywhere]">
          {entry.sections.join(" · ")}
        </p>
      ) : null}
      <div className="mt-auto flex flex-wrap gap-2 border-t pt-3">{actions}</div>
    </article>
  )
}
