import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// Dashed-border placeholder for an empty list/grid. Generic on purpose so every
// surface (library, collections, members, comments) shares one look.
export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  )
}
