import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { ListRow } from "@/components/shared/list-row"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "@/components/ui/sonner"
import { copyText } from "@/lib/clipboard"
import { billingQuery, workspaceJoinLinkQuery, workspaceQuery } from "@/lib/queries"
import { useApiMutation } from "@/lib/use-api-mutation"
import {
  joinLinkActiveLine,
  joinLinkConfirmDescription,
  joinLinkConfirmTitle,
  joinLinkSeatLine,
} from "./join-link-copy"
import { roleLabel, WS_ROLES } from "./roles"

type LinkRole = "commenter" | "editor"

// The roles a link may grant: Creator and Viewer, never Admin. Creator first and default.
const LINK_ROLES = WS_ROLES.filter((r) => r.value === "editor" || r.value === "commenter")

const daysLeft = (expiresAt: string): number =>
  Math.ceil((Date.parse(expiresAt) - Date.now()) / 86_400_000)

// One shareable link for the whole workspace. Admin-only (the caller renders it for Admins).
// Create and Regenerate are the same server call; Revoke deletes. A Creator link on a
// subscribed workspace pauses on the seat-confirm dialog so the charge is acknowledged before
// the link exists; the seat line under the select says what a Creator costs at all times.
export function JoinLinkCard() {
  const qc = useQueryClient()
  // surface-ignore: the caller only mounts this card once workspaceQuery has already
  // resolved successfully (isAdmin depends on it, and its own error state lives in
  // MembersSection). A failed join-link read degrades to the create-link empty state
  // rather than a second error banner; billing and workspace name are copy inputs that
  // already have documented undefined fallbacks (joinLinkSeatLine, joinLinkActiveLine,
  // and the ws?.name default below).
  const { data: link, isPending } = useQuery(workspaceJoinLinkQuery())
  const { data: billing } = useQuery(billingQuery())
  const { data: ws } = useQuery(workspaceQuery())
  const [role, setRole] = useState<LinkRole>("editor")
  const [confirmCreate, setConfirmCreate] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState(false)

  const create = useApiMutation({
    mutationFn: (r: LinkRole) => api.createJoinLink(r),
    onSuccess: async (created) => {
      qc.setQueryData(workspaceJoinLinkQuery().queryKey, created)
      const copied = await copyText(created.url, { error: null })
      toast.success(copied ? "Join link ready. Link copied." : "Join link ready.")
    },
  })
  const revoke = useApiMutation({
    mutationFn: () => api.revokeJoinLink(),
    onSuccess: () => qc.setQueryData(workspaceJoinLinkQuery().queryKey, null),
    success: "Join link revoked",
  })

  const requestCreate = (r: LinkRole) => {
    // A subscribed workspace bills every Creator: confirm before a Creator link exists.
    if (r === "editor" && billing?.subscribed) {
      setConfirmCreate(true)
      return
    }
    create.mutate(r)
  }

  if (isPending) return null

  const activeRole: LinkRole = link ? (link.role === "commenter" ? "commenter" : "editor") : role
  const seatLine = joinLinkSeatLine(billing, link ? link.role : role)

  return (
    <SettingsGroup
      title="Join link"
      description={
        link
          ? `Anyone who opens this link joins as a ${roleLabel(link.role)}.`
          : "One link for the whole team. Anyone who opens it joins at this role."
      }
    >
      {link ? (
        <ListRow
          data-testid="join-link-row"
          mono
          title={
            <input
              data-testid="join-link-url"
              readOnly
              value={link.url}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full bg-transparent font-mono text-sm text-foreground outline-none"
              aria-label="Join link URL"
            />
          }
          meta={
            <span data-testid="join-link-meta">
              {roleLabel(link.role)} ·{" "}
              {daysLeft(link.expires_at) > 0
                ? `expires in ${daysLeft(link.expires_at)} days`
                : "expired, regenerate to renew"}{" "}
              · {link.join_count} joined
            </span>
          }
          below={
            link.role === "editor" ? (
              <p data-testid="join-link-seat-line" className="text-sm text-muted-foreground">
                {joinLinkActiveLine(billing)}
              </p>
            ) : undefined
          }
          actions={
            <>
              <Button
                data-testid="join-link-copy"
                variant="ghost"
                size="sm"
                onClick={() => copyText(link.url, { success: "Join link copied" })}
              >
                Copy link
              </Button>
              <Button
                data-testid="join-link-regenerate"
                variant="ghost"
                size="sm"
                onClick={() => requestCreate(activeRole)}
                disabled={create.isPending}
              >
                Regenerate
              </Button>
              <Button
                data-testid="join-link-revoke"
                variant="destructive-ghost"
                size="sm"
                onClick={() => setConfirmRevoke(true)}
              >
                Revoke
              </Button>
            </>
          }
        />
      ) : (
        <div className="flex flex-col gap-2 py-3.5">
          <div className="flex items-center gap-2">
            <Select value={role} onValueChange={(v) => setRole(v as LinkRole)}>
              <SelectTrigger
                data-testid="join-link-role"
                aria-label="Role for people who join"
                className="w-32.5"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LINK_ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              data-testid="join-link-create"
              size="sm"
              onClick={() => requestCreate(role)}
              loading={create.isPending}
            >
              Create link
            </Button>
          </div>
          {seatLine && (
            <p data-testid="join-link-seat-line" className="text-sm text-muted-foreground">
              {seatLine}
            </p>
          )}
        </div>
      )}

      {confirmCreate && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirmCreate(false)}
          title={joinLinkConfirmTitle}
          description={joinLinkConfirmDescription(billing, ws?.name ?? "this workspace")}
          confirmLabel="Create link"
          tone="default"
          contentTestId="join-link-confirm-dialog"
          confirmTestId="join-link-confirm-create"
          onConfirm={() => {
            setConfirmCreate(false)
            create.mutate("editor")
          }}
        />
      )}
      {confirmRevoke && link && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirmRevoke(false)}
          title="Revoke the join link?"
          description="The link stops working immediately. People who already joined keep their seats."
          confirmLabel="Revoke"
          confirmTestId="join-link-revoke-confirm"
          onConfirm={() => {
            setConfirmRevoke(false)
            revoke.mutate()
          }}
        />
      )}
    </SettingsGroup>
  )
}
