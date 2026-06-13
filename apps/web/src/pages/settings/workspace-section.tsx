import { User } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { type ArtifactMember, api, type Role, type Workspace } from "@/api"
import { Spinner } from "@/components/shared/spinner"
import { useShell } from "@/components/shell-context"
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
import { roleLabel, roleValue, selectClass, WS_ROLES } from "./roles"

export function WorkspaceSection({ meId, show }: { meId: string; show: (m: string) => void }) {
  const { refreshWorkspaces } = useShell()
  const [ws, setWs] = useState<Workspace | null>(null)
  const [name, setName] = useState("")
  const [savingName, setSavingName] = useState(false)
  const [email, setEmail] = useState("")
  const [addRole, setAddRole] = useState<Role>("commenter")
  const [adding, setAdding] = useState(false)
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

  const saveName = async () => {
    const n = name.trim()
    if (!n || n === ws?.name) return
    setSavingName(true)
    try {
      const r = await api.renameWorkspace(n)
      setWs((w) => (w ? { ...w, name: r.name } : w))
      // Refresh the shell so the switcher + sidebar pick up the new name immediately.
      refreshWorkspaces()
      show("Workspace renamed")
    } catch (e) {
      show((e as Error).message)
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
      show((e as Error).message)
      setDeleting(false)
    }
  }

  const addMember = async () => {
    const em = email.trim()
    if (!em) return
    setAdding(true)
    try {
      await api.addWorkspaceMember(em, addRole)
      setEmail("")
      show("Member added")
      load()
    } catch (e) {
      show((e as Error).message)
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
      show("Role updated")
    } catch (e) {
      show((e as Error).message)
      load()
    }
  }

  const removeMember = async (m: ArtifactMember) => {
    if (!confirm(`Remove ${m.name ?? m.email ?? "this member"} from the workspace?`)) return
    try {
      await api.removeWorkspaceMember(m.user_id)
      setWs((w) => (w ? { ...w, members: w.members.filter((x) => x.user_id !== m.user_id) } : w))
      show("Member removed")
    } catch (e) {
      show((e as Error).message)
    }
  }

  return (
    <section>
      <p className="mb-4 text-sm text-muted-foreground">
        Name your workspace and choose who's in it. <strong>Admins</strong> add people,{" "}
        <strong>Creators</strong> publish artifacts, <strong>Viewers</strong> read and comment.
      </p>

      <Card className="p-4">
        <div className="text-xs font-semibold text-muted-foreground">Workspace name</div>
        <div className="mt-1.5 flex gap-2">
          <Input
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
              variant="primary"
              onClick={saveName}
              disabled={savingName || !name.trim() || name.trim() === ws?.name}
            >
              {savingName ? "Saving…" : "Save"}
            </Button>
          )}
        </div>
      </Card>

      <div className="mb-1 mt-6 flex items-baseline gap-2.5">
        <h3 className="font-display text-sm font-semibold">Members</h3>
        <span className="text-sm text-muted-foreground">· {ws?.members.length ?? 0}</span>
      </div>

      {isAdmin && (
        <Card className="mb-3.5 p-4">
          <div className="flex flex-wrap gap-2">
            <Input
              data-testid="member-email"
              aria-label="Email of a Dock user"
              placeholder="Email of a Dock user"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addMember()}
              className="min-w-[200px] flex-1"
            />
            <select
              data-testid="member-role"
              aria-label="Role for new member"
              value={addRole}
              onChange={(e) => setAddRole(e.target.value as Role)}
              className={`${selectClass} w-[130px]`}
            >
              {WS_ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <Button
              data-testid="member-add"
              variant="primary"
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
              className="flex items-center gap-3 px-4 py-3"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                <User className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-foreground">
                  {m.name ?? m.email ?? m.user_id}
                  {m.user_id === meId && (
                    <span className="font-normal text-muted-foreground"> (you)</span>
                  )}
                </div>
                {m.email && m.name && (
                  <div className="text-2xs text-muted-foreground">{m.email}</div>
                )}
              </div>
              {isAdmin ? (
                <select
                  data-testid={`member-role-${m.user_id}`}
                  aria-label={`Role for ${m.name ?? m.email ?? "member"}`}
                  value={roleValue(m.role)}
                  onChange={(e) => changeRole(m.user_id, e.target.value as Role)}
                  className={`${selectClass} w-[120px]`}
                >
                  {WS_ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              ) : (
                <Badge variant="accent" size="md" className="font-mono">
                  {roleLabel(m.role)}
                </Badge>
              )}
              {isAdmin && (
                <Button
                  data-testid={`member-remove-${m.user_id}`}
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
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
        <Card className="mt-6 border-destructive/40 p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-destructive">
            Danger zone
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-md text-sm text-muted-foreground">
              Delete this workspace permanently. It must be empty (no artifacts), and this can't be
              undone.
            </p>
            <Dialog onOpenChange={(o) => !o && setDelName("")}>
              <DialogTrigger asChild>
                <Button
                  data-testid="workspace-delete"
                  variant="outline"
                  className="shrink-0 border-destructive/50 text-destructive hover:bg-destructive/10"
                >
                  Delete workspace
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete "{ws.name}"?</DialogTitle>
                  <DialogDescription>
                    This permanently deletes the workspace and removes everyone from it. To confirm,
                    type <b className="text-foreground">{ws.name}</b> below.
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
                  onClick={onDelete}
                  disabled={deleting || delName.trim() !== ws.name}
                  className="mt-2 w-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {deleting ? "Deleting…" : "Delete this workspace"}
                </Button>
              </DialogContent>
            </Dialog>
          </div>
        </Card>
      )}
    </section>
  )
}
