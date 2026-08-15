import type { ReactNode } from "react"
import type { TemplateLibraryEntry } from "@/api"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export function TemplateEntryCard({
  entry,
  actions,
}: {
  entry: TemplateLibraryEntry
  actions: ReactNode
}) {
  return (
    <Card className="min-w-0 gap-3">
      <CardHeader>
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" shape="pill">
            {entry.kind === "context" ? "Context" : entry.category}
          </Badge>
          <Badge variant="outline" shape="pill">
            Source v{entry.source_version}
          </Badge>
        </div>
        <CardTitle className="font-serif text-xl tracking-tight [overflow-wrap:anywhere]">
          {entry.title}
        </CardTitle>
        <CardDescription className="line-clamp-2">{entry.description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
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
      </CardContent>
      <CardFooter className="mt-auto flex-wrap gap-2">{actions}</CardFooter>
    </Card>
  )
}
