import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { api, type Workspaces } from "@/api"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useAuth } from "@/ctx"
import { cn } from "@/lib/utils"
import { Icon } from "./icons"
import { ThemeSwitch } from "./theme-switch"

const ROW =
  "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm font-medium text-foreground transition-colors hover:bg-hover"
const SECTION =
  "px-2 pb-1 pt-1 font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground"

// The account + workspace pod at the foot of the nav rail (bottom-left). Opens
// UPWARD. Holds the workspace switcher (multi mode), the segmented theme control,
// and the account actions. Creating a workspace opens a centered modal (a
// deliberate action) rather than an inline input. Keeps the e2e test-ids:
// user-menu-trigger, theme-option-*, menu-signout, workspace-*.
export function UserPod({
  workspaceLabel,
  workspaces,
  onSwitchWorkspace,
  onCreateWorkspace,
  rail,
}: {
  workspaceLabel: string
  workspaces: Workspaces | null
  onSwitchWorkspace: (id: string) => void
  onCreateWorkspace: (name: string) => void
  rail?: boolean
}) {
  const { me, setMe } = useAuth()
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState("")
  if (!me) return null

  const initials = (me.name ?? me.email).slice(0, 2).toUpperCase()
  const multi = !!workspaces?.multi

  const goSettings = () => {
    setOpen(false)
    nav({ to: "/settings" })
  }
  const signOut = async () => {
    setOpen(false)
    await api.logout().catch(() => {})
    setMe(null)
    nav({ to: "/login" })
  }
  const openCreate = () => {
    setOpen(false)
    setName("")
    setCreateOpen(true)
  }
  const createSubmit = () => {
    const t = name.trim()
    if (!t) return
    onCreateWorkspace(t) // reloads the page into the new workspace
    setName("")
    setCreateOpen(false)
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="user-menu-trigger"
            title={me.name ?? me.email}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-hover",
              rail && "justify-center px-0",
            )}
          >
            <Avatar className="size-7 shrink-0">
              <AvatarFallback className="bg-primary text-xs text-primary-foreground">
                {initials}
              </AvatarFallback>
            </Avatar>
            {!rail && (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-foreground">
                  {me.name ?? me.email}
                </span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {workspaceLabel || me.email}
                </span>
              </span>
            )}
            {!rail && <Icon name="more" size={16} />}
          </button>
        </PopoverTrigger>

        <PopoverContent side="top" align="start" className="w-64 p-1.5">
          <div className="flex items-center gap-2.5 px-2 py-1.5">
            <Avatar className="size-7 shrink-0">
              <AvatarFallback className="bg-primary text-xs text-primary-foreground">
                {initials}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">{me.name ?? me.email}</span>
              <span className="block truncate text-2xs text-muted-foreground">{me.email}</span>
            </span>
          </div>
          <div className="my-1 h-px bg-border-soft" />

          {multi ? (
            <>
              <div className={SECTION}>Workspace</div>
              {workspaces?.workspaces.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  data-testid={`workspace-${w.id}`}
                  onClick={() => {
                    onSwitchWorkspace(w.id)
                    setOpen(false)
                  }}
                  className={cn(ROW, w.id === workspaces.active && "text-primary")}
                >
                  {w.id === workspaces.active ? (
                    <Icon name="check" size={16} />
                  ) : (
                    <span className="size-4 shrink-0" />
                  )}
                  <span className="truncate">{w.name}</span>
                </button>
              ))}
              <button
                type="button"
                data-testid="workspace-new"
                onClick={openCreate}
                className={ROW}
              >
                <Icon name="plus" size={16} /> New workspace
              </button>
              <div className="my-1 h-px bg-border-soft" />
            </>
          ) : (
            <button
              type="button"
              data-testid="workspace-switcher"
              onClick={goSettings}
              title="Workspace settings"
              className={ROW}
            >
              <Icon name="workspace" size={16} />
              <span className="truncate">{workspaceLabel || "Workspace"}</span>
            </button>
          )}

          <div className={SECTION}>Theme</div>
          <div className="px-1 pb-1">
            <ThemeSwitch />
          </div>
          <div className="my-1 h-px bg-border-soft" />

          <button
            type="button"
            data-testid="menu-signout"
            onClick={signOut}
            className={cn(ROW, "text-muted-foreground")}
          >
            <Icon name="signout" size={16} /> Sign out
          </button>
        </PopoverContent>
      </Popover>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create a workspace</DialogTitle>
          </DialogHeader>
          <label htmlFor="ws-name" className="text-sm font-medium text-foreground">
            Name
          </label>
          <Input
            id="ws-name"
            autoFocus
            value={name}
            placeholder="Acme Marketing"
            aria-label="Workspace name"
            data-testid="workspace-new-input"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createSubmit()
            }}
            className="mt-1.5"
          />
          <p className="mt-2 text-xs text-muted-foreground">Starts empty. You'll be the owner.</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={createSubmit}
              disabled={!name.trim()}
              data-testid="workspace-create-submit"
            >
              Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
