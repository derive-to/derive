import { Link } from "@tanstack/react-router"
import { Logo } from "@/components/shared/logo"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { useDocumentTitle } from "@/lib/use-document-title"

// The public roadmap page. Its body is a Derive artifact (short id 9gqu98hd)
// embedded chrome-less: the page draws its own frame, the artifact stays the
// single source of truth, and every republish shows here with no redeploy. The
// URLs are absolute to derive.to on purpose — this markets the hosted product's
// own roadmap, not a per-instance page. Rendered chrome-less (see chrome-routes)
// and forced dark to match the dark-designed artifact regardless of app theme.
const ROADMAP_ARTIFACT = "https://derive.to/artifacts/derive-roadmap-9gqu98hd"
const ROADMAP_EMBED = "https://derive.to/v1/embed/derive-roadmap-9gqu98hd?chrome=none"

export function Roadmap() {
  useDocumentTitle("Roadmap")
  return (
    <div className="dark min-h-dvh bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-6 py-5">
        <header className="flex items-center gap-2.5 border-b border-border/70 pb-5">
          <Link to="/" className="flex items-center gap-2.5">
            <Logo size={19} />
            <span className="text-sm font-semibold tracking-tight">Derive</span>
          </Link>
          <a
            href={ROADMAP_ARTIFACT}
            target="_blank"
            rel="noopener"
            className="ml-auto text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Open on Derive ↗
          </a>
        </header>

        <div className="pt-10 pb-7">
          <p className="font-mono text-2xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Living document
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Where Derive is going
          </h1>
          <p className="mt-3 max-w-prose text-muted-foreground">
            This roadmap is a Derive artifact, maintained by an agent through review rounds. It
            updates here the moment a new version is published, so the page never goes stale.
          </p>
        </div>

        {/* A definite height (not flex-1) so the iframe's height resolves cleanly through
            the embed's nested frame; the living roadmap scrolls inside its frame. */}
        <div className="h-[82vh] min-h-[34rem] overflow-hidden rounded-xl border border-border">
          <iframe src={ROADMAP_EMBED} title="Derive Roadmap" className="size-full" />
        </div>

        <Eyebrow as="footer" className="flex flex-wrap items-center justify-between gap-2 pt-5">
          <span>Derive · publish, review, and own your AI artifacts</span>
          <a href="https://derive.to" className="transition-colors hover:text-foreground">
            derive.to
          </a>
        </Eyebrow>
      </div>
    </div>
  )
}
