import { Link } from "@tanstack/react-router"
import type { TemplateLibrary } from "@/api"
import { Icon } from "@/components/icons"
import { AuthorChip } from "@/components/shared/author-chip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { scopeCopy } from "./template-library-helpers"

function LibraryCardContent({ library }: { library: TemplateLibrary }) {
  return (
    <>
      <CardHeader>
        <div className="mb-2 flex items-center justify-between gap-2">
          <Badge variant="outline" shape="pill">
            <Icon name={scopeCopy[library.scope].icon} size={12} /> {scopeCopy[library.scope].label}
          </Badge>
          <span className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
            {library.entry_count} starters
          </span>
        </div>
        <CardTitle className="font-serif text-xl tracking-tight [overflow-wrap:anywhere]">
          {library.title}
        </CardTitle>
        <CardDescription className="line-clamp-2">
          {library.description || "Reusable Derive starters."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {library.publisher.name || library.publisher.username ? (
          <AuthorChip
            name={library.publisher.name}
            login={null}
            avatar={library.publisher.image}
            handle={library.publisher.username}
            size="xs"
          />
        ) : null}
      </CardContent>
    </>
  )
}

export function TemplateLibraryCard({
  library,
  onOpen,
  testId,
}: {
  library: TemplateLibrary
  onOpen?: () => void
  testId: string
}) {
  const content = <LibraryCardContent library={library} />
  if (onOpen)
    return (
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid={testId}
      >
        <Card className="h-full gap-3 hover:border-foreground/25">
          {content}
          <CardFooter className="mt-auto justify-between text-sm font-medium">
            Browse starters <Icon name="arrow" className="size-3.5" />
          </CardFooter>
        </Card>
      </button>
    )

  return (
    <Card className="min-w-0 gap-3">
      {content}
      <CardFooter className="mt-auto">
        <Button asChild className="w-full" data-testid={testId}>
          <Link to="/template-libraries/$id" params={{ id: library.id }}>
            Browse starters <Icon name="arrow" />
          </Link>
        </Button>
      </CardFooter>
    </Card>
  )
}
