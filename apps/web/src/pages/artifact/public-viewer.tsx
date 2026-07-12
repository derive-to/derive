import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import type { Artifact, Viewer } from "@/api"
import { Logo } from "@/components/shared/logo"
import { Button } from "@/components/ui/button"
import { artifactTypeLabel } from "@/lib/artifact"
import { ago } from "@/lib/time"
import { Presence } from "./rail-deck"

// The public / viral viewer — the chrome-light experience an anonymous visitor
// gets on a shared /artifacts/ link (the growth loop). The render is the whole page; a
// slim public header carries the Derive brand (→ home), the artifact's identity +
// a CREATOR BYLINE (attribution drives sharing), live presence, and the growth
// verbs (Make your own · Sign in); a quiet "Made with Derive" mark closes it. No
// workbench chrome (research: never gate the view; the render is the hero; the
// verb is the growth loop). The page wires the render machinery and passes it in
// as `children`.
export function PublicViewer({
  art,
  returnTo,
  viewers,
  selfId,
  isMobile,
  children,
}: {
  art: Artifact
  /** The current /artifacts/<ref> path, so Sign in returns here afterward. */
  returnTo: string
  viewers: Viewer[]
  selfId?: string
  isMobile: boolean
  /** The render (ArtifactDocument) — the page owns its refs/bridge and threads it in. */
  children: ReactNode
}) {
  const author = art.author
  const authorName = author?.name ?? author?.login ?? null

  return (
    <div data-artifact-view className="flex min-h-0 flex-1 flex-col bg-background">
      {/* The slim public header — brand · identity + byline · presence · the verbs. */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5 max-sm:px-3">
        <Link
          to="/"
          aria-label="Derive home"
          className="flex shrink-0 items-center gap-1.5 rounded-md text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Logo size={20} />
          <span className="font-serif text-base font-medium tracking-tight max-sm:sr-only">
            Derive
          </span>
        </Link>

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h1
            className="truncate font-serif text-base font-medium leading-tight tracking-tight"
            title={art.title ?? undefined}
          >
            {art.title ?? "Untitled"}
          </h1>
          <div className="truncate font-mono text-2xs tabular-nums text-muted-foreground">
            {authorName &&
              (author?.handle ? (
                <>
                  by{" "}
                  <Link
                    to="/users/$handle"
                    params={{ handle: author.handle }}
                    className="text-foreground hover:underline"
                  >
                    {authorName}
                  </Link>{" "}
                  ·{" "}
                </>
              ) : (
                <>by {authorName} · </>
              ))}
            {artifactTypeLabel(art)} · v{art.current_version}
            {art.updated_at ? ` · ${ago(art.updated_at)}` : ""}
          </div>
        </div>

        {/* A shared link that's being viewed feels alive — even on a phone (compact). */}
        <Presence viewers={viewers} selfId={selfId} compact={isMobile} />

        {/* The growth verb (the page's one filled primary) + a quiet sign-in. */}
        <Button asChild variant="default" size="sm" data-testid="public-make-your-own">
          <Link to="/login" search={{ signup: true, return_to: "/new" }}>
            {isMobile ? "Make yours" : "Make your own"}
          </Link>
        </Button>
        <Button
          asChild
          variant="ghost"
          size="sm"
          data-testid="public-sign-in"
          className="max-sm:sr-only"
        >
          <Link to="/login" search={{ return_to: returnTo }}>
            Sign in
          </Link>
        </Button>
      </header>

      {/* The render is the hero — it owns the rest of the height. */}
      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>

      {/* A quiet, permanent brand mark (the "Made in Framer" idiom — attribution +
          a soft nudge, never a wall). */}
      <footer className="flex shrink-0 items-center justify-center gap-1.5 border-t border-border-soft py-1.5 font-mono text-2xs text-muted-foreground">
        <Logo size={12} />
        Made with Derive
      </footer>
    </div>
  )
}
