import { createContext, useContext } from "react"
import type { Collection, Workspaces } from "@/api"

export type Summary = {
  total: number
  favorites: number
  tags: { tag: string; count: number }[]
  workspace: string
}

// Shared chrome state: the nav rail's collapse + mobile drawer, the nav data
// (summary counts, collections, workspaces) fetched once by <AppShell>, and the
// workspace actions. Lives in its own module so AppShell and NavRail can both
// reach it without a circular import.
export interface ShellValue {
  collapsed: boolean
  toggleCollapsed: () => void
  drawerOpen: boolean
  setDrawerOpen: (o: boolean) => void
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  summary: Summary | null
  collections: Collection[]
  workspaces: Workspaces | null
  refreshSummary: () => void
  refreshCollections: () => void
  switchWorkspace: (id: string) => void
  createWorkspace: (name: string) => void
  // The top bar's right-side region. AppShell is mounted once around the router
  // Outlet, so a page can't pass top-bar actions as a prop — it portals them
  // into this slot instead (null until the bar has mounted).
  topBarSlot: HTMLElement | null
}

export const ShellCtx = createContext<ShellValue | null>(null)

export function useShell(): ShellValue {
  const v = useContext(ShellCtx)
  if (!v) throw new Error("useShell must be used within <AppShell>")
  return v
}
