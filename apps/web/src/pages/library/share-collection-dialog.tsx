import { useEffect, useRef, useState } from "react"
import { type ArtifactMember, api, type Collection, type Role, type WorkspaceAccess } from "@/api"
import { Icon, type IconName } from "@/components/icons"
import { AccessSegmentToggle } from "@/components/shared/access-segment-toggle"
import { EmptyState } from "@/components/shared/empty-state"
import { PersonSearchInput } from "@/components/shared/person-search-input"
import { ROLE_LABELS, RoleSelect } from "@/components/shared/role-select"
import { SectionEyebrow } from "@/components/shared/section-eyebrow"
import { Spinner } from "@/components/shared/spinner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useApiMutation } from "@/lib/use-api-mutation"

// Same share experience as an artifact (docs/plans/access-model.md), minus the
// Anyone segment — a collection isn't individually link-servable content, it's a
// grouping of other artifacts, each with its own access. So just the one
// question: invite-only, or does the workspace reach it at each member's seat?
type Segment = "invite" | "workspace"
const SEGMENTS: { value: Segment; label: string; icon: IconName }[] = [
  { value: "invite", label: "Invited", icon: "lock" },
  { value: "workspace", label: "Workspace", icon: "workspace" },
]

// Share a collection: who can open it at all (Invited vs Workspace, applies
// immediately, no Save — mirrors the artifact ShareDialog), plus the people
// roster whose role applies to every artifact inside it.
export function ShareCollectionDialog({
  collection,
  onClose,
  onChanged,
}: {
  /** Narrowed to the fields this dialog reads, so both callers fit: the library
   *  passes a full Collection; the artifact share dialog passes a CollectionGrant
   *  (its disclosure row's Manage action — see share-dialog.tsx). */
  collection: Pick<Collection, "id" | "title" | "created_by" | "workspace_access" | "my_role">
  onClose: () => void
  /** Fired each time a write LANDS (access flip, member add/remove/re-role) — the
   *  artifact share dialog refetches its disclosure rows from here, never from
   *  onClose, so an Escape mid-flight can't race the write. */
  onChanged?: () => void
}) {
  const [members, setMembers] = useState<ArtifactMember[]>([])
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("editor")
  // A ref, not just the mutation's async `isPending`: a burst of synchronous native
  // submit events (Enter held down, or auto-repeating — see PersonSearchInput's
  // documented submit-fallthrough) can all read the SAME stale pending=false before the
  // first mutate re-renders. The ref flips synchronously, so only the first gets through.
  const adding = useRef(false)
  const [wsAccess, setWsAccess] = useState<WorkspaceAccess>(collection.workspace_access ?? "member")
  // Re-seed when the caller hands us a different snapshot of the SAME dialog's
  // subject — the artifact share dialog's grant refreshes after a write, and a
  // stale seed here would re-create the exact lie this feature exists to fix.
  useEffect(() => {
    setWsAccess(collection.workspace_access ?? "member")
  }, [collection.workspace_access])

  // Unlike an artifact (editors can share — GDocs model), a collection's access
  // and membership routes are owner-only on the backend (same bar as delete —
  // pre-dates this dialog, see collections.ts's canManageCollection(..., "manage")
  // calls). Match that here: an editor would otherwise see live-looking controls
  // that 403 on every action.
  const canManage = collection.my_role === "owner"

  const load = () => {
    api
      .listCollectionMembers(collection.id)
      .then((r) => setMembers(r.members))
      .catch(() => {})
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch members when the shared collection changes; load reads collection.id.
  useEffect(() => {
    load()
  }, [collection.id])

  // Access applies immediately (a Save button between a toggle and its effect is friction
  // with no safety benefit). Optimistic via setWsAccess; the primitive rolls it back +
  // toasts on failure. Membership add/remove/re-role reconcile the roster on success.
  const accessMut = useApiMutation({
    mutationFn: (next: WorkspaceAccess) => api.setCollectionAccess(collection.id, next),
    optimistic: (next) => {
      const prev = wsAccess
      setWsAccess(next)
      return () => setWsAccess(prev)
    },
    onSuccess: (r) => {
      setWsAccess(r.workspace_access)
      onChanged?.()
    },
  })
  const applyAccess = (next: WorkspaceAccess) => accessMut.mutate(next)

  const addMut = useApiMutation({
    mutationFn: (addr: string) => api.setCollectionMember(collection.id, addr, role),
    onSuccess: () => {
      setEmail("")
      load()
      onChanged?.()
    },
  })
  const add = (e: React.FormEvent) => {
    e.preventDefault()
    if (adding.current) return
    const addr = email.trim()
    if (!addr) return
    adding.current = true
    addMut.mutate(addr, {
      onSettled: () => {
        adding.current = false
      },
    })
  }

  const removeMut = useApiMutation({
    mutationFn: (m: ArtifactMember) => api.removeCollectionMember(collection.id, m.user_id),
    onSuccess: () => {
      load()
      onChanged?.()
    },
  })
  const remove = (m: ArtifactMember) => removeMut.mutate(m)

  // Re-role in place — setCollectionMember upserts, so it's the Add call keyed by handle.
  const changeMut = useApiMutation({
    mutationFn: ({ handle, next }: { handle: string; next: Role }) =>
      api.setCollectionMember(collection.id, handle, next),
    success: "Role updated",
    onSuccess: () => {
      load()
      onChanged?.()
    },
  })
  const change = (m: ArtifactMember, next: Role) => {
    if (next === m.role || !m.handle) return
    changeMut.mutate({ handle: m.handle, next })
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="line-clamp-1 pr-6">Share “{collection.title}”</DialogTitle>
          <DialogDescription>
            People here get this role on{" "}
            <b className="font-medium text-foreground">every artifact</b> in the collection.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6">
          <div>
            <SectionEyebrow action={accessMut.isPending && <Spinner className="size-3" />}>
              Who can open this
            </SectionEyebrow>
            {canManage ? (
              <div className="mt-2 flex flex-col">
                <AccessSegmentToggle
                  segments={SEGMENTS}
                  value={wsAccess === "member" ? "workspace" : "invite"}
                  onChange={(v) => applyAccess(v === "workspace" ? "member" : "none")}
                  disabled={accessMut.isPending}
                  testId="collection-share-access"
                />
                {wsAccess === "none" ? (
                  <p className="mt-3 text-sm text-muted-foreground">
                    Only the people you add below can open this.
                  </p>
                ) : (
                  <p className="mt-3 text-sm text-muted-foreground">
                    Everyone in the workspace opens this at their role — admins manage, editors
                    edit, commenters comment.
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                {wsAccess === "member"
                  ? "Everyone in the workspace can open this."
                  : "Only people added below can open this."}
              </p>
            )}
          </div>

          <div>
            <SectionEyebrow>People with access</SectionEyebrow>
            {canManage && (
              <form onSubmit={add} className="mt-2 flex gap-1.5">
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
                  className="w-28 shrink-0"
                />
                {/* Add is this dialog's one filled primary — sm to sit flush with
                    the h-8 row chassis, matching ShareDialog's add row. */}
                <Button
                  variant="default"
                  size="sm"
                  type="submit"
                  data-testid="collection-share-add"
                  loading={addMut.isPending}
                >
                  {addMut.isPending ? "Adding…" : "Add"}
                </Button>
              </form>
            )}

            {members.length === 0 ? (
              <EmptyState className="mt-2 p-6">No one shared yet.</EmptyState>
            ) : (
              <div className="mt-2 flex flex-col gap-1.5">
                {members.map((m) => {
                  const who = m.name ?? (m.handle ? `@${m.handle}` : "member")
                  return (
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
                      {/* The creator's row is fixed — a collection's creator is
                        permanently owner via created_by regardless of member rows
                        (collectionRole checks it first), so their role can't be
                        changed and removing the row wouldn't revoke access, just
                        orphan the roster. Show it read-only even to a manager (the
                        backend rejects demote/remove of the creator too). */}
                      {canManage && m.user_id !== collection.created_by ? (
                        <>
                          <RoleSelect
                            value={m.role}
                            onChange={(next) => change(m, next)}
                            data-testid={`collection-share-member-role-${m.user_id}`}
                            aria-label={`Role for ${who}`}
                            className="w-28 shrink-0"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            data-testid={`collection-share-remove-${m.user_id}`}
                            onClick={() => remove(m)}
                            aria-label={`Remove ${who}`}
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
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
