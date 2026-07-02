import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// The artifact format tag (MD · HTML · Deck · Site · Skill). A deliberately crisp,
// monospace label — the squarer counterpart to the pill-shaped <Badge>, which is
// reserved for status.
export function TypeTag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "rounded-[5px] border border-border-soft bg-secondary px-1.5 py-px font-mono text-2xs text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  )
}
