import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Upload } from "lucide-react"
import { useRef } from "react"
import { api, type OrgSettings } from "@/api"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Button } from "@/components/ui/button"
import {
  SelectMenu,
  SelectMenuContent,
  SelectMenuItem,
  SelectMenuTrigger,
} from "@/components/ui/select-menu"
import { toast } from "@/components/ui/sonner"
import { useAuth } from "@/ctx"
import {
  collectionsQuery,
  summaryQuery,
  workspaceQuery,
  workspaceSettingsQuery,
} from "@/lib/queries"
import { snapshot, useApiMutation } from "@/lib/use-api-mutation"

// What the one-click intake reports back: how many docs made it in, which files
// didn't, and (when it created the collection and set the pointer itself) the fresh
// server state to sync the caches from.
type ImportResult = {
  created: boolean
  ok: number
  failed: string[]
  settings?: Awaited<ReturnType<typeof api.updateWorkspaceSettings>>
  profile?: Awaited<ReturnType<typeof api.setProfile>>
}

/**
 * Point this scope's Brandprint at a conventions collection — the docs/skills that
 * describe how artifacts should be built here. An agent connected over MCP resolves
 * workspace ⊕ account (account wins) and reads those docs as Brandprint context.
 * Workspace scope saves to the workspace settings (Admin only — mirrors the other
 * workspace defaults in General); account scope saves to your own profile. Clearing
 * sets the pointer back to none. Theme tokens are a later phase; this is the
 * collection pointer only.
 *
 * Setup is also one click: "Upload docs" publishes the picked files, gathers them
 * into the pointed collection (creating one when the Brandprint is empty), and sets
 * the pointer — so nobody has to publish from the library, build a collection by
 * hand, and come back here to select it.
 */
export function BrandprintSection({ scope }: { scope: "workspace" | "account" }) {
  const qc = useQueryClient()
  const { me, setMe } = useAuth()
  const {
    data: collections,
    isError: collectionsError,
    refetch: refetchCollections,
  } = useQuery(collectionsQuery())
  // Shared cache entry with the General section (staleTime Infinity) — mounting
  // this here doesn't add a second network request when General is also open.
  const { data: ws } = useQuery({ ...workspaceQuery(), enabled: scope === "workspace" })
  const {
    data: settings,
    isError: settingsError,
    refetch: refetchSettings,
  } = useQuery({
    ...workspaceSettingsQuery(),
    enabled: scope === "workspace",
  })

  const collectionId =
    scope === "workspace"
      ? (settings?.brandprint?.collectionId ?? "")
      : (me?.brandprint?.collectionId ?? "")

  const updateWorkspace = useApiMutation({
    // The generated OrgSettings types brandprint non-nullable, but the PATCH takes null to
    // clear it — widen to Partial so the clear case type-checks.
    mutationFn: (collectionId: string) =>
      api.updateWorkspaceSettings({
        brandprint: collectionId ? { collectionId } : null,
      } as Partial<OrgSettings>),
    optimistic: (collectionId, client) => {
      const qk = workspaceSettingsQuery().queryKey
      const rollback = snapshot(client, qk)
      client.setQueryData(qk, (prev) =>
        prev
          ? {
              ...prev,
              brandprint: collectionId ? { ...prev.brandprint, collectionId } : undefined,
            }
          : prev,
      )
      return rollback
    },
    onSuccess: (s) => qc.setQueryData(workspaceSettingsQuery().queryKey, s),
    success: "Brandprint updated",
  })
  const updateAccount = useApiMutation({
    mutationFn: (collectionId: string) =>
      api.setProfile({ brandprint: collectionId ? { collectionId } : null }),
    onSuccess: (r) => {
      if (me) setMe({ ...me, brandprint: r.brandprint })
    },
    success: "Brandprint updated",
  })

  // The one-click intake: publish each picked file, gather them into the pointed
  // collection (creating one when the Brandprint is empty), and set the pointer.
  // Composed from existing endpoints inside one governed mutation (the welcome.tsx
  // save pattern). Per-file failures don't abort the batch; the pointer is only set
  // once at least one doc made it in, so a total failure leaves nothing half-set.
  const fileRef = useRef<HTMLInputElement>(null)
  const importDocs = useApiMutation({
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
        // The batch itself succeeded (governed above); this names which FILES didn't
        // make it in — a per-item outcome report the primitive can't know about.
        const msg = `Couldn't publish ${r.failed.join(", ")}`
        if (r.ok === 0)
          toast.error(msg) // mutation-ignore: per-file outcome, not a rejected mutation
        else toast.warning(msg)
      }
    },
    invalidate: [collectionsQuery().queryKey, summaryQuery().queryKey, ["artifacts"]],
  })
  const pickFiles = (list: FileList | null) => {
    const files = list ? [...list] : []
    if (files.length > 0) importDocs.mutate(files)
  }

  const title = scope === "workspace" ? "Workspace Brandprint" : "Your Brandprint"
  const description =
    scope === "workspace"
      ? "Your team's voice and design conventions: the tone, structure, and visual style your work should follow. Agents read these docs before building anything in this workspace, so everything they produce stays on brand."
      : "Your personal conventions, layered over the workspace's when an agent acts as you (yours wins)."

  if (scope === "account" && !me) return null

  // A failed read leaves the picker unable to show its current value (workspace scope)
  // or its options (both) — surface it with a retry rather than degrade to a silent
  // "None", mirroring the sibling sections (General's SharingDefaults reads this same
  // workspace-settings query the same way). The disabled workspace-settings query on
  // the account scope never errors, so account scope only reacts to a collections failure.
  const loadError = collectionsError || (scope === "workspace" && settingsError)
  const retry = () => {
    refetchCollections()
    if (scope === "workspace") refetchSettings()
  }
  if (loadError)
    return (
      <SettingsGroup title={title} description={description}>
        <StatusPanel
          layout="inline"
          tone="danger"
          title="Couldn't load your Brandprint"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid={`brandprint-retry-${scope}`}
              onClick={retry}
            >
              Try again
            </Button>
          }
        />
      </SettingsGroup>
    )

  const isAdmin = ws?.role === "owner"
  const ready = scope === "workspace" ? !!settings : true
  const disabled =
    !ready ||
    importDocs.isPending ||
    (scope === "workspace" ? !isAdmin || updateWorkspace.isPending : updateAccount.isPending)
  const save = (next: string) =>
    scope === "workspace" ? updateWorkspace.mutate(next) : updateAccount.mutate(next)
  const selected = collections?.find((c) => c.id === collectionId)?.title

  return (
    <SettingsGroup title={title} description={description}>
      <SettingRow label="Conventions collection">
        <SelectMenu value={collectionId} onValueChange={save}>
          <SelectMenuTrigger
            aria-label="Conventions collection"
            data-testid={`brandprint-collection-${scope}`}
            disabled={disabled}
          >
            {!ready ? "Loading…" : collectionId ? (selected ?? "…") : "None"}
          </SelectMenuTrigger>
          <SelectMenuContent>
            <SelectMenuItem value="">None</SelectMenuItem>
            {(collections ?? []).map((c) => (
              <SelectMenuItem key={c.id} value={c.id}>
                {c.title}
              </SelectMenuItem>
            ))}
          </SelectMenuContent>
        </SelectMenu>
      </SettingRow>
      <SettingRow
        label="Upload documents"
        description={
          collectionId
            ? "New docs publish straight into this Brandprint's collection."
            : "Pick style guides, tone notes, or templates. Derive publishes them, gathers them into a new collection, and points your Brandprint at it."
        }
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".md,.markdown,.txt,.html,.htm"
          className="hidden"
          data-testid={`brandprint-upload-input-${scope}`}
          onChange={(e) => {
            pickFiles(e.target.files)
            // Reset so re-picking the same file fires change again.
            e.target.value = ""
          }}
        />
        <Button
          variant="outline"
          size="sm"
          data-testid={`brandprint-upload-${scope}`}
          disabled={disabled}
          loading={importDocs.isPending}
          onClick={() => fileRef.current?.click()}
        >
          <Upload /> {importDocs.isPending ? "Uploading…" : "Upload docs"}
        </Button>
      </SettingRow>
    </SettingsGroup>
  )
}
