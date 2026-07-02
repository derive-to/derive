/**
 * Catalyst sidebar primitives (the Nemonic port), token-translated for Derive.
 *
 * Doctrine:
 * - Header / body / footer each own the p-4 gutter; the BODY is the one scroll
 *   region, so the header and footer stay pinned. The current-item tick
 *   reaches -left-4 into that gutter — overflow clips at the padding-box edge,
 *   so the tick renders flush with the sidebar's edge without being cut.
 * - Rest labels are FULL-STRENGTH ink (Nemonic's calm confidence); only ICONS
 *   carry the muted register. Hover/current brighten the icon over the faint
 *   neutral wash — state is ink + the amber edge tick, never a heavier fill or
 *   a font-weight change.
 */
import { Link } from "@tanstack/react-router"
import type * as React from "react"
import { cn } from "@/lib/utils"

export function Sidebar({ className, ...props }: React.ComponentProps<"nav">) {
  return <nav {...props} className={cn("flex h-full min-h-0 flex-col", className)} />
}

export function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "flex flex-col border-b border-border-soft p-4 [&>[data-slot=section]+[data-slot=section]]:mt-2.5",
        className,
      )}
    />
  )
}

export function SidebarBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "flex flex-1 flex-col overflow-y-auto p-4 [&>[data-slot=section]+[data-slot=section]]:mt-8",
        className,
      )}
    />
  )
}

export function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "flex flex-col border-t border-border-soft p-4 [&>[data-slot=section]+[data-slot=section]]:mt-2.5",
        className,
      )}
    />
  )
}

export function SidebarSection({ className, ...props }: React.ComponentProps<"div">) {
  return <div {...props} data-slot="section" className={cn("flex flex-col gap-0.5", className)} />
}

export function SidebarSpacer({ className, ...props }: React.ComponentProps<"div">) {
  return <div aria-hidden="true" {...props} className={cn("mt-8 flex-1", className)} />
}

export function SidebarHeading({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      {...props}
      className={cn(
        "mb-1 px-2 font-mono text-2xs/6 font-medium uppercase tracking-wide text-muted-foreground",
        className,
      )}
    />
  )
}

// TanStack's Link is generic over the route tree; the primitive stays
// route-agnostic (call sites keep their own `to`/`search` typing, e.g. the
// rail's SideItem types `search: LibrarySearch`), so erase it here to an
// anchor that accepts the router props.
const RouterLink = Link as unknown as (
  props: React.ComponentProps<"a"> & { to: string; search?: unknown; params?: unknown },
) => React.ReactElement

const ITEM_CLASSES = cn(
  "flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left text-base font-medium text-foreground outline-none sm:py-2 sm:text-sm",
  "[&_svg]:shrink-0 [&_svg]:text-muted-foreground [&_svg:not([class*='size-'])]:size-4.5",
  "hover:bg-hover hover:[&_svg]:text-foreground",
  "data-current:bg-hover data-current:[&_svg]:text-foreground",
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
)

export function SidebarItem({
  current,
  className,
  children,
  ...props
}: {
  /** Marks the row as the current location: neutral wash, full-ink icon, amber edge tick. */
  current?: boolean
  className?: string
  children?: React.ReactNode
} & (
  | ({ to: string; search?: unknown; params?: unknown } & Omit<
      React.ComponentProps<"a">,
      "className" | "children" | "href"
    >)
  | ({ to?: never; search?: never; params?: never } & Omit<
      React.ComponentProps<"button">,
      "className" | "children"
    >)
)) {
  const classes = cn(ITEM_CLASSES, className)
  // The edge tick reaches into the surrounding region's p-4 gutter (see the
  // file doctrine). Static — no layout animation, no motion dependency.
  const tick = current ? (
    <span className="absolute inset-y-2 -left-4 w-0.5 rounded-full bg-primary" />
  ) : null

  if (props.to !== undefined) {
    const { to, search, params, ...rest } = props
    return (
      <span className="relative block">
        {tick}
        <RouterLink
          {...rest}
          to={to}
          search={search}
          params={params}
          className={classes}
          data-current={current ? "true" : undefined}
          aria-current={current ? "page" : undefined}
        >
          {children}
        </RouterLink>
      </span>
    )
  }
  return (
    <span className="relative block">
      {tick}
      <button
        type="button"
        {...props}
        className={classes}
        data-current={current ? "true" : undefined}
        aria-current={current ? "page" : undefined}
      >
        {children}
      </button>
    </span>
  )
}

export function SidebarLabel({ className, ...props }: React.ComponentProps<"span">) {
  return <span {...props} className={cn("min-w-0 flex-1 truncate", className)} />
}
