import { Icon } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { TemplateArtwork } from "./template-artwork"
import type { BuiltInTemplate } from "./types"

export function TemplateCard({
  template,
  onUse,
}: {
  template: BuiltInTemplate
  onUse: () => void
}) {
  return (
    <Card data-testid={`template-card-${template.id}`} className="h-full gap-0 py-0">
      <CardContent className="flex min-w-0 flex-col gap-3 p-3">
        <TemplateArtwork template={template} className="w-full" />
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
          <span className="font-serif text-lg font-medium leading-tight tracking-tight text-foreground [overflow-wrap:anywhere]">
            {template.title}
          </span>
          <span className="line-clamp-2 text-sm text-pretty text-muted-foreground">
            {template.description}
          </span>
        </span>
      </CardContent>
      <CardFooter className="mt-auto grid grid-cols-2 gap-2 p-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onUse}
          data-testid={`template-preview-${template.id}`}
        >
          <Icon name="views" /> Preview
        </Button>
        <Button size="sm" onClick={onUse} data-testid={`template-use-${template.id}`}>
          <Icon name="sparkles" /> {template.kind === "context" ? "Make it ours" : "Make it mine"}
        </Button>
      </CardFooter>
    </Card>
  )
}
