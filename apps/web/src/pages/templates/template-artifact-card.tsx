import { Link } from "@tanstack/react-router"
import type { TemplateArtifact } from "@/api"
import { Icon } from "@/components/icons"
import { AuthorChip } from "@/components/shared/author-chip"
import { Thumb } from "@/components/shared/thumb"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import { artifactTypeLabel } from "@/lib/artifact"
import { signupSourceSearch } from "@/lib/signup-source"
import { markUseIntent } from "@/pages/artifact/lib/use-intent"
import { refFor } from "@/pages/artifact/parse-ref"

/** One shelf row: the artifact's render, title, and author, with the two ways to start from it. */
export function TemplateArtifactCard({
  template: a,
  signedIn,
  copying,
  onCopy,
  onAsk,
}: {
  template: TemplateArtifact
  /** Signed out, "Make a copy" goes through sign-in and keeps the intent for afterward. */
  signedIn: boolean
  copying: boolean
  onCopy: () => void
  onAsk: () => void
}) {
  const author = a.author ?? null
  const hasAuthor = !!(author?.name ?? a.author_name)
  const origin = a.shelf === "workspace" ? "This workspace" : "Public"
  const ref = refFor({ short_id: a.short_id, title: a.title })
  return (
    // `group`: Thumb wakes its render on the group's hover, as in the library card.
    <Card data-testid={`template-card-${a.short_id}`} className="group h-full gap-0 py-0">
      <CardContent className="flex min-w-0 flex-col gap-3 p-3">
        <div className="relative overflow-hidden rounded-lg">
          <Thumb
            id={a.short_id}
            v={a.current_version}
            typeLabel={artifactTypeLabel(a)}
            hasPreview={a.has_preview}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-2 px-1 pb-1">
          <div className="flex items-center gap-2">
            <Badge variant="outline" shape="pill">
              {origin}
            </Badge>
          </div>
          <h2 className="font-serif text-lg font-medium tracking-tight text-foreground [overflow-wrap:anywhere]">
            <Link
              to="/templates/$ref"
              params={{ ref }}
              className="hover:underline"
              data-testid={`template-open-${a.short_id}`}
            >
              {a.title || "Untitled"}
            </Link>
          </h2>
          {hasAuthor && (
            <AuthorChip
              name={author?.name ?? a.author_name ?? null}
              login={author?.login ?? a.author_login ?? null}
              avatar={author?.avatar ?? a.author_avatar ?? null}
              handle={author?.handle ?? null}
              size="xs"
              className="min-w-0"
              data-testid={`template-author-${a.short_id}`}
            />
          )}
        </div>
      </CardContent>
      <CardFooter className="mt-auto flex gap-2 p-2">
        {signedIn ? (
          <Button
            className="flex-1"
            size="sm"
            disabled={copying}
            onClick={onCopy}
            data-testid={`template-copy-${a.short_id}`}
          >
            <Icon name="copy" /> {copying ? "Copying…" : "Make a copy"}
          </Button>
        ) : (
          <Button asChild className="flex-1" size="sm" data-testid={`template-copy-${a.short_id}`}>
            <Link
              to="/login"
              search={{
                signup: true,
                return_to: `/templates/${ref}?use=1`,
                ...signupSourceSearch("template_shelf", a.short_id, "/templates"),
              }}
              onClick={() => {
                markUseIntent(a.short_id)
              }}
            >
              <Icon name="copy" /> Make a copy
            </Link>
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={onAsk}
          data-testid={`template-ask-${a.short_id}`}
        >
          <Icon name="sparkles" /> Ask your agent
        </Button>
      </CardFooter>
    </Card>
  )
}
