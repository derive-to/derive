import { cn } from "@/lib/utils"

// The pulse is opacity movement (allowed motion, unlike hover color transitions);
// under reduced motion it falls back to a static muted block.
// Hidden from AT by default (skeletons are decoration — the loading REGION
// announces via role="status" + sr-only text, never the blocks themselves);
// overridable through props for the rare labelled placeholder.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

export { Skeleton }
