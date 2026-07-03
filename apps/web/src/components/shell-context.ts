import { createContext, useContext } from "react"
import type { Collection, Workspaces } from "@/api"

export type Summary = {
  total: number
  favorites: number
  tags: { tag: string; count: number }[]
  workspace: string
}

// Shared chrome state: the command palette, the nav data (summary counts,
// collections, workspaces) fetched once by <AppShell>, and the workspace
// actions. Lives in its own module so AppShell and NavRail can both reach it
// without a circular import. (Sidebar collapse/drawer state lives in the shadcn
// SidebarProvider — reach it with useSidebar from ui/sidebar.)
export interface ShellValue {
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  summary: Summary | null
  collections: Collection[]
  workspaces: Workspaces | null
  refreshSummary: () => void
  refreshCollections: () => void
  refreshWorkspaces: () => void
  switchWorkspace: (id: string) => void
  createWorkspace: (name: string) => void
  deleteWorkspace: (id: string) => void
}

export const ShellCtx = createContext<ShellValue | null>(null)

export function useShell(): ShellValue {
  const v = useContext(ShellCtx)
  if (!v) throw new Error("useShell must be used within <AppShell>")
  return v
}
