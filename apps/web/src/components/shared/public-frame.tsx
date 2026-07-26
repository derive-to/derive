import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { Logo } from "@/components/shared/logo"
import { Button } from "@/components/ui/button"

// The chrome-light frame for a public surface an anonymous visitor lands on — a
// shared profile today (the artifact viewer has its own richer PublicViewer). A slim
// brand header (→ home) + the growth verbs, the content as the hero, and a quiet
// "Made with Derive" footer: the same public-shell language as PublicViewer, minus the
// artifact-specific identity/presence. Replaces the old anon nav rail — an anon never
// sees app chrome now, just this frame around the render. `returnTo` sends Sign in
// back here afterward.
export function PublicFrame({ returnTo, children }: { returnTo: string; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {/* The slim public header — brand · the verbs. */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5 max-sm:px-3">
        <Link
          to="/"
          aria-label="Derive home"
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Logo size={20} />
          <span className="font-serif text-base font-medium tracking-tight">Derive</span>
        </Link>

        {/* The growth verb (the page's one filled primary) + a quiet sign-in. */}
        <Button asChild variant="default" size="sm" data-testid="public-make-your-own">
          <Link to="/login" search={{ signup: true, return_to: "/new" }}>
            Make your own
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

      {/* The render is the hero — it owns the rest of the height. overflow-hidden here
          mirrors the shell's SidebarInset contract, so the page's own scroll container
          (PageShell) behaves identically to when it renders inside the app rail. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>

      {/* A quiet, permanent brand mark (the "Made in Framer" idiom — attribution + a
          soft nudge, never a wall). */}
      <footer className="flex shrink-0 items-center justify-center gap-1.5 border-t border-border-soft py-1.5 font-mono text-2xs text-muted-foreground">
        <Logo size={12} />
        Made with Derive
      </footer>
    </div>
  )
}
