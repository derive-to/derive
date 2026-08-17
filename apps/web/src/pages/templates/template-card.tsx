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
        <div className="flex min-w-0 flex-col gap-2 px-1 pb-1">
          <div className="flex items-center gap-2">
            <Badge variant="outline" shape="pill">
              {template.kind === "context" ? "Context" : template.category}
            </Badge>
            {template.featured && (
              <p className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
                Featured
              </p>
            )}
          </div>
          <h2 className="font-serif text-lg font-medium tracking-tight text-foreground [overflow-wrap:anywhere]">
            {template.title}
          </h2>
          <p className="line-clamp-2 text-base/7 text-pretty text-muted-foreground sm:text-sm/6">
            {template.description}
          </p>
        </div>
      </CardContent>
      <CardFooter className="mt-auto p-2">
        <Button
          className="w-full"
          size="sm"
          variant="outline"
          onClick={onUse}
          data-testid={`template-use-${template.id}`}
        >
          <Icon name="sparkles" /> Use template
        </Button>
      </CardFooter>
    </Card>
  )
}
