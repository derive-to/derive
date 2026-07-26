import { cn } from "@/lib/utils"

// The app's only spinner. Tokenized ring (border) with an ink head; uses
// Tailwind's animate-spin so there's no bespoke keyframe to carry. Announced as
// a polite status by default; pass role="presentation" (and aria-label
// undefined) when a live parent already announces the loading state, so screen
// readers hear it once.
//   size — "sm" (inline 16px, thinner ring: in-field / in-glyph / on-button slots),
//          "default" (22px standalone placeholder), "lg" (28px boot moments:
//          render-stage, app boot).
//   tone — "default" (token ring + border-t-primary ink head, the standalone look);
//          "current" (currentColor ring/head, so it reads on a filled/inherited-ink
//          surface — a fixed ink head is invisible on the primary fill; this is what
//          Button's busy state uses).
export function Spinner({
  size = "default",
  tone = "default",
  className,
  ...props
}: React.ComponentProps<"div"> & {
  size?: "sm" | "default" | "lg"
  tone?: "default" | "current"
}) {
  return (
    <div
      role="status"
      aria-label="Loading"
      {...props}
      className={cn(
        "animate-spin rounded-full",
        size === "sm"
          ? "size-4 border-[1.5px]"
          : size === "lg"
            ? "size-7 border-2"
            : "size-[22px] border-2",
        tone === "current"
          ? "border-current/25 border-t-current"
          : "border-border border-t-primary",
        className,
      )}
    />
  )
}

// Full-height centered spinner — the standard "page is loading" placeholder.
export function CenteredSpinner({ className }: { className?: string }) {
  return (
    <div className={cn("grid h-full place-items-center", className)}>
      <Spinner />
    </div>
  )
}
