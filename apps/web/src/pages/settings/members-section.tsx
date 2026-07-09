import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { type ArtifactMember, api, type Role } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { PersonSearchInput } from "@/components/shared/person-search-input"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "@/components/ui/sonner"
import { getInitials } from "@/lib/initials"
import { workspaceInvitesQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { roleLabel, roleValue, WS_ROLES } from "./roles"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

// Who's in the workspace and what they can do. Admins invite by @handle (a
// discoverable-people typeahead, mirroring ShareDialog) or full email, change
// roles inline, and remove people; everyone else sees a read-only roster.
export function MembersSection({ meId }: { meId: string }) {
  const qc = useQueryClient()
  const { data: ws } = useQuery(workspaceQuery())
  const [email, setEmail] = useState("")
  const [addRole, setAddRole] = useState<Role>("commenter")
  // A ref, not just the mutation's isPending: state updates are batched/async, so a
  // burst of synchronous native submit events (Enter held down, or auto-repeating — see
  // PersonSearchInput's documented submit-fallthrough) can all read the SAME stale closure
  // before the first call re-renders. The ref flips synchronously, so only the first gets
  // through.
  const addingRef = useRef(false)
  const [removing, setRemoving] = useState<ArtifactMember | null>(null)

  const isAdmin = ws?.role === "owner"

  const invite = useApiMutation({
    mutationFn: ({ email, role }: { email: string; role: Role }) =>
      api.inviteToWorkspace(email, role),
    onSuccess: async (r) => {
      setEmail("")
      if (r.kind === "member") {
        toast.success("Member added")
        qc.invalidateQueries({ queryKey: workspaceQuery().queryKey })
      } else {
        // A pending invite — copy the accept link to the clipboard so it works even where
        // mail isn't configured, and refresh the pending list.
        await navigator.clipboard?.writeText(r.accept_url).catch(() => {})
        toast.success(`Invite sent to ${r.invite.email} — link copied`)
        qc.invalidateQueries({ queryKey: workspaceInvitesQuery().queryKey })
      }
    },
  })
  const addMember = (e: React.FormEvent) => {
    e.preventDefault()
    if (addingRef.current || invite.isPending) return
    const em = email.trim()
    if (!em) return
    addingRef.current = true
    invite.mutate(
      { email: em, role: addRole },
      {
        onSettled: () => {
          addingRef.current = false
        },
      },
    )
  }

  const roleMut = useApiMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api.setWorkspaceMemberRole(userId, role),
    onSuccess: (_data, { userId, role }) =>
      qc.setQueryData(workspaceQuery().queryKey, (w) =>
        w
          ? { ...w, members: w.members.map((m) => (m.user_id === userId ? { ...m, role } : m)) }
          : w,
      ),
    success: "Role updated",
  })
  const changeRole = (userId: string, role: Role) => roleMut.mutate({ userId, role })

  const removeMut = useApiMutation({
    mutationFn: (m: ArtifactMember) => api.removeWorkspaceMember(m.user_id),
    onSuccess: (_data, m) =>
      qc.setQueryData(workspaceQuery().queryKey, (w) =>
        w ? { ...w, members: w.members.filter((x) => x.user_id !== m.user_id) } : w,
      ),
    success: "Member removed",
  })
  const removeMember = (m: ArtifactMember) => removeMut.mutate(m)

  return (
    <SettingsSection
      title="Members"
      description="Who's in this workspace and what they can do. Admins add people, Creators publish artifacts, Viewers read and comment."
    >
      {isAdmin && (
        <form onSubmit={addMember} className="flex flex-wrap gap-2">
          <PersonSearchInput
            value={email}
            onChange={setEmail}
            placeholder="@username or email to invite"
            ariaLabel="Username of a Derive user, or an email to invite"
            testId="member-email"
            className="min-w-50"
          />
          <Select value={addRole} onValueChange={(v) => setAddRole(v as Role)}>
            <SelectTrigger
              data-testid="member-role"
              aria-label="Role for new member"
              className="w-32.5"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WS_ROLES.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            data-testid="member-add"
            type="submit"
            variant="secondary"
            size="sm"
            loading={invite.isPending}
            disabled={invite.isPending || !email.trim()}
          >
            {invite.isPending ? "Adding…" : "Add"}
          </Button>
        </form>
      )}

      {!ws ? (
        <SettingsListSkeleton />
      ) : (
        <SettingsGroup>
          {ws.members.map((m) => (
            <div
              key={m.user_id}
              data-testid={`member-row-${m.user_id}`}
              className="flex items-center gap-3 py-3"
            >
              <Avatar className="size-7 shrink-0">
                <AvatarFallback>{getInitials(m.name ?? m.handle ?? m.user_id)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {m.name ?? (m.handle ? `@${m.handle}` : m.user_id)}
                  {m.user_id === meId && (
                    <span className="font-normal text-muted-foreground"> (you)</span>
                  )}
                </div>
                {m.handle && m.name && (
                  <div className="truncate font-mono text-2xs text-muted-foreground">
                    @{m.handle}
                    {m.profession ? ` · ${m.profession}` : ""}
                  </div>
                )}
              </div>
              {isAdmin ? (
                <Select
                  value={roleValue(m.role)}
                  onValueChange={(v) => changeRole(m.user_id, v as Role)}
                >
                  <SelectTrigger
                    data-testid={`member-role-${m.user_id}`}
                    aria-label={`Role for ${m.name ?? (m.handle ? `@${m.handle}` : "member")}`}
                    className="w-32.5 shrink-0"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WS_ROLES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Badge variant="secondary">{roleLabel(m.role)}</Badge>
              )}
              {isAdmin && (
                <Button
                  data-testid={`member-remove-${m.user_id}`}
                  variant="destructive-ghost"
                  size="sm"
                  onClick={() => setRemoving(m)}
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
        </SettingsGroup>
      )}

      {isAdmin && <PendingInvites />}

      {removing && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setRemoving(null)}
          title={`Remove ${removing.name ?? (removing.handle ? `@${removing.handle}` : "this member")}?`}
          description="They lose access to this workspace and its artifacts."
          confirmLabel="Remove"
          confirmTestId="member-remove-confirm"
          onConfirm={() => removeMember(removing)}
        />
      )}
    </SettingsSection>
  )
}

// Outstanding invitations that haven't been accepted yet — shown only to Admins, only
// when there are any. Each row can copy the accept link again or revoke the invite.
function PendingInvites() {
  const qc = useQueryClient()
  const { data: invites } = useQuery(workspaceInvitesQuery())
  const revokeMut = useApiMutation({
    mutationFn: (id: string) => api.revokeWorkspaceInvite(id),
    onSuccess: (_data, id) =>
      qc.setQueryData(workspaceInvitesQuery().queryKey, (list) =>
        list ? list.filter((i) => i.id !== id) : list,
      ),
    success: "Invitation revoked",
  })
  const revoke = (id: string) => revokeMut.mutate(id)
  if (!invites || invites.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium text-muted-foreground">Pending invitations</div>
      <SettingsGroup>
        {invites.map((inv) => (
          <div
            key={inv.id}
            data-testid={`invite-row-${inv.id}`}
            className="flex items-center gap-3 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">{inv.email}</div>
              <div className="text-2xs text-muted-foreground">Invited as {roleLabel(inv.role)}</div>
            </div>
            <Badge variant="outline">Pending</Badge>
            <Button
              data-testid={`invite-revoke-${inv.id}`}
              variant="destructive-ghost"
              size="sm"
              onClick={() => revoke(inv.id)}
            >
              Revoke
            </Button>
          </div>
        ))}
      </SettingsGroup>
    </div>
  )
}
