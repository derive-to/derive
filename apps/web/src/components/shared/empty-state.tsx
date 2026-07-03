import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// "There's simply nothing here" — deliberately NOT a box. No dashed border, no
// card: the state sits directly on the canvas as an icon, an Inter headline (the
// voice register — an empty state is a moment of voice, not tool chrome), one
// line of plain copy, and ONE quiet action (secondary — the page's real CTA
// lives elsewhere). Generic on purpose so every surface (library, collections,
// members, comments) shares one look. Pass icon/title/description/action for
// the structured state, or children for a plain one-line message.
export function EmptyState({
  children,
  icon,
  title,
  description,
  action,
  className,
}: {
  children?: ReactNode
  /** Editorial register — pass strokeWidth={1.75}; sizing + brand tint applied here. */
  icon?: ReactNode
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  const structured = !!(icon || title || description || action)
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center p-10 text-center text-sm text-muted-foreground",
        structured && "gap-4 py-14",
        className,
      )}
    >
      {/* Icon rendered directly — no decorative container. The faint brand tint
          keeps it an editorial accent, not a focal blob. */}
      {icon && (
        <span aria-hidden className="text-primary/70 [&_svg:not([class*='size-'])]:size-6">
          {icon}
        </span>
      )}
      {(title || description) && (
        <div className="flex flex-col items-center gap-2">
          {title && (
            <p className="font-serif text-xl font-medium tracking-tight text-balance text-foreground">
              {title}
            </p>
          )}
          {description && <p className="max-w-sm text-sm text-pretty">{description}</p>}
        </div>
      )}
      {children}
      {action && <div>{action}</div>}
    </div>
  )
}
