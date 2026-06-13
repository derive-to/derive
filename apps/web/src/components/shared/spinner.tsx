import { cn } from "@/lib/utils"

// The app's only spinner. Tokenized ring (border) with an accent head; uses
// Tailwind's animate-spin so there's no bespoke keyframe to carry.
export function Spinner({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn(
        "size-[22px] animate-spin rounded-full border-2 border-border border-t-primary",
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
