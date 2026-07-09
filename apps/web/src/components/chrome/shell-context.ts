import { createContext, useContext } from "react"

// Shared chrome state: the command-palette open-state and the workspace actions
// (which reload the page). Lives in its own module so AppShell and NavRail can
// both reach it without a circular import. The nav DATA (summary counts,
// collections, workspaces) now lives in react-query (lib/queries) and is read
// directly via useQuery by the components that need it — no longer threaded
// through here. (Sidebar collapse/drawer state lives in the shadcn
// SidebarProvider — reach it with useSidebar from ui/sidebar.)
export interface ShellValue {
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  /** Immersive page state (the artifact's focus mode): the shell unmounts the nav
   *  rail and mobile top bar entirely — not the icon-strip collapse — and, with no
   *  sidebar peer, the inset mat drops so the page runs edge-to-edge. Page-scoped:
   *  the setter is called on enter/exit and cleaned up on unmount, and the rail's
   *  own open/collapsed preference is never touched. */
  immersive: boolean
  setImmersive: (on: boolean) => void
  switchWorkspace: (id: string) => void
  /** Create + switch; optional invite emails go out before the reload (one flow —
   *  naming a workspace and bringing the team are the same gesture). */
  createWorkspace: (name: string, invites?: string[]) => Promise<void>
  deleteWorkspace: (id: string) => void
}

export const ShellCtx = createContext<ShellValue | null>(null)

export function useShell(): ShellValue {
  const v = useContext(ShellCtx)
  if (!v) throw new Error("useShell must be used within <AppShell>")
  return v
}
