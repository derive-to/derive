import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api, type OrgSettings } from "@/api"
import { useShell } from "@/components/chrome/shell-context"
import { AdminNote } from "@/components/shared/admin-note"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { FormField } from "@/components/shared/form-field"
import { LoadError } from "@/components/shared/load-error"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  SelectMenu,
  SelectMenuContent,
  SelectMenuItem,
  SelectMenuTrigger,
} from "@/components/ui/select-menu"
import { Switch } from "@/components/ui/switch"
import { reloadAfterWorkspaceChange } from "@/lib/persist"
import { workspaceQuery, workspaceSettingsQuery, workspacesQuery } from "@/lib/queries"
import { snapshot, useApiMutation } from "@/lib/use-api-mutation"
import { useOneShotParams } from "@/lib/use-one-shot-params"
import { SettingsSection } from "./settings-section"

// Workspace identity + lifecycle: rename it, spin up a new one, or (admins only)
// delete an empty one. Membership lives in its own Members section. Rename +
// delete are admin-gated by the server; we mirror the gate in the UI and surface
// the server's guard messages.
export function GeneralSection() {
  const { createWorkspace } = useShell()
  const qc = useQueryClient()
  const { data: ws, isError, refetch } = useQuery(workspaceQuery())
  const [name, setName] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState("")
  const [newInvites, setNewInvites] = useState("")
  const [deleteOpen, setDeleteOpen] = useState(false)

  // Seed the editable name once the workspace loads (and re-seed on a rename that
  // updates the cache). Focus refetches are off globally, so this won't clobber typing.
  useEffect(() => {
    if (ws) setName(ws.name)
  }, [ws])

  // ?new-workspace=1 auto-opens the create dialog — the deep link the user pod and
  // the share dialog's first-need hint navigate to. One-shot: consumed + stripped.
  const { "new-workspace": newWorkspaceParam } = useOneShotParams("new-workspace")
  useEffect(() => {
    if (newWorkspaceParam) setCreateOpen(true)
  }, [newWorkspaceParam])

  const isAdmin = ws?.role === "owner"

  // Create a brand-new workspace — a deliberate, infrequent action that lives
  // here rather than in the rail's switcher. One flow: name it and (optionally)
  // invite the team in the same gesture; createWorkspace switches + reloads.
  // createWorkspace switches + reloads on success, so there's no onSuccess to run — the
  // primitive just carries the pending state and surfaces a failure.
  const create = useApiMutation({
    mutationFn: ({ name, invites }: { name: string; invites: string[] }) =>
      createWorkspace(name, invites),
  })
  const createSubmit = () => {
    const t = newName.trim()
    if (!t || create.isPending) return
    // Loose parse: split on commas/whitespace, keep anything @-shaped. The server
    // validates properly; a stray non-email token is dropped rather than blocking the
    // create (invites are re-sendable from Members).
    const invites = newInvites
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter((s) => s.includes("@"))
    create.mutate({ name: t, invites })
  }

  const rename = useApiMutation({
    mutationFn: (n: string) => api.renameWorkspace(n),
    onSuccess: (r) =>
      qc.setQueryData(workspaceQuery().queryKey, (w) => (w ? { ...w, name: r.name } : w)),
    // Invalidate so the switcher + rail pick up the new name immediately.
    invalidate: [workspacesQuery().queryKey],
    success: "Workspace renamed",
  })
  const saveName = () => {
    const n = name.trim()
    if (n && n !== ws?.name) rename.mutate(n)
  }

  // Delete the active workspace. The server enforces the guards (Admin, not your last,
  // must be empty); the primitive surfaces those and we reload on success. The server
  // switches the cookie to another workspace, so the reload rides the workspace-change
  // helper — a plain reload would restore the deleted workspace's persisted cache.
  const del = useApiMutation({
    mutationFn: (id: string) => api.deleteWorkspace(id),
    onSuccess: () => reloadAfterWorkspaceChange(),
  })

  return (
    <SettingsSection
      title="General"
      description="Your workspace's name and lifecycle."
      actions={
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="workspace-new" variant="outline" size="sm">
              New workspace
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create a workspace</DialogTitle>
              <DialogDescription>
                A shared library for a team. You'll be the owner.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              value={newName}
              placeholder="Acme Marketing"
              aria-label="New workspace name"
              data-testid="workspace-new-input"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createSubmit()}
              maxLength={80}
            />
            {/* Naming a workspace and bringing the team are one gesture — the
                invites are optional, but asking here means nobody has to discover
                Members as a separate second step. */}
            <Input
              value={newInvites}
              placeholder="Invite teammates — emails, comma-separated (optional)"
              aria-label="Invite teammates by email"
              data-testid="workspace-new-invites"
              onChange={(e) => setNewInvites(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createSubmit()}
              className="mt-2"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button
                data-testid="workspace-new-cancel"
                variant="ghost"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                onClick={createSubmit}
                disabled={!newName.trim() || create.isPending}
                loading={create.isPending}
                data-testid="workspace-create-submit"
              >
                {create.isPending ? "Creating…" : "Create"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      }
    >
      {isError ? (
        <LoadError
          title="Couldn’t load workspace settings"
          testId="workspace-retry"
          onRetry={() => refetch()}
        />
      ) : (
        <FormField label="Workspace name" htmlFor="workspace-name" className="max-w-sm">
          <div className="flex gap-2">
            <Input
              id="workspace-name"
              data-testid="workspace-name"
              aria-label="Workspace name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!isAdmin || !ws}
              maxLength={80}
              placeholder="My Workspace"
              className="flex-1"
            />
            {isAdmin && (
              <Button
                data-testid="workspace-save"
                variant="default"
                size="sm"
                onClick={saveName}
                loading={rename.isPending}
                disabled={rename.isPending || !name.trim() || name.trim() === ws?.name}
              >
                {rename.isPending ? "Saving…" : "Save"}
              </Button>
            )}
          </div>
        </FormField>
      )}

      {isAdmin ? <SharingDefaults /> : <AdminNote can="change workspace settings" />}

      {isAdmin && ws && (
        <>
          <SettingsGroup title="Danger zone">
            <SettingRow
              label={<span className="font-medium text-destructive">Delete this workspace</span>}
              description="Permanently delete this workspace. It must be empty (no artifacts), and this can't be undone."
            >
              <Button
                data-testid="workspace-delete"
                variant="destructive-ghost"
                size="sm"
                onClick={() => setDeleteOpen(true)}
              >
                Delete workspace
              </Button>
            </SettingRow>
          </SettingsGroup>
          <ConfirmDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title={`Delete "${ws.name}"?`}
            description="This permanently deletes the workspace and removes everyone from it."
            confirmLabel="Delete workspace"
            confirmTestId="workspace-delete-go"
            confirmPhrase={ws.name}
            onConfirm={async () => {
              await del.mutateAsync(ws.id)
            }}
          />
        </>
      )}
    </SettingsSection>
  )
}

// Sharing defaults — where an agent (MCP) publish lands when it doesn't say.
// The select applies instantly with an optimistic cache write (the toggle
// contract from Integrations), reverting on error. Admin-gated by the server;
// the caller renders this only for admins.
function SharingDefaults() {
  const qc = useQueryClient()
  const { data: settings, isError, refetch } = useQuery(workspaceSettingsQuery())

  const update = useApiMutation({
    mutationFn: (patch: Partial<OrgSettings>) => api.updateWorkspaceSettings(patch),
    optimistic: (patch, client) => {
      const qk = workspaceSettingsQuery().queryKey
      const rollback = snapshot(client, qk)
      client.setQueryData(qk, (prev) => (prev ? { ...prev, ...patch } : prev))
      return rollback
    },
    onSuccess: (s) => qc.setQueryData(workspaceSettingsQuery().queryKey, s),
  })
  const set = <K extends keyof OrgSettings>(key: K, next: OrgSettings[K]) => {
    update.mutate({ [key]: next } as Partial<OrgSettings>)
  }

  if (isError)
    return (
      <LoadError
        layout="inline"
        title="Couldn’t load sharing defaults"
        testId="sharing-defaults-retry"
        onRetry={() => refetch()}
      />
    )
  if (!settings) return null
  return (
    <SettingsGroup>
      <SettingRow
        label="Workspace access"
        description="Whether a freshly published artifact is open to the whole workspace (at each member's role) or invite-only. Changing this never touches existing artifacts."
      >
        <SelectMenu
          value={settings.defaultWorkspaceAccess}
          onValueChange={(v) =>
            set("defaultWorkspaceAccess", v as OrgSettings["defaultWorkspaceAccess"])
          }
        >
          <SelectMenuTrigger
            aria-label="Default workspace access"
            data-testid="default-workspace-access"
          >
            {WORKSPACE_ACCESS_LABELS[settings.defaultWorkspaceAccess] ??
              settings.defaultWorkspaceAccess}
          </SelectMenuTrigger>
          <SelectMenuContent>
            <SelectMenuItem value="member">Everyone in the workspace</SelectMenuItem>
            <SelectMenuItem value="none">Invite-only</SelectMenuItem>
          </SelectMenuContent>
        </SelectMenu>
      </SettingRow>
      <SettingRow
        label="New artifact links"
        description="What merely holding a freshly published artifact's URL grants anyone (none = no world link). Changing this never touches existing artifacts."
      >
        <SelectMenu
          value={settings.defaultLinkRole}
          onValueChange={(v) => set("defaultLinkRole", v as OrgSettings["defaultLinkRole"])}
        >
          <SelectMenuTrigger aria-label="Default link grant" data-testid="default-link-role">
            {LINK_ROLE_LABELS[settings.defaultLinkRole] ?? settings.defaultLinkRole}
          </SelectMenuTrigger>
          <SelectMenuContent>
            <SelectMenuItem value="none">No link</SelectMenuItem>
            <SelectMenuItem value="viewer">Can view</SelectMenuItem>
            <SelectMenuItem value="commenter">Can comment</SelectMenuItem>
            <SelectMenuItem value="editor">Can edit</SelectMenuItem>
          </SelectMenuContent>
        </SelectMenu>
      </SettingRow>
      <SettingRow
        label="Listed by default"
        description="Where a freshly published artifact surfaces for discovery. None keeps it out of every feed until someone promotes it."
      >
        <SelectMenu
          value={settings.defaultListed}
          onValueChange={(v) => set("defaultListed", v as OrgSettings["defaultListed"])}
        >
          <SelectMenuTrigger aria-label="Default listing" data-testid="default-listed">
            {LISTED_LABELS[settings.defaultListed] ?? settings.defaultListed}
          </SelectMenuTrigger>
          <SelectMenuContent>
            <SelectMenuItem value="none">Nowhere</SelectMenuItem>
            <SelectMenuItem value="workspace">Workspace library</SelectMenuItem>
            <SelectMenuItem value="public">Public directory</SelectMenuItem>
          </SelectMenuContent>
        </SelectMenu>
      </SettingRow>
      <SettingRow
        htmlFor="toggle-white-label"
        label="White-label shared pages"
        description="Hide the Made-with-Derive mark on public artifacts and embeds, and allow the bare embed (?chrome=none). A Team-plan feature once billing arrives; free during the beta."
      >
        <Switch
          id="toggle-white-label"
          data-testid="toggle-white-label"
          checked={settings.whiteLabel}
          onCheckedChange={(next) => set("whiteLabel", next)}
        />
      </SettingRow>
    </SettingsGroup>
  )
}

const LINK_ROLE_LABELS: Record<string, string> = {
  none: "No link",
  viewer: "Can view",
  commenter: "Can comment",
  editor: "Can edit",
}

const WORKSPACE_ACCESS_LABELS: Record<string, string> = {
  member: "Everyone in the workspace",
  none: "Invite-only",
}

const LISTED_LABELS: Record<string, string> = {
  none: "Nowhere",
  workspace: "Workspace library",
  public: "Public directory",
}
