import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

/**
 * The breadcrumb register: a trail of quiet ancestor links, then the leaf you're on.
 *
 * The artifact header grew one of these by hand (`Collection / Folder / Title`) and the
 * library had none — so a collection told you where you were on one page and not the
 * other, and getting back out of one meant finding an `×` chip in the toolbar. Same
 * idiom in both places now.
 *
 * This exports the LOOK, not a Link wrapper. Wrapping TanStack's `Link` erases the
 * correlation between `to` and `search`, which is most of what its types are for — so
 * call sites keep their own real `Link` and borrow `crumbClass`.
 *
 * The leaf is not rendered here: it's the page's own heading, in the page's own voice (a
 * serif `h1` on an artifact, an `h2` with its count on a collection). A breadcrumb whose
 * last segment repeats the heading beneath it says the same thing twice.
 */
export function Breadcrumb({ className, children, ...props }: ComponentProps<"nav">) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn("flex min-w-0 items-center gap-1.5", className)}
      {...props}
    >
      {children}
    </nav>
  )
}

/**
 * One ancestor link. Truncates rather than wrapping.
 *
 * `yields` marks a crumb that should give up width FIRST — a middle segment, when the
 * trail is deeper than one level. The leaf keeps priority: the thing you're on should be
 * the last thing to become unreadable.
 */
export const crumbClass = (yields = false) =>
  cn(
    "min-w-0 truncate text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    yields ? "max-w-32 shrink-[3]" : "max-w-44 shrink",
  )

/** The divider. Decorative — a reader gets the nav landmark and the link text. */
export function CrumbSep() {
  return (
    <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">
      /
    </span>
  )
}
