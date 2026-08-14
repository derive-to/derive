import { Link } from "@tanstack/react-router"
import type { TemplateLibrary } from "@/api"
import { Icon } from "@/components/icons"
import { AuthorChip } from "@/components/shared/author-chip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { scopeCopy } from "./template-library-helpers"

function LibraryCardContent({ library }: { library: TemplateLibrary }) {
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" shape="pill">
          <Icon name={scopeCopy[library.scope].icon} size={12} /> {scopeCopy[library.scope].label}
        </Badge>
        <span className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
          {library.entry_count} starters
        </span>
      </div>
      <div>
        <h3 className="font-serif text-xl font-medium tracking-tight text-foreground [overflow-wrap:anywhere]">
          {library.title}
        </h3>
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
          {library.description || "Reusable Derive starters."}
        </p>
      </div>
      {library.publisher.name || library.publisher.username ? (
        <AuthorChip
          name={library.publisher.name}
          login={null}
          avatar={library.publisher.image}
          handle={library.publisher.username}
          size="xs"
        />
      ) : null}
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
  if (onOpen)
    return (
      <button
        type="button"
        onClick={onOpen}
        className="group flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 text-left outline-none hover:border-foreground/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        data-testid={testId}
      >
        <LibraryCardContent library={library} />
        <span className="mt-auto text-sm font-medium text-foreground">
          Browse starters <Icon name="arrow" className="inline size-3.5" />
        </span>
      </button>
    )

  return (
    <article className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4">
      <LibraryCardContent library={library} />
      <Button asChild className="mt-auto" data-testid={testId}>
        <Link to="/template-libraries/$id" params={{ id: library.id }}>
          Browse starters <Icon name="arrow" />
        </Link>
      </Button>
    </article>
  )
}
