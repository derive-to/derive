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
import { toast } from "@/components/ui/sonner"
import { workspaceQuery, workspaceSettingsQuery, workspacesQuery } from "@/lib/queries"
import { SettingsSection } from "./settings-section"

// Workspace identity + lifecycle: rename it, spin up a new one, or (admins only)
// delete an empty one. Membership lives in its own Members section. Rename +
// delete are admin-gated by the server; we mirror the gate in the UI and surface
// the server's guard messages.
export function GeneralSection() {
  const { createWorkspace } = useShell()
  const qc = useQueryClient()
  const { data: ws } = useQuery(workspaceQuery())
  const [name, setName] = useState("")
  const [savingName, setSavingName] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState("")
  const [newInvites, setNewInvites] = useState("")
  const [creating, setCreating] = useState(false)
  const [delName, setDelName] = useState("")
  const [deleting, setDeleting] = useState(false)

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
  const createSubmit = async () => {
    const t = newName.trim()
    if (!t || creating) return
    // Loose parse: split on commas/whitespace, keep anything @-shaped. The server
    // validates properly; a stray non-email token is dropped rather than blocking
    // the create (invites are re-sendable from Members).
    const invites = newInvites
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter((s) => s.includes("@"))
    setCreating(true)
    try {
      await createWorkspace(t, invites)
    } catch (e) {
      toast.error((e as Error).message)
      setCreating(false)
    }
  }

  const saveName = async () => {
    const n = name.trim()
    if (!n || n === ws?.name) return
    setSavingName(true)
    try {
      const r = await api.renameWorkspace(n)
      qc.setQueryData(workspaceQuery().queryKey, (w) => (w ? { ...w, name: r.name } : w))
      // Invalidate so the switcher + rail pick up the new name immediately.
      qc.invalidateQueries({ queryKey: workspacesQuery().queryKey })
      toast.success("Workspace renamed")
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSavingName(false)
    }
  }

  // Delete the active workspace. The server enforces the guards (Admin, not your
  // last, must be empty); we surface those and reload on success.
  const onDelete = async () => {
    if (!ws) return
    setDeleting(true)
    try {
      await api.deleteWorkspace(ws.id)
      window.location.reload()
    } catch (e) {
      toast.error((e as Error).message)
      setDeleting(false)
    }
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
                disabled={!newName.trim() || creating}
                loading={creating}
                data-testid="workspace-create-submit"
              >
                {creating ? "Creating…" : "Create"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      }
    >
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
              loading={savingName}
              disabled={savingName || !name.trim() || name.trim() === ws?.name}
            >
              {savingName ? "Saving…" : "Save"}
            </Button>
          )}
        </div>
      </FormField>

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
                  loading={deleting}
                  disabled={deleting || delName.trim() !== ws.name}
                  className="mt-2 w-full"
                >
                  {deleting ? "Deleting…" : "Delete this workspace"}
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
  const { data: settings } = useQuery(workspaceSettingsQuery())

  const set = <K extends keyof OrgSettings>(key: K, next: OrgSettings[K]) => {
    const qk = workspaceSettingsQuery().queryKey
    const prev = qc.getQueryData(qk)
    if (!prev) return
    qc.setQueryData(qk, { ...prev, [key]: next })
    api
      .updateWorkspaceSettings({ [key]: next })
      .then((s) => qc.setQueryData(qk, s))
      .catch((e) => {
        qc.setQueryData(qk, prev)
        toast.error(e instanceof Error ? e.message : "Could not save")
      })
  }

  if (!settings) return null
  return (
    <SettingsGroup>
      <SettingRow
        label="Agent publishes as"
        description="Where a new artifact published by a connected agent lands. Private keeps its drafts yours until you share them."
      >
        <SelectMenu
          value={settings.defaultAgentVisibility}
          onValueChange={(v) =>
            set("defaultAgentVisibility", v as OrgSettings["defaultAgentVisibility"])
          }
        >
          <SelectMenuTrigger
            aria-label="Agent publish visibility"
            data-testid="default-agent-visibility"
          >
            {AGENT_VIS_LABELS[settings.defaultAgentVisibility] ?? settings.defaultAgentVisibility}
          </SelectMenuTrigger>
          <SelectMenuContent>
            <SelectMenuItem value="private">Private</SelectMenuItem>
            <SelectMenuItem value="org">Workspace</SelectMenuItem>
          </SelectMenuContent>
        </SelectMenu>
      </SettingRow>
    </SettingsGroup>
  )
}

const AGENT_VIS_LABELS: Record<string, string> = {
  private: "Private",
  org: "Workspace",
}
