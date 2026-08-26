import type { ReactNode } from "react"
import type { ArtifactInvite, ArtifactMember, LinkRole, Role, WorkspaceAccess } from "@/api"
import { Icon, type IconName } from "@/components/icons"
import { AccessSegmentToggle } from "@/components/shared/access-segment-toggle"
import { PersonSearchInput } from "@/components/shared/person-search-input"
import { ROLE_LABELS, RoleSelect } from "@/components/shared/role-select"
import { SectionEyebrow } from "@/components/shared/section-eyebrow"
import { Spinner } from "@/components/shared/spinner"
import { WorldLinkControls } from "@/components/shared/world-link-controls"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { getInitials } from "@/lib/initials"

export type ShareSegment = "invite" | "workspace" | "anyone"
type ShareTestPrefix = "share" | "collection-share"

const SHARE_SEGMENTS: { value: ShareSegment; label: string; icon: IconName }[] = [
  { value: "invite", label: "Invited", icon: "lock" },
  { value: "workspace", label: "Workspace", icon: "workspace" },
  { value: "anyone", label: "Anyone", icon: "globe" },
]

export const accessIcon = (
  linkRole: LinkRole,
  workspaceAccess: WorkspaceAccess,
  collectionOpen = false,
): IconName =>
  linkRole !== "none" ? "globe" : workspaceAccess === "member" || collectionOpen ? "share" : "lock"

export const accessSummary = (
  linkRole: LinkRole,
  workspaceAccess: WorkspaceAccess,
  collectionOpen = false,
): string => {
  if (linkRole !== "none") {
    const what = linkRole === "viewer" ? "view" : linkRole === "editor" ? "edit" : "comment"
    return `Anyone with the link can ${what}.`
  }
  if (workspaceAccess === "member" || collectionOpen)
    return "Everyone in the workspace can open this."
  return "Only invited people can open this."
}

/**
 * What the URL on the clipboard does for the person it gets pasted to — null only
 * when the link genuinely opens for anyone, unaided.
 *
 * This is deliberately NOT accessSummary. That one answers "who can open this
 * artifact", counting grants a recipient may not have: a workspace seat, a roster
 * entry. Copy Link sits next to it and answers a different question, and the two
 * diverge exactly where a share silently fails — "Everyone in the workspace can open
 * this" reads as open while the copied link is INERT for the outsider being emailed
 * it. The sender learns nothing until the recipient reports a 404, or doesn't.
 * Sharing outward has a working path (invite by email); this is what points at it.
 *
 * `locked` is the second silent failure and belongs to the same question: a world
 * link with a password opens for nobody who wasn't also sent the password, and the
 * copy affordance is the last place to say so before the paste.
 */
export const linkReachNote = (
  linkRole: LinkRole,
  workspaceAccess: WorkspaceAccess,
  opts: { collectionOpen?: boolean; collectionShared?: boolean; locked?: boolean } = {},
): string | null => {
  if (linkRole !== "none") return opts.locked ? "They'll need the password too." : null
  if (workspaceAccess === "member" || opts.collectionOpen)
    return "Only workspace members can open it."
  // An artifact reachable through a collection is not "only the people you add" —
  // saying so would contradict the access section four inches above it.
  if (opts.collectionShared) return "Only people you add, or who reach it via a collection."
  return "Only the people you add can open it."
}

export function ShareAccessSection({
  canManage,
  pending,
  segment,
  testPrefix,
  inviteCopy,
  workspaceCopy,
  readOnlyIcon,
  readOnlyCopy,
  world,
  workspaceChildren,
  worldChildren,
  children,
  onSegmentChange,
}: {
  canManage: boolean
  pending: boolean
  segment: ShareSegment
  testPrefix: ShareTestPrefix
  inviteCopy: ReactNode
  workspaceCopy: ReactNode
  readOnlyIcon: IconName
  readOnlyCopy: ReactNode
  world: {
    role: Exclude<LinkRole, "none">
    hasLock: boolean
    lockDraft: boolean
    passwordOpen: boolean
    password: string
    onRoleChange: (role: Exclude<LinkRole, "none">) => void
    onLockChange: (on: boolean) => void
    onPasswordOpen: () => void
    onPasswordChange: (password: string) => void
    onPasswordSet: (password: string) => void
  }
  workspaceChildren?: ReactNode
  worldChildren?: ReactNode
  children?: ReactNode
  onSegmentChange: (segment: ShareSegment) => void
}) {
  return (
    <div>
      <SectionEyebrow action={pending && <Spinner className="size-3" />}>
        Who can open this
      </SectionEyebrow>
      {canManage ? (
        <div className="mt-2 flex flex-col">
          <AccessSegmentToggle
            segments={SHARE_SEGMENTS}
            value={segment}
            onChange={onSegmentChange}
            disabled={pending}
            testId={`${testPrefix}-access`}
          />
          {segment === "invite" && (
            <p className="mt-3 text-sm text-muted-foreground">{inviteCopy}</p>
          )}
          {segment === "workspace" && (
            <>
              <p className="mt-3 text-sm text-muted-foreground">{workspaceCopy}</p>
              {workspaceChildren}
            </>
          )}
          {segment === "anyone" && (
            <WorldLinkControls
              role={world.role}
              pending={pending}
              hasLock={world.hasLock}
              lockDraft={world.lockDraft}
              passwordOpen={world.passwordOpen}
              password={world.password}
              testPrefix={testPrefix}
              onRoleChange={world.onRoleChange}
              onLockChange={world.onLockChange}
              onPasswordOpen={world.onPasswordOpen}
              onPasswordChange={world.onPasswordChange}
              onPasswordSet={world.onPasswordSet}
            >
              {worldChildren}
            </WorldLinkControls>
          )}
          {children}
        </div>
      ) : (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Icon name={readOnlyIcon} />
          {readOnlyCopy}
        </p>
      )}
    </div>
  )
}

export function SharePeopleSection({
  members,
  invites,
  currentUserId,
  canManage,
  email,
  role,
  pending,
  testPrefix,
  memberIsFixed,
  onEmailChange,
  onRoleChange,
  onAdd,
  onMemberRoleChange,
  onRemoveMember,
  onRevokeInvite,
}: {
  members: ArtifactMember[]
  invites: ArtifactInvite[]
  currentUserId?: string
  canManage: boolean
  email: string
  role: Role
  pending: boolean
  testPrefix: ShareTestPrefix
  memberIsFixed: (member: ArtifactMember) => boolean
  onEmailChange: (email: string) => void
  onRoleChange: (role: Role) => void
  onAdd: (event: React.FormEvent) => void
  onMemberRoleChange: (member: ArtifactMember, role: Role) => void
  onRemoveMember: (member: ArtifactMember) => void
  onRevokeInvite: (inviteId: string) => void
}) {
  return (
    <div>
      <SectionEyebrow count={members.length || undefined}>People with access</SectionEyebrow>
      {members.length === 0 ? (
        <p
          data-testid={`${testPrefix}-empty`}
          className="px-2 py-2.5 text-sm text-muted-foreground"
        >
          {canManage ? "No one shared yet." : "No one else has been added."}
        </p>
      ) : (
        <div className="-mx-2 mt-1 flex flex-col">
          {members.map((member) => {
            const label = member.name ?? (member.handle ? `@${member.handle}` : member.user_id)
            return (
              <div
                key={member.user_id}
                data-testid={`${testPrefix}-member-row-${member.user_id}`}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-secondary"
              >
                <Avatar className="size-8 shrink-0">
                  <AvatarFallback className="text-xs">
                    {getInitials(member.name ?? member.handle ?? "?")}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {label}
                    {member.user_id === currentUserId && (
                      <span className="text-muted-foreground"> (you)</span>
                    )}
                  </div>
                  {member.name && member.handle && (
                    <div className="truncate font-mono text-2xs text-muted-foreground">
                      @{member.handle}
                    </div>
                  )}
                </div>
                {canManage && !memberIsFixed(member) ? (
                  <>
                    <div
                      data-testid={`${testPrefix}-member-role-${member.user_id}`}
                      className="w-25 shrink-0"
                    >
                      <RoleSelect
                        value={member.role}
                        onChange={(next) => onMemberRoleChange(member, next)}
                        aria-label={`Role for ${label}`}
                        className="w-full"
                      />
                    </div>
                    <Button
                      data-testid={`${testPrefix}-member-remove-${member.user_id}`}
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onRemoveMember(member)}
                      aria-label={`Remove ${label}`}
                    >
                      <Icon name="close" />
                    </Button>
                  </>
                ) : (
                  <span
                    data-testid={`${testPrefix}-member-role-${member.user_id}`}
                    className="shrink-0 text-sm text-muted-foreground"
                  >
                    {ROLE_LABELS[member.role]}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {invites.length > 0 && (
        <div className="-mx-2 mt-1 flex flex-col">
          {invites.map((invite) => (
            <div
              key={invite.id}
              data-testid={`${testPrefix}-invite-row-${invite.id}`}
              className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-secondary"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary">
                <Icon name="mail" size={16} className="text-muted-foreground" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">{invite.email}</div>
                <div className="truncate text-xs text-muted-foreground">
                  Invited · joins as {ROLE_LABELS[invite.role]} once they accept
                </div>
              </div>
              {canManage && (
                <Button
                  data-testid={`${testPrefix}-invite-revoke-${invite.id}`}
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onRevokeInvite(invite.id)}
                  aria-label={`Revoke the invite to ${invite.email}`}
                >
                  <Icon name="close" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2">
        {canManage ? (
          <form onSubmit={onAdd} className="flex items-center gap-1.5">
            <PersonSearchInput
              value={email}
              onChange={onEmailChange}
              placeholder="Add people by @username or email…"
              testId={`${testPrefix}-email`}
            />
            <div data-testid={`${testPrefix}-role`} className="w-28 shrink-0">
              <RoleSelect
                value={role}
                onChange={onRoleChange}
                aria-label="Role for new member"
                className="w-full"
              />
            </div>
            <Button
              data-testid={`${testPrefix}-add`}
              variant="default"
              size="sm"
              type="submit"
              loading={pending}
            >
              {pending ? "Adding…" : "Add"}
            </Button>
          </form>
        ) : (
          <div
            data-testid={`${testPrefix}-viewonly`}
            className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-sm text-muted-foreground"
          >
            <Icon name="lock" />
            View only · ask an owner or editor to change access.
          </div>
        )}
      </div>
    </div>
  )
}

/** The copy affordance, plus the reach note under it. `reach` comes from
 *  `linkReachNote` on the dialog's LIVE access draft, not the artifact's loaded
 *  fields, so widening access in the dialog silences the note in the same gesture. */
export function ShareCopyLinkButton({
  copied,
  testPrefix,
  reach,
  children,
  onCopy,
}: {
  copied: boolean
  testPrefix: ShareTestPrefix
  reach?: string | null
  /** Sibling copy actions that share the row above the note. */
  children?: ReactNode
  onCopy: () => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        <Button data-testid={`${testPrefix}-url-copy`} variant="outline" size="sm" onClick={onCopy}>
          <Icon name={copied ? "check" : "link"} />
          {copied ? "Copied" : "Copy link"}
        </Button>
        {children}
      </div>
      {reach && (
        <p
          data-testid={`${testPrefix}-url-reach`}
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <Icon name="lock" className="size-3" />
          {reach}
        </p>
      )}
    </div>
  )
}
