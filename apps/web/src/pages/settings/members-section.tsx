import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { type ArtifactMember, api, type BillingInfo, type Role } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { PersonSearchInput } from "@/components/shared/person-search-input"
import { SettingsGroup } from "@/components/shared/settings-group"
import { StatusPanel } from "@/components/shared/status-panel"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "@/components/ui/sonner"
import { getInitials } from "@/lib/initials"
import { billingQuery, workspaceInvitesQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import { PLANS, unitPrice } from "./billing-plans"
import { roleLabel, roleValue, WS_ROLES } from "./roles"
import { SettingsListSkeleton } from "./settings-list-skeleton"
import { SettingsSection } from "./settings-section"

// Billable roles (mirror the pricing page + billing rail): Creator (editor) and
// Admin (owner) hold a seat; Viewer (commenter/legacy viewer) doesn't.
const isBillableRole = (r: Role): boolean => r === "editor" || r === "owner"

// Which billable-seat action is pending confirmation: a fresh invite (the
// person isn't in the workspace yet, so the dialog's last sentence about
// billing starting on accept applies), or a promotion of an existing
// commenter/viewer to editor/owner (they're already here, so it doesn't).
type SeatConfirmState =
  | { kind: "invite"; email: string; role: Role }
  | { kind: "promote"; userId: string; role: Role }

// A workspace on the free tier keeps this many editor seats before an upgrade is
// required — mirrors packages/core/src/billing.ts's FREE_SEAT_LIMIT. Not imported
// at runtime (web never imports @derive/core — see .dependency-cruiser.mjs), so
// the number is pinned here as a display-only constant.
const FREE_SEAT_LIMIT = 3

// Who's in the workspace and what they can do. Admins invite by @handle (a
// discoverable-people typeahead, mirroring ShareDialog) or full email, change
// roles inline, and remove people; everyone else sees a read-only roster.
export function MembersSection({ meId }: { meId: string }) {
  const qc = useQueryClient()
  const { data: ws, isPending, isError, refetch } = useQuery(workspaceQuery())
  const { data: billing } = useQuery(billingQuery())
  const [email, setEmail] = useState("")
  const [addRole, setAddRole] = useState<Role>("commenter")
  // A ref, not just the mutation's isPending: state updates are batched/async, so a
  // burst of synchronous native submit events (Enter held down, or auto-repeating — see
  // PersonSearchInput's documented submit-fallthrough) can all read the SAME stale closure
  // before the first call re-renders. The ref flips synchronously, so only the first gets
  // through.
  const addingRef = useRef(false)
  const [removing, setRemoving] = useState<ArtifactMember | null>(null)
  // A billable-seat grant (invite or promotion) awaiting the seat-confirmation
  // dialog; null when no such action is in flight. Only ever set on a
  // SUBSCRIBED workspace (see addMember / requestRoleChange below): an
  // unsubscribed workspace never routes through here, keeping its existing
  // free-tier note + server gate untouched.
  const [seatConfirm, setSeatConfirm] = useState<SeatConfirmState | null>(null)

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
  // The actual invite call, split out of addMember so the seat-confirmation
  // dialog's Confirm button can fire it too (with an extra onDone to close the
  // dialog once it lands).
  const fireInvite = (em: string, role: Role, onDone?: () => void) => {
    addingRef.current = true
    invite.mutate(
      { email: em, role },
      {
        onSuccess: onDone,
        onSettled: () => {
          addingRef.current = false
        },
      },
    )
  }
  const addMember = (e: React.FormEvent) => {
    e.preventDefault()
    if (addingRef.current || invite.isPending) return
    const em = email.trim()
    if (!em) return
    // A subscribed workspace bills per editor: a fresh invite as Creator/Admin
    // always grants a NEW seat (the invitee isn't in the workspace yet), so
    // pause on the confirmation dialog before firing the mutation.
    if (billing?.subscribed && isBillableRole(addRole)) {
      setSeatConfirm({ kind: "invite", email: em, role: addRole })
      return
    }
    fireInvite(em, addRole)
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
  // The per-row role dropdown's entry point: a promotion FROM a non-billable
  // role (commenter/viewer) TO a billable one (editor/owner) grants a new seat
  // on a subscribed workspace, so it pauses on the confirmation dialog first.
  // Re-roles between editor and owner (already billable either way) and any
  // demotion change the role with no seat impact, so they go straight through.
  const requestRoleChange = (member: ArtifactMember, role: Role) => {
    if (billing?.subscribed && !isBillableRole(member.role) && isBillableRole(role)) {
      setSeatConfirm({ kind: "promote", userId: member.user_id, role })
      return
    }
    changeRole(member.user_id, role)
  }
  // The seat-confirmation dialog's Confirm button: fires whichever mutation
  // was pending and closes the dialog once it lands (stays open on failure;
  // the global mutation-error toast still fires, and the dialog just lets the
  // admin retry or cancel).
  const confirmSeat = () => {
    if (!seatConfirm) return
    if (seatConfirm.kind === "invite") {
      fireInvite(seatConfirm.email, seatConfirm.role, () => setSeatConfirm(null))
    } else {
      roleMut.mutate(
        { userId: seatConfirm.userId, role: seatConfirm.role },
        { onSuccess: () => setSeatConfirm(null) },
      )
    }
  }

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

      {billing &&
        billing.tier === "free" &&
        !billing.subscribed &&
        billing.seats >= FREE_SEAT_LIMIT &&
        (addRole === "editor" || addRole === "owner") && (
          <p data-testid="members-seat-warning" className="text-sm text-muted-foreground">
            {billing.beta
              ? "Adding a 4th editor will require the Team plan once billing starts, $15 per editor for everyone. "
              : "Free covers 3 editor seats. Upgrading to Team adds unlimited editors, $15 per editor for everyone. "}
            <Link
              to="/settings/$section"
              params={{ section: "billing" }}
              className="underline underline-offset-2 hover:text-foreground"
            >
              See plans
            </Link>
          </p>
        )}

      {isPending ? (
        <SettingsListSkeleton />
      ) : isError ? (
        <StatusPanel
          tone="danger"
          title="Couldn't load members"
          description="This is usually temporary."
          action={
            <Button
              variant="outline"
              size="sm"
              data-testid="members-retry"
              onClick={() => refetch()}
            >
              Try again
            </Button>
          }
        />
      ) : ws ? (
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
                  onValueChange={(v) => requestRoleChange(m, v as Role)}
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
      ) : null}

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

      {seatConfirm && billing && (
        <SeatConfirmDialog
          billing={billing}
          includeInviteNote={seatConfirm.kind === "invite"}
          pending={seatConfirm.kind === "invite" ? invite.isPending : roleMut.isPending}
          onConfirm={confirmSeat}
          onCancel={() => setSeatConfirm(null)}
        />
      )}
    </SettingsSection>
  )
}

// The paid-tier seat-confirmation gate: granting a NEW billable seat on a
// subscribed workspace (a fresh invite as Creator/Admin, or promoting a
// Viewer/commenter to one) pauses here before the mutation fires. Built
// directly on the shadcn Dialog rather than the shared ConfirmDialog
// (components/shared/confirm-dialog.tsx): the copy is a full paragraph plus a
// sentence that only applies to the invite case, and the required testids
// don't fit that component's single-description, fixed-cancel-testid
// contract.
function SeatConfirmDialog({
  billing,
  includeInviteNote,
  pending,
  onConfirm,
  onCancel,
}: {
  billing: BillingInfo
  /** Drops the "billing starts once they accept" sentence for a role
   *  promotion: that person is already in the workspace. */
  includeInviteNote: boolean
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const tierName = PLANS.find((p) => p.tier === billing.tier)?.name ?? "Team"
  const unit = unitPrice(billing.tier, billing.interval)
  const cadence = billing.interval === "year" ? "monthly, billed annually" : "monthly"
  const nextSeats = billing.seats + 1
  const inviteNote = includeInviteNote
    ? " If they don't have an account yet, billing starts once they accept the invite."
    : ""

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent data-testid="seat-confirm-dialog">
        <DialogHeader>
          <DialogTitle>Add a billed editor seat?</DialogTitle>
          <DialogDescription>
            {`Editor seats on ${tierName} are billed at $${unit} per editor ${cadence}. With this seat your workspace will have ${nextSeats} seats at $${nextSeats * unit} per month.${inviteNote}`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={onCancel}
            data-testid="seat-confirm-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            loading={pending}
            disabled={pending}
            onClick={onConfirm}
            data-testid="seat-confirm-add"
          >
            Add editor seat
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
