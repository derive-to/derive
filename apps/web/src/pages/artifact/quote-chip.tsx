import { cn } from "@/lib/utils"

// The quoted-reference treatment: the excerpt a comment (or composer) is
// anchored to. One recipe — an edge-marked italic chip at text-sm — shared by
// the comment-card jump button, the composer preview, and the mobile selection
// bar, so the grammar can't drift. `muted` is the orphaned/inactive tone.
export function quoteChipClass(opts?: { muted?: boolean; className?: string }) {
  return cn(
    "border-l-[3px] px-2.5 py-1.5 text-left text-sm italic",
    opts?.muted
      ? "border-border bg-secondary text-muted-foreground"
      : "border-foreground/25 bg-accent text-foreground",
    opts?.className,
  )
}
