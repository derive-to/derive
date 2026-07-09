import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { api, type OrgSettings } from "@/api"
import { useShell } from "@/components/chrome/shell-context"
import { FormField } from "@/components/shared/form-field"
import { SettingRow } from "@/components/shared/setting-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
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
import { workspaceQuery, workspaceSettingsQuery, workspacesQuery } from "@/lib/queries"
import { snapshot, useApiMutation } from "@/lib/use-api-mutation"
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
  const [delName, setDelName] = useState("")

  // Seed the editable name once the workspace loads (and re-seed on a rename that
  // updates the cache). Focus refetches are off globally, so this won't clobber typing.
  useEffect(() => {
    if (ws) setName(ws.name)
  }, [ws])

  // ?new-workspace=1 auto-opens the create dialog — the deep link the user pod and
  // the share dialog's first-need hint navigate to. One-shot: consumed + stripped
  // (same pattern as the GitHub section's gh_install handshake params).
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.get("new-workspace")) {
      setCreateOpen(true)
      url.searchParams.delete("new-workspace")
      window.history.replaceState(null, "", url)
    }
  }, [])

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
  // must be empty); the primitive surfaces those and we reload on success.
  const del = useApiMutation({
    mutationFn: (id: string) => api.deleteWorkspace(id),
    onSuccess: () => window.location.reload(),
  })
  const onDelete = () => {
    if (ws) del.mutate(ws.id)
  }

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
        <StatusPanel
          tone="danger"
          title="Couldn't load workspace settings"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="workspace-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
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

      {isAdmin && <SharingDefaults />}

      {isAdmin && ws && (
        <StatusPanel
          tone="danger"
          layout="inline"
          title="Delete this workspace"
          description="Permanently delete this workspace. It must be empty (no artifacts), and this can't be undone."
          action={
            <Dialog onOpenChange={(o) => !o && setDelName("")}>
              <DialogTrigger asChild>
                <Button data-testid="workspace-delete" variant="destructive" size="sm">
                  Delete workspace
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete "{ws.name}"?</DialogTitle>
                  <DialogDescription>
                    This permanently deletes the workspace and removes everyone from it. To confirm,
                    type <strong className="font-medium text-foreground">{ws.name}</strong> below.
                  </DialogDescription>
                </DialogHeader>
                <Input
                  data-testid="workspace-delete-confirm"
                  aria-label="Type the workspace name to confirm"
                  value={delName}
                  onChange={(e) => setDelName(e.target.value)}
                  placeholder={ws.name}
                  autoComplete="off"
                />
                <Button
                  data-testid="workspace-delete-go"
                  variant="destructive"
                  onClick={onDelete}
                  loading={del.isPending}
                  disabled={del.isPending || delName.trim() !== ws.name}
                  className="mt-2 w-full"
                >
                  {del.isPending ? "Deleting…" : "Delete this workspace"}
                </Button>
              </DialogContent>
            </Dialog>
          }
        />
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
      <StatusPanel
        layout="inline"
        tone="danger"
        title="Couldn't load sharing defaults"
        action={
          <Button
            variant="outline"
            size="sm"
            data-testid="sharing-defaults-retry"
            onClick={() => refetch()}
          >
            Try again
          </Button>
        }
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
