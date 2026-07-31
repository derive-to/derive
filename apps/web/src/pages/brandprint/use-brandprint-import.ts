import { useQueryClient } from "@tanstack/react-query"
import { api } from "@/api"
import { toast } from "@/components/ui/sonner"
import { useAuth } from "@/ctx"
import { openPaywall } from "@/lib/paywall"
import { collectionsQuery, summaryQuery, workspaceSettingsQuery } from "@/lib/queries"
import { paywallReasonFor } from "@/lib/query-client"
import { useApiMutation } from "@/lib/use-api-mutation"
import { nextPersonalBrandprint } from "./personal-brandprint"
import { placeholderFile } from "./profile-placeholder"

// What the intake reports back: how many docs made it in, which files didn't, and
// (when this run wrote the pointer — a fresh create, or a heal that seeded the
// missing placeholder) the fresh server state to sync the caches from.
export type ImportResult = {
  created: boolean
  ok: number
  failed: string[]
  settings?: Awaited<ReturnType<typeof api.updateWorkspaceSettings>>
  profile?: Awaited<ReturnType<typeof api.setProfile>>
}

/** Publish the brand-profile placeholder into the collection and return its short_id —
 *  the fixed address the agent's proposal files against. Callers treat a failure as
 *  "no placeholder yet" (the docs themselves must never be lost to it). */
export async function ensureProfilePlaceholder(collectionId: string): Promise<string> {
  const a = await api.publish(placeholderFile())
  await api.addToCollection(collectionId, a.short_id)
  return a.short_id
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
export function useBrandprintImport(
  scope: "workspace" | "account",
  collectionId: string,
  currentProfileId?: string,
) {
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
        } catch (err) {
          failed.push(f.name)
          // This catch swallows the failure to keep the batch going, but a billing
          // refusal (e.g. storage_exceeded) must still reach the paywall — openPaywall
          // just sets the reason, so firing it again per file is harmless.
          const reason = paywallReasonFor(err)
          if (reason) openPaywall(reason)
        }
      }
      if (created && ok === 0) {
        // Nothing made it in — drop the empty collection so a retry starts clean.
        await api.deleteCollection(target).catch(() => {})
        return { created: false, ok, failed }
      }
      if (scope === "account") {
        // Personal scope is a preferences layer: docs only, never a profile placeholder.
        if (!created) return { created, ok, failed }
        // Merge, don't clobber: a caller with the workspace toggle off must keep that
        // preference when their first personal collection gets created here.
        const profile = await api.setProfile({
          brandprint: nextPersonalBrandprint(me?.brandprint, { collectionId: target }),
        })
        return { created, ok, failed, profile }
      }
      if (created) {
        // Conventions are for the whole team: open the collection to the workspace so
        // members can read the docs (collection access propagates to its contents).
        // Best-effort — MCP delivery reads under the workspace grant either way.
        await api.setCollectionAccess(target, "member").catch(() => {})
      }
      // Seed the brand-profile placeholder on the first run that lacks one, best-effort
      // — losing it costs the hand-off beat, not the docs (a later run heals it).
      const newProfileId = currentProfileId
        ? undefined
        : await ensureProfilePlaceholder(target).catch(() => undefined)
      // Doc-adds to an already-pointed, already-profiled Brandprint change nothing
      // pointer-side, so skip the no-op PATCH.
      if (!created && !newProfileId) return { created, ok, failed }
      const settings = await api.updateWorkspaceSettings({
        brandprint: { collectionId: target, ...(newProfileId ? { profileId: newProfileId } : {}) },
      })
      return { created, ok, failed, settings }
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
