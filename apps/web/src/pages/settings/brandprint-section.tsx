import { useQuery, useQueryClient } from "@tanstack/react-query"
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
import { useAuth } from "@/ctx"
import { collectionsQuery, workspaceQuery, workspaceSettingsQuery } from "@/lib/queries"
import { snapshot, useApiMutation } from "@/lib/use-api-mutation"

/**
 * Point this scope's Brandprint at a conventions collection — the docs/skills that
 * describe how artifacts should be built here. An agent connected over MCP resolves
 * workspace ⊕ account (account wins) and reads those docs as Brandprint context.
 * Workspace scope saves to the workspace settings (Admin only — mirrors the other
 * workspace defaults in General); account scope saves to your own profile. Clearing
 * sets the pointer back to none. Theme tokens are a later phase; this is the
 * collection pointer only.
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

  const updateWorkspace = useApiMutation({
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

  const title = scope === "workspace" ? "Workspace Brandprint" : "Your Brandprint"
  const description =
    scope === "workspace"
      ? "The conventions collection agents read before building artifacts in this workspace."
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
  const collectionId =
    scope === "workspace"
      ? (settings?.brandprint?.collectionId ?? "")
      : (me?.brandprint?.collectionId ?? "")
  const ready = scope === "workspace" ? !!settings : true
  const disabled =
    !ready ||
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
    </SettingsGroup>
  )
}
