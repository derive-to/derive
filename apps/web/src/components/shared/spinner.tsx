import { cn } from "@/lib/utils"

// The app's only spinner. Tokenized ring (border) with an accent head; uses
// Tailwind's animate-spin so there's no bespoke keyframe to carry. Announced as
// a polite status by default; pass role="presentation" (and aria-label
// undefined) when a live parent already announces the loading state, so screen
// readers hear it once. `size="sm"` is the inline 16px form with a thinner ring
// (in-field / in-glyph slots); "default" is the standalone placeholder.
export function Spinner({
  size = "default",
  className,
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      {...props}
      className={cn(
        size === "sm"
          ? "size-4 animate-spin rounded-full border-[1.5px] border-border border-t-primary"
          : "size-[22px] animate-spin rounded-full border-2 border-border border-t-primary",
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
