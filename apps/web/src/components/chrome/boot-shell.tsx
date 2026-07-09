import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppBoot } from "../shared/app-boot"
import { RailSkeleton } from "./nav-rail"
import { ShellCtx, type ShellValue } from "./shell-context"

// The chrome actions a static silhouette never fires — a no-op ShellValue so
// RailSkeleton's RailHeader can call useShell() without mounting the real AppShell.
const NOOP_SHELL: ShellValue = {
  paletteOpen: false,
  setPaletteOpen: () => {},
  switchWorkspace: () => {},
  createWorkspace: () => Promise.resolve(),
  deleteWorkspace: () => {},
}

// The pre-hydration boot frame: what the SPA prerender bakes into the static shell
// and what __root's hydration gate shows on the first client paint. It renders the
// SAME sidebar frame (RailSkeleton inside the real SidebarProvider + inset) that
// AppShell settles into a tick later, so the rail silhouette is continuous across
// hydration — no centered-logo → app-layout jump. Pure by construction: the providers
// read no browser state (SidebarProvider's cookie write is removed; useIsMobile is
// SSR-safe), so it prerenders and hydrates identically. RailSkeleton is already in the
// eager bundle (AppShell → NavRail), so reusing it here adds nothing and can't drift.
//
// Both frames sit in the DOM; the pre-paint boot script (see __root) sets data-boot on
// <html> from the entry path and CSS (globals.css) reveals exactly one — the rail for
// app routes, the neutral mark for chromeless / bare-artifact entries, where AppShell's
// own first paint is chrome-light. Rendering the same DOM regardless of path is what
// keeps hydration clean; the attribute only drives which one is visible.
export function BootShell() {
  return (
    <>
      <div data-slot="boot-rail" className="contents">
        <ShellCtx.Provider value={NOOP_SHELL}>
          <TooltipProvider>
            <SidebarProvider className="isolate h-full min-h-0">
              <RailSkeleton />
              <SidebarInset className="min-h-0 min-w-0 overflow-hidden" />
            </SidebarProvider>
          </TooltipProvider>
        </ShellCtx.Provider>
      </div>
      <div data-slot="boot-mark" className="h-full">
        <AppBoot />
      </div>
    </>
  )
}
