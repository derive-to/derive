import { cn } from "@/lib/utils"

// The app's one loading placeholder. Motion is the "breath" (globals.css
// @keyframes derive-skeleton-breath / @utility animate-skeleton): a single quiet
// tonal step between two neutral tokens (--muted ↔ --accent), so the block stays
// solid and present — never an opacity ghost, never a kinetic shimmer. Under
// prefers-reduced-motion the animation is off and the base bg-muted shows.
// Hidden from AT by default (skeletons are decoration — the loading REGION
// announces via role="status" + sr-only text, never the blocks themselves);
// overridable through props for the rare labelled placeholder. Shape doctrine:
// mirror the content's box model (dims, padding, gaps, radius, counts) — never its
// border, background, or shadow (those arrive with the content; omitting them on
// border-box tracks yields zero CLS).
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn("animate-skeleton rounded-md bg-muted motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

export { Skeleton }
