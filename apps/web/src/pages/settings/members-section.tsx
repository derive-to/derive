import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { type ArtifactMember, api, type PublicProfile, type Role } from "@/api"
import { ConfirmDialog } from "@/components/shared/confirm-dialog"
import { SettingsGroup } from "@/components/shared/settings-group"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "@/components/ui/sonner"
import { getInitials } from "@/lib/initials"
import { workspaceQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"
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
  const [adding, setAdding] = useState(false)
  // Discoverable-people typeahead for the add field — find teammates by @handle
  // or name (only those who left people-search on). Free-text (a full email for
  // someone not discoverable) still works via the Add button.
  const [suggest, setSuggest] = useState<PublicProfile[]>([])
  const [active, setActive] = useState(-1)
  const picked = useRef("")
  const [removing, setRemoving] = useState<ArtifactMember | null>(null)

  const isAdmin = ws?.role === "owner"

  // Debounced people-search; skip when empty or when the term is exactly what we
  // just picked (so a pick doesn't immediately reopen the menu).
  useEffect(() => {
    const term = email.trim()
    if (!term || term === picked.current) {
      setSuggest([])
      return
    }
    let alive = true
    const t = setTimeout(() => {
      api
        .searchPeople(term)
        .then((r) => {
          if (!alive) return
          setSuggest(r.users)
          setActive(-1)
        })
        .catch(() => {
          if (alive) setSuggest([])
        })
    }, 180)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [email])

  const pick = (u: PublicProfile) => {
    picked.current = `@${u.username}`
    setEmail(`@${u.username}`)
    setSuggest([])
    setActive(-1)
  }

  // ↑/↓ to move, Enter to pick the highlighted suggestion, Esc to close. With no
  // highlight, Enter falls through to the free-text add.
  const onAddKeyDown = (e: React.KeyboardEvent) => {
    if (suggest.length === 0) {
      if (e.key === "Enter") addMember()
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, suggest.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, -1))
    } else if (e.key === "Enter" && active >= 0 && suggest[active]) {
      e.preventDefault()
      pick(suggest[active])
    } else if (e.key === "Enter") {
      addMember()
    } else if (e.key === "Escape") {
      e.preventDefault()
      setSuggest([])
      setActive(-1)
    }
  }

  const addMember = async () => {
    const em = email.trim()
    if (!em) return
    setAdding(true)
    try {
      await api.addWorkspaceMember(em, addRole)
      setEmail("")
      setSuggest([])
      toast.success("Member added")
      qc.invalidateQueries({ queryKey: workspaceQuery().queryKey })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  const changeRole = async (userId: string, role: Role) => {
    try {
      await api.setWorkspaceMemberRole(userId, role)
      qc.setQueryData(workspaceQuery().queryKey, (w) =>
        w
          ? { ...w, members: w.members.map((m) => (m.user_id === userId ? { ...m, role } : m)) }
          : w,
      )
      toast.success("Role updated")
    } catch (e) {
      toast.error((e as Error).message)
      qc.invalidateQueries({ queryKey: workspaceQuery().queryKey })
    }
  }

  const removeMember = async (m: ArtifactMember) => {
    try {
      await api.removeWorkspaceMember(m.user_id)
      qc.setQueryData(workspaceQuery().queryKey, (w) =>
        w ? { ...w, members: w.members.filter((x) => x.user_id !== m.user_id) } : w,
      )
      toast.success("Member removed")
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <SettingsSection
      title="Members"
      description="Who's in this workspace and what they can do. Admins add people, Creators publish artifacts, Viewers read and comment."
    >
      {isAdmin && (
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-50 flex-1">
            <Input
              data-testid="member-email"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              aria-label="Username or email of a Derive user"
              placeholder="@username or email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={onAddKeyDown}
              className="w-full"
            />
            {suggest.length > 0 && (
              <div
                data-testid="member-suggest"
                className="absolute inset-x-0 top-[calc(100%+4px)] z-40 max-h-56 overflow-y-auto rounded-xl bg-popover p-1 shadow-[var(--shadow-pop)] ring-1 ring-foreground/10"
              >
                {suggest.map((u, i) => (
                  <button
                    key={u.username}
                    type="button"
                    data-testid="member-suggest-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(u)}
                    onMouseEnter={() => setActive(i)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      i === active && "bg-accent",
                    )}
                  >
                    <Avatar className="size-6">
                      {u.image && <AvatarImage src={u.image} alt={u.name ?? u.username} />}
                      <AvatarFallback>{getInitials(u.name ?? u.username)}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1">
                      {u.name && (
                        <span className="block truncate text-sm font-medium text-foreground">
                          {u.name}
                        </span>
                      )}
                      <span className="block truncate font-mono text-2xs text-muted-foreground">
                        @{u.username}
                        {u.profession ? ` · ${u.profession}` : ""}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
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
            variant="secondary"
            size="sm"
            onClick={addMember}
            loading={adding}
            disabled={adding || !email.trim()}
          >
            {adding ? "Adding…" : "Add"}
          </Button>
        </div>
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
