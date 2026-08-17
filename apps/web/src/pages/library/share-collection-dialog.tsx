import { useEffect, useRef, useState } from "react"
import {
  type ArtifactInvite,
  type ArtifactMember,
  api,
  type Collection,
  type LinkRole,
  type Role,
  type WorkspaceAccess,
} from "@/api"
import {
  accessIcon,
  accessSummary,
  ShareAccessSection,
  ShareCopyLinkButton,
  SharePeopleSection,
  type ShareSegment,
} from "@/components/shared/share-dialog-sections"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "@/components/ui/sonner"
import { useAuth } from "@/ctx"
import { useCopy } from "@/lib/clipboard"
import { useApiMutation } from "@/lib/use-api-mutation"

// Same share experience as an artifact (docs/access-model.md), minus the
// Anyone segment — a collection isn't individually link-servable content, it's a
// grouping of other artifacts, each with its own access. So just the one
// question: invite-only, or does the workspace reach it at each member's seat?
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
  collection: Pick<Collection, "id" | "title" | "created_by" | "workspace_access" | "my_role"> &
    Partial<Pick<Collection, "link_role" | "password_protected" | "url">>
  onClose: () => void
  /** Fired each time a write LANDS (access flip, member add/remove/re-role) — the
   *  artifact share dialog refetches its disclosure rows from here, never from
   *  onClose, so an Escape mid-flight can't race the write. */
  onChanged?: () => void
}) {
  const { me } = useAuth()
  const [members, setMembers] = useState<ArtifactMember[]>([])
  const [invites, setInvites] = useState<ArtifactInvite[]>([])
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("editor")
  // A ref, not just the mutation's async `isPending`: a burst of synchronous native
  // submit events (Enter held down, or auto-repeating — see PersonSearchInput's
  // documented submit-fallthrough) can all read the SAME stale pending=false before the
  // first mutate re-renders. The ref flips synchronously, so only the first gets through.
  const adding = useRef(false)
  const [wsAccess, setWsAccess] = useState<WorkspaceAccess>(collection.workspace_access ?? "member")
  const [linkRole, setLinkRole] = useState<LinkRole>(collection.link_role ?? "none")
  const [hasLock, setHasLock] = useState(!!collection.password_protected)
  const [lockDraft, setLockDraft] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [password, setPassword] = useState("")
  const { copied, copy } = useCopy()
  // Re-seed when the caller hands us a different snapshot of the SAME dialog's
  // subject — the artifact share dialog's grant refreshes after a write, and a
  // stale seed here would re-create the exact lie this feature exists to fix.
  useEffect(() => {
    setWsAccess(collection.workspace_access ?? "member")
  }, [collection.workspace_access])

  // Same GDocs-style sharing bar as an artifact: owners and editors can share.
  const canManage = collection.my_role === "owner" || collection.my_role === "editor"

  const load = () => {
    api
      .listCollectionMembers(collection.id)
      .then((r) => {
        setMembers(r.members)
        setInvites(r.invites)
      })
      .catch(() => toast.error("Couldn't load who has access"))
  }
  const loadAccess = () => {
    api
      .getCollection(collection.id)
      .then((fresh) => {
        setWsAccess(fresh.workspace_access ?? "member")
        setLinkRole(fresh.link_role ?? "none")
        setHasLock(!!fresh.password_protected)
      })
      .catch(() => {})
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch members when the shared collection changes; load reads collection.id.
  useEffect(() => {
    load()
    loadAccess()
  }, [collection.id])

  // Access applies immediately (a Save button between a toggle and its effect is friction
  // with no safety benefit). Optimistic via setWsAccess; the primitive rolls it back +
  // toasts on failure. Membership add/remove/re-role reconcile the roster on success.
  type AccessDraft = { workspaceAccess: WorkspaceAccess; linkRole: LinkRole; password?: string }
  const accessMut = useApiMutation({
    mutationFn: (next: AccessDraft) => api.setCollectionAccess(collection.id, next),
    optimistic: (next) => {
      const prev = { wsAccess, linkRole, hasLock, lockDraft }
      setWsAccess(next.workspaceAccess)
      setLinkRole(next.linkRole)
      if (next.linkRole === "none") {
        setHasLock(false)
        setLockDraft(false)
      }
      return () => {
        setWsAccess(prev.wsAccess)
        setLinkRole(prev.linkRole)
        setHasLock(prev.hasLock)
        setLockDraft(prev.lockDraft)
      }
    },
    onSuccess: (r) => {
      setWsAccess(r.workspace_access)
      setLinkRole(r.link_role)
      setHasLock(r.locked)
      setLockDraft(false)
      setPasswordOpen(false)
      setPassword("")
      onChanged?.()
    },
  })
  const applyAccess = (next: AccessDraft) => accessMut.mutate(next)
  const segment: ShareSegment =
    linkRole !== "none" ? "anyone" : wsAccess === "member" ? "workspace" : "invite"
  const linkRoleValue: Exclude<LinkRole, "none"> = linkRole === "none" ? "viewer" : linkRole
  const pickSegment = (next: ShareSegment) => {
    if (next === "invite") return applyAccess({ workspaceAccess: "none", linkRole: "none" })
    if (next === "workspace") return applyAccess({ workspaceAccess: "member", linkRole: "none" })
    return applyAccess({ workspaceAccess: "member", linkRole: linkRoleValue })
  }
  const currentWithPassword = (nextPassword: string): AccessDraft => ({
    workspaceAccess: wsAccess,
    linkRole,
    password: nextPassword,
  })
  const toggleLock = (on: boolean) => {
    if (on) setLockDraft(true)
    else if (hasLock) applyAccess(currentWithPassword(""))
    else setLockDraft(false)
  }
  const shareUrl =
    collection.url ??
    `${typeof window === "undefined" ? "" : window.location.origin}/collections/${collection.id}`

  const addMut = useApiMutation({
    mutationFn: (addr: string) => api.setCollectionMember(collection.id, addr, role),
    onSuccess: (res) => {
      setEmail("")
      if (res.kind === "invite") toast(`Invite sent to ${res.invite.email}.`)
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

  const revokeInviteMut = useApiMutation({
    mutationFn: (inviteId: string) => api.revokeCollectionInvite(collection.id, inviteId),
    success: "Invite revoked",
    onSuccess: () => load(),
  })

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
      <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="line-clamp-1 pr-6">Share “{collection.title}”</DialogTitle>
          <DialogDescription>
            People here get this role on{" "}
            <b className="font-medium text-foreground">every artifact</b> in the collection.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6">
          <ShareAccessSection
            canManage={canManage}
            pending={accessMut.isPending}
            segment={segment}
            testPrefix="collection-share"
            inviteCopy="Only the people you add below can open this."
            workspaceCopy="Everyone in the workspace uses their existing role. Admins manage, editors edit, and commenters comment."
            readOnlyIcon={accessIcon(linkRole, wsAccess)}
            readOnlyCopy={accessSummary(linkRole, wsAccess)}
            onSegmentChange={pickSegment}
            world={{
              role: linkRoleValue,
              hasLock,
              lockDraft,
              passwordOpen,
              password,
              onRoleChange: (next) => applyAccess({ workspaceAccess: wsAccess, linkRole: next }),
              onLockChange: toggleLock,
              onPasswordOpen: () => setPasswordOpen(true),
              onPasswordChange: setPassword,
              onPasswordSet: (next) => applyAccess(currentWithPassword(next)),
            }}
          />

          <SharePeopleSection
            members={members}
            invites={invites}
            currentUserId={me?.id}
            canManage={canManage}
            email={email}
            role={role}
            pending={addMut.isPending}
            testPrefix="collection-share"
            memberIsFixed={(member) => member.user_id === collection.created_by}
            onEmailChange={setEmail}
            onRoleChange={setRole}
            onAdd={add}
            onMemberRoleChange={change}
            onRemoveMember={remove}
            onRevokeInvite={(inviteId) => revokeInviteMut.mutate(inviteId)}
          />
        </div>

        <div className="flex items-center justify-between border-t border-border pt-4">
          <ShareCopyLinkButton
            copied={copied}
            testPrefix="collection-share"
            onCopy={() => copy(shareUrl)}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
