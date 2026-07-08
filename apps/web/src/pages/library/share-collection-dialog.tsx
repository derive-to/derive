import { useEffect, useState } from "react"
import { type ArtifactMember, api, type Collection, type Role } from "@/api"
import { Icon } from "@/components/icons"
import { EmptyState } from "@/components/shared/empty-state"
import { PersonSearchInput } from "@/components/shared/person-search-input"
import { ROLE_LABELS, RoleSelect } from "@/components/shared/role-select"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "@/components/ui/sonner"
import { Switch } from "@/components/ui/switch"

// Share a collection: add people by email at a role, or share it with the whole
// workspace at once (a live binding — future teammates get it too, not just
// whoever's on the roster today). Either way the role applies to every artifact
// in the collection (the headline of collection-level sharing).
export function ShareCollectionDialog({
  collection,
  onClose,
}: {
  collection: Collection
  onClose: () => void
}) {
  const [members, setMembers] = useState<ArtifactMember[]>([])
  const [canManage, setCanManage] = useState(false)
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("editor")
  const [busy, setBusy] = useState(false)
  const [workspace, setWorkspace] = useState<{ id: string; name: string } | null>(null)
  const [workspaceRole, setWorkspaceRole] = useState<Role | null>(null)
  const [wsBusy, setWsBusy] = useState(false)

  const load = () => {
    api
      .listCollectionMembers(collection.id)
      .then((r) => {
        setMembers(r.members)
        setCanManage(r.can_manage)
        setWorkspace(r.workspace)
        setWorkspaceRole(r.workspace_share?.role ?? null)
      })
      .catch(() => {})
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch members when the shared collection changes; load reads collection.id.
  useEffect(() => {
    load()
  }, [collection.id])

  // One mutator for both the toggle (on/off) and the role select (re-role while
  // on) — same optimistic-update-then-rollback shape either way, just a
  // different next value.
  const setWorkspaceShare = async (next: Role | null) => {
    const prev = workspaceRole
    setWorkspaceRole(next)
    setWsBusy(true)
    try {
      if (next) await api.setCollectionWorkspaceShare(collection.id, next)
      else await api.removeCollectionWorkspaceShare(collection.id)
    } catch (x) {
      setWorkspaceRole(prev)
      toast.error(x instanceof Error ? x.message : "Couldn't update the workspace share")
    } finally {
      setWsBusy(false)
    }
  }

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const addr = email.trim()
    if (!addr) return
    setBusy(true)
    try {
      await api.setCollectionMember(collection.id, addr, role)
      setEmail("")
      load()
    } catch (x) {
      toast.error((x as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async (m: ArtifactMember) => {
    try {
      await api.removeCollectionMember(collection.id, m.user_id)
    } catch (x) {
      toast.error(x instanceof Error ? x.message : "Couldn't remove member")
    }
    load()
  }
  // Re-role an existing member in place — setCollectionMember upserts server-side,
  // so this is the same call the Add form makes, just keyed by their handle.
  const change = async (m: ArtifactMember, next: Role) => {
    if (next === m.role || !m.handle) return
    try {
      await api.setCollectionMember(collection.id, m.handle, next)
    } catch (x) {
      toast.error(x instanceof Error ? x.message : "Couldn't update their role")
    }
    load()
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share “{collection.title}”</DialogTitle>
          <DialogDescription>
            People here get this role on{" "}
            <b className="font-medium text-foreground">every artifact</b> in the collection.
          </DialogDescription>
        </DialogHeader>

        {/* DialogContent's grid gap spaces the sections — no child margins. A
            plain viewer (canManage false) gets the read-only roster below with
            no add form — no controls that would just 403 on click. */}
        {canManage && (
          <form onSubmit={add} className="flex gap-1.5">
            <PersonSearchInput
              value={email}
              onChange={setEmail}
              placeholder="@username or email"
              testId="collection-share-email"
              className="min-w-0"
            />
            <RoleSelect
              value={role}
              onChange={setRole}
              data-testid="collection-share-role"
              className="w-26 shrink-0"
            />
            {/* Add is this dialog's one filled primary. */}
            <Button
              variant="default"
              type="submit"
              data-testid="collection-share-add"
              loading={busy}
            >
              {busy ? "Adding…" : "Add"}
            </Button>
          </form>
        )}

        {members.length === 0 ? (
          <EmptyState className="p-6">No one shared yet.</EmptyState>
        ) : (
          <div className="flex flex-col gap-1.5">
            {members.map((m) => (
              <div key={m.user_id} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {m.name ?? (m.handle ? `@${m.handle}` : m.user_id)}
                  </div>
                  {m.name && m.handle && (
                    <div className="truncate font-mono text-2xs text-muted-foreground">
                      @{m.handle}
                    </div>
                  )}
                </div>
                {canManage ? (
                  <>
                    <RoleSelect
                      value={m.role}
                      onChange={(next) => change(m, next)}
                      data-testid={`collection-share-member-role-${m.user_id}`}
                      aria-label={`Role for ${m.name ?? (m.handle ? `@${m.handle}` : "member")}`}
                      className="w-26 shrink-0"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      data-testid={`collection-share-remove-${m.user_id}`}
                      onClick={() => remove(m)}
                      aria-label={`Remove ${m.name ?? (m.handle ? `@${m.handle}` : "member")}`}
                    >
                      <Icon name="close" />
                    </Button>
                  </>
                ) : (
                  <span className="shrink-0 text-sm text-muted-foreground">
                    {ROLE_LABELS[m.role]}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {canManage ? (
          <div className="flex items-center gap-2 border-t border-border pt-3">
            <Switch
              id="collection-share-workspace"
              data-testid="collection-share-workspace-toggle"
              checked={workspaceRole !== null}
              disabled={wsBusy || !workspace}
              onCheckedChange={(on) => setWorkspaceShare(on ? (workspaceRole ?? "viewer") : null)}
            />
            <label htmlFor="collection-share-workspace" className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">
                Share with everyone in {workspace?.name ?? "this workspace"}
              </div>
              <div className="truncate text-2xs text-muted-foreground">
                Auto-includes new teammates too.
              </div>
            </label>
            {workspaceRole !== null && (
              <RoleSelect
                value={workspaceRole}
                onChange={setWorkspaceShare}
                data-testid="collection-share-workspace-role"
                className="w-26 shrink-0"
              />
            )}
          </div>
        ) : (
          // A viewer can't change the share, but seeing that one exists explains
          // why they (or others) have access without an explicit invite.
          workspaceRole !== null && (
            <div
              data-testid="collection-share-workspace-readonly"
              className="border-t border-border pt-3 text-sm text-muted-foreground"
            >
              Shared with everyone in {workspace?.name ?? "this workspace"} (
              {ROLE_LABELS[workspaceRole]})
            </div>
          )
        )}
      </DialogContent>
    </Dialog>
  )
}
