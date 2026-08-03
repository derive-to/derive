import { ArrowRight } from "lucide-react"
import type { ReactNode } from "react"
import { Icon } from "@/components/icons"
import { Badge } from "@/components/ui/badge"

// First-run orientation on an empty home (below the publish launcher): Derive's one
// loop — publish, share, review, then revise and republish. Each step SHOWS a small
// mockup of the UI it produces (show, don't tell) so a cold user sees what Derive
// does, not just reads it. A description list per the feature-list rule; the mock
// "screens" carry the house image outline (not a border), one frame deep. Purely
// presentational.
export function HowItWorks() {
  return (
    <section data-testid="how-it-works" className="mt-8">
      <h2 className="font-serif text-xl font-medium tracking-tight text-balance text-foreground">
        How Derive works
      </h2>
      <p className="mt-1.5 text-sm text-pretty text-muted-foreground">
        Every artifact runs the same loop.
      </p>

      <dl className="mt-5 grid gap-3 sm:grid-cols-3">
        <Step
          n={1}
          title="Publish"
          blurb="Drop HTML, Markdown, a slide deck, or a whole site — you get a permanent, versioned URL."
        >
          <div className="h-1.5 w-12 rounded-full bg-foreground/70" />
          <div className="mt-1.5 h-1 w-full rounded-full bg-foreground/15" />
          <div className="mt-1 h-1 w-3/4 rounded-full bg-foreground/15" />
          <div className="mt-2.5 flex items-center gap-1.5">
            <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <Badge shape="pill">derive.to/q3-plan</Badge>
          </div>
        </Step>

        <Step n={2} title="Share" blurb="@mention teammates and choose who can view or comment.">
          <div className="flex items-center justify-between gap-2">
            <div className="h-1.5 w-12 rounded-full bg-foreground/70" />
            <Badge variant="brand">Share</Badge>
          </div>
          <div className="mt-2 flex items-center gap-1">
            <Badge shape="pill">@priya</Badge>
            <Badge shape="pill">@sam</Badge>
          </div>
        </Step>

        <Step
          n={3}
          title="Review"
          blurb="Comments pin to the text, or to the slide. Revise, republish — the loop closes itself."
        >
          <div className="h-1 w-full rounded-full bg-foreground/15" />
          <div className="mt-1 flex items-center gap-1">
            <span className="h-1 w-10 rounded-full bg-foreground/40" />
            <span className="h-1 flex-1 rounded-full bg-foreground/15" />
          </div>
          <div className="mt-2.5 flex items-center gap-1">
            <Badge variant="outline">
              <Icon name="comments" size={12} /> @priya
            </Badge>
            <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <Badge shape="pill">v2</Badge>
          </div>
        </Step>
      </dl>
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
    <div className="flex flex-col gap-2.5 rounded-xl border bg-card p-3.5">
      <dt className="flex items-center gap-2">
        {/* Soft brand tint on the step number — a sanctioned brand chip, never a
            solid ink block. px-0 keeps the digit centered in the size-5 circle. */}
        <Badge variant="brand" shape="pill" className="size-5 px-0">
          {n}
        </Badge>
        <span className="text-sm font-medium text-foreground">{title}</span>
      </dt>
      <dd className="m-0 flex flex-col gap-2.5">
        {/* A mini mockup of the UI this step produces — a framed "screen" with the
            house image outline (not a border), so it reads as a preview. */}
        <div className="rounded-md bg-background p-2.5 outline-1 -outline-offset-1 outline-foreground/10">
          {children}
        </div>
        <p className="text-sm text-pretty text-muted-foreground">{blurb}</p>
      </dd>
    </div>
  )
}
