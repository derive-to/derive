import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/ctx"
import { workspaceSettingsQuery } from "@/lib/queries"

/**
 * The collection ids the caller's Brandprints point at. Those collections are
 * managed on /brandprint, so the general collection surfaces (rail, command
 * palette, organize dialogs) hide them — one home for the docs and their options,
 * not two. The client can always name every one it could otherwise see: your own
 * personal pointer rides the session, the workspace pointer is member-readable
 * settings, and a teammate's personal Brandprint collection is invite-only, so it
 * never lists for you in the first place.
 */
export function useBrandprintCollectionIds(): Set<string> {
  const { me } = useAuth()
  // staleTime Infinity — shared with the Brandprint page and Settings, so this
  // costs one fetch per session, not one per surface.
  const { data: settings } = useQuery({ ...workspaceSettingsQuery(), enabled: !!me })
  const ids = new Set<string>()
  const ws = settings?.brandprint?.collectionId
  const mine = me?.brandprint?.collectionId
  if (ws) ids.add(ws)
  if (mine) ids.add(mine)
  return ids
}
