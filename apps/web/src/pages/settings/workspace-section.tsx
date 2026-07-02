import { User } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { type ArtifactMember, api, type PublicProfile, type Role, type Workspace } from "@/api"
import { FormField } from "@/components/shared/form-field"
import { SectionEyebrow } from "@/components/shared/section-eyebrow"
import { Spinner } from "@/components/shared/spinner"
import { StatusPanel } from "@/components/shared/status-panel"
import { useShell } from "@/components/shell-context"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"
import { roleLabel, roleValue, WS_ROLES } from "./roles"

export function WorkspaceSection({ meId }: { meId: string }) {
  const { refreshWorkspaces, createWorkspace } = useShell()
  const [ws, setWs] = useState<Workspace | null>(null)
  const [name, setName] = useState("")
  const [savingName, setSavingName] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState("")
  const [email, setEmail] = useState("")
  const [addRole, setAddRole] = useState<Role>("commenter")
  const [adding, setAdding] = useState(false)
  // Discoverable-people typeahead for the add field — find teammates by @handle or
  // name (only those who left people-search on), mirroring ShareDialog. Free-text
  // (a full email for someone not discoverable) still works via the Add button.
  const [suggest, setSuggest] = useState<PublicProfile[]>([])
  const [active, setActive] = useState(-1)
  const picked = useRef("")
  const [delName, setDelName] = useState("")
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(
    () =>
      api
        .getWorkspace()
        .then((w) => {
          setWs(w)
          setName(w.name)
        })
        .catch(() => setWs(null)),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

  const isAdmin = ws?.role === "owner"

  // Create a brand-new workspace. Lives here (a deliberate, infrequent action)
  // rather than in the rail's workspace switcher. createWorkspace reloads the
  // page into the new workspace.
  const createSubmit = () => {
    const t = newName.trim()
    if (!t) return
    createWorkspace(t)
    setNewName("")
    setCreateOpen(false)
  }

  const saveName = async () => {
    const n = name.trim()
    if (!n || n === ws?.name) return
    setSavingName(true)
    try {
      const r = await api.renameWorkspace(n)
      setWs((w) => (w ? { ...w, name: r.name } : w))
      // Refresh the shell so the switcher + sidebar pick up the new name immediately.
      refreshWorkspaces()
      toast.success("Workspace renamed")
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSavingName(false)
    }
  }

  // Delete the active workspace. The server enforces the guards (Admin, not your
  // last, must be empty); we surface those errors and reload on success (the active
  // workspace may have changed).
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
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  const changeRole = async (userId: string, role: Role) => {
    try {
      await api.setWorkspaceMemberRole(userId, role)
      setWs((w) =>
        w
          ? { ...w, members: w.members.map((m) => (m.user_id === userId ? { ...m, role } : m)) }
          : w,
      )
      toast.success("Role updated")
    } catch (e) {
      toast.error((e as Error).message)
      load()
    }
  }

  const removeMember = async (m: ArtifactMember) => {
    if (
      !confirm(
        `Remove ${m.name ?? (m.handle ? `@${m.handle}` : "this member")} from the workspace?`,
      )
    )
      return
    try {
      await api.removeWorkspaceMember(m.user_id)
      setWs((w) => (w ? { ...w, members: w.members.filter((x) => x.user_id !== m.user_id) } : w))
      toast.success("Member removed")
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <section>
      <div className="mb-4 flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Name your workspace and choose who's in it. <strong>Admins</strong> add people,{" "}
          <strong>Creators</strong> publish artifacts, <strong>Viewers</strong> read and comment.
        </p>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="workspace-new" variant="outline" size="sm" className="shrink-0">
              New workspace
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Create a workspace</DialogTitle>
              <DialogDescription>Starts empty. You'll be the owner.</DialogDescription>
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
            <div className="mt-3 flex justify-end gap-2">
              <Button
                data-testid="workspace-new-cancel"
                variant="outline"
                size="sm"
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={createSubmit}
                disabled={!newName.trim()}
                data-testid="workspace-create-submit"
              >
                Create
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="p-4">
        <FormField label="Workspace name" htmlFor="workspace-name">
          <div className="flex gap-2">
            <Input
              id="workspace-name"
              data-testid="workspace-name"
              aria-label="Workspace name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!isAdmin || ws === null}
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
                disabled={savingName || !name.trim() || name.trim() === ws?.name}
              >
                {savingName ? "Saving…" : "Save"}
              </Button>
            )}
          </div>
        </FormField>
      </Card>

      <SectionEyebrow as="h3" count={ws?.members.length ?? 0} className="mb-3 mt-6">
        Members
      </SectionEyebrow>

      {isAdmin && (
        <Card className="mb-3.5 p-4">
          <div className="flex flex-wrap gap-2">
            <div className="relative min-w-[200px] flex-1">
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
                className="w-[130px]"
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
              disabled={adding || !email.trim()}
            >
              {adding ? "Adding…" : "Add"}
            </Button>
          </div>
        </Card>
      )}

      <div className="flex flex-col gap-2.5">
        {ws === null ? (
          <div className="flex h-20 items-center justify-center">
            <Spinner />
          </div>
        ) : (
          ws.members.map((m) => (
            <Card
              key={m.user_id}
              data-testid={`member-row-${m.user_id}`}
              className="flex-row items-center gap-3 px-4 py-3"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                <User className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">
                  {m.name ?? (m.handle ? `@${m.handle}` : m.user_id)}
                  {m.user_id === meId && (
                    <span className="font-normal text-muted-foreground"> (you)</span>
                  )}
                </div>
                {m.handle && m.name && (
                  <div className="font-mono text-2xs text-muted-foreground">
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
                    className="w-[120px]"
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
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  size="sm"
                  onClick={() => removeMember(m)}
                >
                  Remove
                </Button>
              )}
            </Card>
          ))
        )}
      </div>

      {isAdmin && ws && (
        <StatusPanel
          tone="danger"
          className="mt-6"
          title="Danger zone"
          description={
            <>
              Delete this workspace permanently. It must be empty (no artifacts), and this can't be
              undone.
            </>
          }
          action={
            <Dialog onOpenChange={(o) => !o && setDelName("")}>
              <DialogTrigger asChild>
                <Button data-testid="workspace-delete" variant="destructive">
                  Delete workspace
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete "{ws.name}"?</DialogTitle>
                  <DialogDescription>
                    This permanently deletes the workspace and removes everyone from it. To confirm,
                    type <b className="font-medium text-foreground">{ws.name}</b> below.
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
    </section>
  )
}
