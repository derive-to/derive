import { Link } from "@tanstack/react-router"
import { X } from "lucide-react"
import { type ReactNode, useState } from "react"
import type { Artifact, Viewer } from "@/api"
import { Icon } from "@/components/icons"
import { Logo } from "@/components/shared/logo"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { artifactTypeLabel } from "@/lib/artifact"
import { stampSrc } from "@/lib/src-stamp"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"
import { FloatingControl } from "./floating-control"
import { commentNudgeCopy, shouldPromptSignInToComment } from "./lib/comment-access"
import { refFor } from "./parse-ref"
import { Presence } from "./rail-deck"

// Backdrop texture for the anon comments panel — the marketing site's "chats
// scroll away" ocean, miniaturized to one column. Deliberately generic review
// chatter (no names, no specifics): real comment bodies never reach anonymous
// viewers, and these must read as decoration, not as a blurred peek at the thread.
const GHOST_COMMENTS = [
  "This section sings.",
  "can we tighten the intro?",
  "Ship it.",
  "the chart carries this page",
  "second look before Friday?",
  "Approved",
  "v4 fixed it",
  "needs a number behind this claim",
  "much better in this version",
  "same note as last round, resolved",
]

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
  shown,
  returnTo,
  viewers,
  selfId,
  isMobile,
  children,
}: {
  art: Artifact
  /** The version being rendered (an @vN link may pin one behind current). */
  shown: number
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

  // The comment nudge: only on a link that grants commenting — signing in on a
  // view-only link unlocks nothing, so prompting there would be a bait-and-switch.
  // Comment BODIES stay signed-in-only (collaboration, not content); the pill
  // carries just the open-thread count the API sends.
  const nudge = shouldPromptSignInToComment(art.link_role, !!art.removed)
  const copy = commentNudgeCopy(art.open_comment_count)
  const [nudgeOpen, setNudgeOpen] = useState(false)
  // Base ref for the version menu's links (current = bare, past = @vN).
  const baseRef = refFor({ short_id: art.short_id, title: art.title })

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
            {artifactTypeLabel(art)} ·{" "}
            {/* With public history on, the version reads as a menu: every version,
                one line each, navigating the @vN refs the router already serves.
                Off (or a single version), it stays the inert text it always was. */}
            {art.public_history && (art.versions?.length ?? 0) > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  data-testid="public-version-menu"
                  className="rounded-sm text-foreground underline decoration-dotted underline-offset-2 outline-none hover:decoration-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  v{shown} ▾
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-w-[420px]">
                  {[...(art.versions ?? [])].reverse().map((v) => (
                    <DropdownMenuItem key={v.n} asChild data-testid={`public-version-${v.n}`}>
                      <Link
                        to="/artifacts/$ref"
                        params={{
                          ref: v.n === art.current_version ? baseRef : `${baseRef}@v${v.n}`,
                        }}
                        className="flex w-full min-w-0 items-baseline gap-2 font-mono text-xs"
                      >
                        <span className={cn("shrink-0", v.n === shown && "font-semibold")}>
                          v{v.n}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {v.created_at ? ago(v.created_at) : ""}
                        </span>
                        {v.author && (
                          <span className="shrink-0 text-muted-foreground">· {v.author}</span>
                        )}
                        {v.message && (
                          <span className="truncate text-muted-foreground">· {v.message}</span>
                        )}
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <>v{shown}</>
            )}
            {art.updated_at ? ` · ${ago(art.updated_at)}` : ""}
          </div>
        </div>

        {/* A shared link that's being viewed feels alive — even on a phone (compact). */}
        <Presence viewers={viewers} selfId={selfId} compact={isMobile} />

        {/* The growth verb (the page's one filled primary) + a quiet sign-in. Clicks
            refine the d_src stamp so the funnel knows WHICH surface converted. */}
        <Button asChild variant="default" size="sm" data-testid="public-make-your-own">
          <Link
            to="/login"
            search={{ signup: true, return_to: "/new" }}
            onClick={() => stampSrc("make_your_own", art.short_id)}
          >
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
      <div className="relative flex min-h-0 flex-1 flex-col">
        {children}
        {/* The nudge pill — the signed-in comments FAB's grammar, pointed at auth.
            Clicking opens the panel rather than bouncing straight to /login: the
            panel names what's behind the wall before asking for the sign-in. */}
        {nudge && !nudgeOpen && (
          <FloatingControl
            size="lg"
            title="Show comments"
            data-testid="public-comments-pill"
            onClick={() => setNudgeOpen(true)}
            className="absolute right-4.5 bottom-4.5 tabular-nums"
          >
            <Icon name="comments" size={16} />
            {copy.pill}
          </FloatingControl>
        )}
        {/* The anon comments panel: the signed-in panel's shell (Comments header,
            same width) with the sign-in CTA where the threads would be. It OVERLAYS
            the render's right edge on every form factor — never docks — so toggling
            it can't resize the sandboxed iframe and reflow the author's page. The
            CTA stamps `comment_wall` so the funnel scores this surface, and returns
            the visitor here to the conversation they came for — not to /new. */}
        {nudge && nudgeOpen && (
          <aside
            data-testid="public-comments-panel"
            className="absolute inset-y-0 right-0 z-10 flex w-[340px] max-w-[85vw] flex-col border-l border-border bg-background shadow-[var(--shadow)]"
          >
            <div className="flex shrink-0 items-center gap-1 border-b border-border-soft py-2 pr-2 pl-3.5">
              <span className="flex-1 text-sm font-medium text-foreground">Comments</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close comments"
                data-testid="public-comments-close"
                onClick={() => setNudgeOpen(false)}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </div>
            <div className="relative flex flex-1 flex-col items-center justify-center gap-3 overflow-hidden px-6 text-center">
              {/* The drifting backdrop. The list renders 4x so one loop copy (2x)
                  outruns any panel height; the mask fades both edges the way the
                  marketing ocean does. Texture, never content — aria-hidden. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-5 inset-y-0 [mask-image:linear-gradient(to_bottom,transparent,black_22%,black_78%,transparent)]"
              >
                <div className="flex animate-ghost-drift flex-col gap-5">
                  {Array.from({ length: 4 }, () => GHOST_COMMENTS)
                    .flat()
                    .map((g, i) => (
                      <span
                        key={`${g}-${i}`}
                        className={cn(
                          "whitespace-nowrap font-mono text-2xs text-foreground",
                          i % 3 === 1 && "self-end",
                          i % 3 === 2 && "self-center",
                          i % 2
                            ? "opacity-10"
                            : "rounded-lg border border-border-soft bg-card px-3 py-2 opacity-20",
                        )}
                      >
                        {g}
                      </span>
                    ))}
                </div>
              </div>
              {/* The crisp card among the ghosts — the marketing ocean's "kept"
                  idiom: the chatter drifts, the invitation holds still. */}
              <div className="relative flex flex-col items-center gap-3 rounded-2xl border border-border-soft bg-background/90 px-7 py-6 shadow-[var(--shadow)] backdrop-blur-[2px]">
                <Icon name="comments" size={24} className="text-muted-foreground" />
                {copy.heading && <p className="text-sm text-muted-foreground">{copy.heading}</p>}
                <Button asChild variant="default" size="sm" data-testid="public-sign-in-to-comment">
                  <Link
                    to="/login"
                    search={{ return_to: returnTo }}
                    onClick={() => stampSrc("comment_wall", art.short_id)}
                  >
                    {copy.cta}
                  </Link>
                </Button>
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* A quiet, permanent brand mark (the "Made in Framer" idiom — attribution +
          a soft nudge, never a wall). A real link: the click lands in product
          (signup → publish), stamped as the badge surface. White-label workspaces
          (art.badge === false) drop the strip entirely — that's what they pay for. */}
      {art.badge !== false && (
        <footer className="flex shrink-0 items-center justify-center border-t border-border-soft py-1.5 font-mono text-2xs text-muted-foreground">
          <Link
            to="/login"
            search={{ signup: true, return_to: "/new" }}
            onClick={() => stampSrc("badge", art.short_id)}
            data-testid="public-made-with"
            className="flex items-center gap-1.5 rounded-md outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <Logo size={12} />
            Made with Derive
          </Link>
        </footer>
      )}
    </div>
  )
}
