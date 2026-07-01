import { ArrowRight } from "lucide-react"
import type { ReactNode } from "react"

// A visual "how it works" guide shown on a brand-new, empty home (below the
// publish launcher). Each step pairs a one-liner with a tiny mock of the actual
// UI it produces — publish → a versioned URL, share → @mentions, review →
// anchored comments that loop back into a new version. Purely presentational.
export function HowItWorks() {
  return (
    <section data-testid="how-it-works" className="mt-2">
      <div className="mb-4 flex items-center gap-3 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        How Derive works
        <span className="h-px flex-1 bg-border" />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Step
          n={1}
          title="Publish"
          blurb="Drop HTML, Markdown, or a whole site. You get a permanent, versioned URL."
        >
          <Mock>
            <div className="rounded-md border border-border bg-background p-2">
              <div className="h-1.5 w-12 rounded-full bg-foreground/70" />
              <div className="mt-1.5 h-1 w-full rounded-full bg-foreground/15" />
              <div className="mt-1 h-1 w-3/4 rounded-full bg-foreground/15" />
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate rounded-full bg-accent/15 px-2 py-0.5 font-mono text-2xs text-accent-foreground">
                derive.to/q3-plan
              </span>
            </div>
          </Mock>
        </Step>

        <Step n={2} title="Share" blurb="@mention teammates and choose who can view or comment.">
          <Mock>
            <div className="rounded-md border border-border bg-background p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="h-1.5 w-12 rounded-full bg-foreground/70" />
                <span className="rounded bg-primary/15 px-1.5 py-0.5 text-2xs font-medium text-primary">
                  Share
                </span>
              </div>
              <div className="mt-2 flex items-center gap-1">
                <Chip>@priya</Chip>
                <Chip>@sam</Chip>
              </div>
            </div>
          </Mock>
        </Step>

        <Step
          n={3}
          title="Review"
          blurb="Comments pin to the text. Revise, republish, and the loop closes itself."
        >
          <Mock>
            <div className="rounded-md border border-border bg-background p-2">
              <div className="h-1 w-full rounded-full bg-foreground/15" />
              <div className="mt-1 flex items-center gap-1">
                <span className="h-1 w-10 rounded-full bg-accent/60" />
                <span className="h-1 flex-1 rounded-full bg-foreground/15" />
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                <span className="rounded-md border border-border bg-card px-1.5 py-0.5 text-2xs text-muted-foreground">
                  💬 @priya
                </span>
                <ArrowRight className="size-2.5 text-muted-foreground" aria-hidden />
                <span className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-2xs text-foreground">
                  v2
                </span>
              </div>
            </div>
          </Mock>
        </Step>
      </div>
    </section>
  )
}

function Step({
  n,
  title,
  blurb,
  children,
}: {
  n: number
  title: string
  blurb: string
  children: ReactNode
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3.5">
      <div className="flex items-center gap-2">
        <span className="flex size-5 items-center justify-center rounded-full bg-primary/15 font-mono text-2xs font-semibold text-primary">
          {n}
        </span>
        <span className="font-display text-sm font-semibold text-foreground">{title}</span>
      </div>
      <div className="mt-2.5">{children}</div>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">{blurb}</p>
    </div>
  )
}

const Mock = ({ children }: { children: ReactNode }) => (
  <div className="rounded-md bg-secondary/40 p-2">{children}</div>
)

const Chip = ({ children }: { children: ReactNode }) => (
  <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-2xs font-medium text-accent-foreground">
    {children}
  </span>
)
