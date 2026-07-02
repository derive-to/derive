import { cn } from "@/lib/utils"

// The pulse is opacity movement (allowed motion, unlike hover color transitions);
// under reduced motion it falls back to a static muted block.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

export { Skeleton }
