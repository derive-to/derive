import { ChevronRight } from "lucide-react"
import type { ReactNode } from "react"
import { Eyebrow } from "@/components/shared/section-eyebrow"
import { cn } from "@/lib/utils"

// The one header a folder group wears, in both folder views (a manual collection's
// named folders, a synced repo's path prefixes): caret, label, count, a hairline
// running to the edge, and the group's action riding the far end. The same section
// anatomy as the Collections page's rules, so a folder reads as a DIVIDER over the
// cards — subordinate to the page title above it and the content below it — rather
// than as file-manager chrome competing with both.
//
// One register decision: manual folder names wear the eyebrow (uppercase mono, the
// app's section voice); repo paths stay lowercase mono, because uppercasing a
// case-sensitive path like docs/architecture would distort it. Same anatomy, register
// fitted to what the label IS.
export function FolderHeader({
  label,
  count,
  open,
  onToggle,
  trailing,
  muted = false,
  path = false,
  testId,
}: {
  label: string
  count: number
  open: boolean
  onToggle: () => void
  /** The group's one action — a manage ⋯, a follow button — after the rule. */
  trailing?: ReactNode
  /** The leftover bucket ("Unfiled", "Other"): same anatomy, quieter ink, so it never
   *  reads as a folder someone literally named that. */
  muted?: boolean
  /** A repo path, not a name: lowercase mono, never uppercased. */
  path?: boolean
  testId: string
}) {
  return (
    <div className="flex h-8 items-center gap-2.5">
      <button
        type="button"
        data-testid={`${testId}-toggle`}
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-w-0 items-center gap-1.5 rounded-md text-left outline-none transition-colors duration-state hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-state",
            open && "rotate-90",
          )}
          aria-hidden
        />
        {path ? (
          <span
            className={cn(
              "truncate font-mono text-xs",
              muted ? "text-muted-foreground/70" : "text-muted-foreground",
            )}
          >
            {label}
          </span>
        ) : (
          <Eyebrow as="span" className={cn("truncate", muted && "text-muted-foreground/70")}>
            {label}
          </Eyebrow>
        )}
        <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground/70">
          {count}
        </span>
      </button>
      <span className="min-w-4 flex-1" />
      {trailing}
    </div>
  )
}
