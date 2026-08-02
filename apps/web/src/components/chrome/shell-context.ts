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
  /**
   * Ask the agent, from anywhere: the rail row, a page's Ask button, the ⌘K palette itself.
   *
   * ONE action with two renderings, and no caller chooses between them. On a desktop it opens the
   * palette into its answer view, which floats above the page so nothing behind it moves; on a
   * phone a conversation does not fit in a modal, so the same ask goes to /chat carrying the
   * question. That is why no call site holds a mobile branch — they all say "ask this", and the
   * viewport decides where the answer appears.
   */
  openAssistant: (text?: string) => void
  /** The question a surface handed over, for the palette to pick up on open. */
  pendingAsk: string | null
  clearPendingAsk: () => void
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
