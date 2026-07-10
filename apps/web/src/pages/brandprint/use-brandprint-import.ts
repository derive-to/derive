import { useQueryClient } from "@tanstack/react-query"
import { api } from "@/api"
import { toast } from "@/components/ui/sonner"
import { useAuth } from "@/ctx"
import { collectionsQuery, summaryQuery, workspaceSettingsQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"

// What the intake reports back: how many docs made it in, which files didn't, and
// (when it created the collection and set the pointer itself) the fresh server
// state to sync the caches from.
export type ImportResult = {
  created: boolean
  ok: number
  failed: string[]
  settings?: Awaited<ReturnType<typeof api.updateWorkspaceSettings>>
  profile?: Awaited<ReturnType<typeof api.setProfile>>
}

/**
 * The Brandprint intake: publish each given file, gather them into the pointed
 * collection (creating one when `collectionId` is empty), and set the scope's
 * pointer. Composed from existing endpoints inside one governed mutation (the
 * welcome.tsx save pattern); shared by the Brandprint section's create dialog and
 * onboarding's Brandprint step. Per-file failures don't abort the batch; the
 * pointer is only set once at least one doc made it in, so a total failure leaves
 * nothing half-set.
 */
export function useBrandprintImport(scope: "workspace" | "account", collectionId: string) {
  const qc = useQueryClient()
  const { me, setMe } = useAuth()
  return useApiMutation({
    mutationFn: async (files: File[]): Promise<ImportResult> => {
      let target = collectionId
      let created = false
      if (!target) {
        const col = await api.createCollection(
          scope === "workspace" ? "Brandprint" : "Personal Brandprint",
        )
        target = col.id
        created = true
      }
      let ok = 0
      const failed: string[] = []
      for (const f of files) {
        try {
          // No title field — the server derives one from the doc's heading or filename.
          const a = await api.publish(f)
          await api.addToCollection(target, a.short_id)
          ok++
        } catch {
          failed.push(f.name)
        }
      }
      if (created && ok === 0) {
        // Nothing made it in — drop the empty collection so a retry starts clean.
        await api.deleteCollection(target).catch(() => {})
        return { created: false, ok, failed }
      }
      if (!created) return { created, ok, failed }
      if (scope === "workspace") {
        // Conventions are for the whole team: open the collection to the workspace so
        // members can read the docs (collection access propagates to its contents).
        // Best-effort — MCP delivery reads under the workspace grant either way.
        await api.setCollectionAccess(target, "member").catch(() => {})
        const settings = await api.updateWorkspaceSettings({
          brandprint: { collectionId: target },
        })
        return { created, ok, failed, settings }
      }
      const profile = await api.setProfile({ brandprint: { collectionId: target } })
      return { created, ok, failed, profile }
    },
    success: (r) =>
      r.ok === 0
        ? undefined
        : r.created
          ? `Brandprint created with ${r.ok} doc${r.ok === 1 ? "" : "s"}`
          : `${r.ok} doc${r.ok === 1 ? "" : "s"} added to your Brandprint`,
    onSuccess: (r) => {
      if (r.settings) qc.setQueryData(workspaceSettingsQuery().queryKey, r.settings)
      if (r.profile && me) setMe({ ...me, brandprint: r.profile.brandprint })
      if (r.failed.length > 0) {
        // The mutation itself settled fine, so the global safety net stays quiet —
        // name the files that fell out of the batch here.
        const msg = `Couldn't publish ${r.failed.join(", ")}`
        if (r.ok === 0)
          toast.error(msg) // mutation-ignore: per-file outcome, not a rejected mutation
        else toast.warning(msg)
      }
    },
    invalidate: [collectionsQuery().queryKey, summaryQuery().queryKey, ["artifacts"]],
  })
}

/** Wrap pasted notes as the markdown doc the intake publishes; the filename carries
 *  the title (slashes would read as a path, so swap them out). */
export const notesAsDoc = (notes: string, title?: string) =>
  new File([notes], `${(title?.trim() || "Brand notes").replace(/[\\/]/g, "-")}.md`, {
    type: "text/markdown",
  })
