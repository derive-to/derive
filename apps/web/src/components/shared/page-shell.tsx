import type { ReactNode, Ref } from "react"
import { cn } from "@/lib/utils"

// The one page-container geometry. The shell's SidebarInset is overflow-hidden,
// so every routed page owns its scroll: PageShell renders the scroll wrapper
// (min-h-0 flex-1 overflow-y-auto — scrollbar at the pane edge, not the measure
// column's) around the measure element (max-width + mx-auto + padding), per the
// two-element section pattern.
//
// The rhythm (4px grid, shared by every page so route changes never shift the
// header): 32px sides/top on desktop — exactly 2× the nav rail's 16px body
// gutter (sidebar body p-4), so the content edge reads as a deliberate step of
// the rail's rhythm rather than an unrelated inset; 20px below `sm` (the mobile
// navbar already spends vertical room, so the top stays compact); 64px bottom
// so a scrolled page never ends flush at the viewport edge. RouteSkeleton
// renders PageShell itself, so the pending shimmer inherits this geometry.
export function PageShell({
  scrollRef,
  width = "reading",
  className,
  children,
}: {
  /** The scroll container ref — the library's virtualizer windows against it. */
  scrollRef?: Ref<HTMLDivElement>
  /** `reading` = max-w-3xl (settings, people, profile); `wide` = max-w-5xl (library). */
  width?: "reading" | "wide"
  /** Extra classes for the measure element (e.g. a flex column with gaps). */
  className?: string
  children: ReactNode
}) {
  return (
    // scrollbar-gutter keeps the measure column identical whether or not this
    // route scrolls (classic-scrollbar platforms would otherwise shift the
    // header between routes — the exact drift the shared rhythm exists to stop).
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      <div
        className={cn(
          "mx-auto w-full px-5 pt-5 pb-16 sm:px-8 sm:pt-8",
          width === "wide" ? "max-w-5xl" : "max-w-3xl",
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}
