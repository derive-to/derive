import { cn } from "@/lib/utils"

// The quoted-reference treatment: the excerpt a comment (or composer) is
// anchored to. One recipe — a quiet edge-marked italic line, NOT a filled band:
// the quote is context, and a full-width wash on every card made the panel read
// as stacked gray slabs. A hairline left rule + muted italic says "reference"
// at a glance and lets the comment body carry the ink. Shared by the comment-
// card jump button, the composer preview, and the mobile selection bar, so the
// grammar can't drift. `muted` is the orphaned/inactive tone; interactive call
// sites add their own hover re-ink.
export function quoteChipClass(opts?: { muted?: boolean; className?: string }) {
  return cn(
    "border-l-2 py-0.5 pl-2.5 pr-2 text-left text-sm italic leading-snug",
    opts?.muted
      ? "border-border text-muted-foreground/70"
      : "border-foreground/25 text-muted-foreground",
    opts?.className,
  )
}
