import { useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { api, type Workspaces } from "@/api"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useAuth } from "@/ctx"
import { getInitials } from "@/lib/initials"
import { cn } from "@/lib/utils"
import { Icon } from "./icons"
import { ThemeSwitch } from "./theme-switch"

// Menu items follow the neutral bg-accent focus/hover grammar (amber is
// reserved); the section label is the mono eyebrow.
const ROW =
  "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-foreground outline-none hover:bg-accent focus-visible:bg-accent"
const SECTION = "px-2 pb-1 pt-1 font-mono text-2xs uppercase tracking-wide text-muted-foreground"

// The account + workspace pod at the foot of the nav rail (bottom-left). Opens
// UPWARD. Holds the workspace switcher (switch between the ones you're in), the
// segmented theme control, and the account actions. Creating a NEW workspace
// lives in Settings → Workspace (a deliberate, infrequent action), not here.
// Keeps the e2e test-ids: user-menu-trigger, theme-option-*, menu-signout,
// workspace-*.
export function UserPod({
  workspaceLabel,
  workspaces,
  onSwitchWorkspace,
  rail,
}: {
  workspaceLabel: string
  workspaces: Workspaces | null
  onSwitchWorkspace: (id: string) => void
  rail?: boolean
}) {
  const { me, setMe } = useAuth()
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  if (!me) return null

  const initials = getInitials(me.name ?? me.email)
  const multi = !!workspaces?.multi

  const goSettings = () => {
    setOpen(false)
    nav({ to: "/settings" })
  }
  const goProfile = () => {
    if (!me.username) return
    setOpen(false)
    nav({ to: "/u/$handle", params: { handle: me.username } })
  }
  const signOut = async () => {
    setOpen(false)
    await api.logout().catch(() => {})
    setMe(null)
    nav({ to: "/login" })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="user-menu-trigger"
          title={me.name ?? me.email}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            rail && "justify-center px-0",
          )}
        >
          {/* Soft brand tint — never a solid amber block. */}
          <Avatar className="size-7 shrink-0">
            <AvatarFallback className="bg-primary/15 text-xs font-medium text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
          {!rail && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">
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

      <PopoverContent side="top" align="start" className="w-64 gap-0 p-1">
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <Avatar className="size-7 shrink-0">
            <AvatarFallback className="bg-primary/15 text-xs font-medium text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{me.name ?? me.email}</span>
            {/* Lead with the public handle, not the (private) email. */}
            <span
              className="block truncate text-2xs text-muted-foreground"
              data-testid="user-handle"
            >
              {me.username ? `@${me.username}` : me.email}
            </span>
          </span>
        </div>
        <div className="my-1 h-px bg-border-soft" />

        {me.username && (
          <>
            <button type="button" data-testid="menu-profile" onClick={goProfile} className={ROW}>
              <Icon name="user" size={16} />
              <span className="truncate">View profile</span>
            </button>
            <div className="my-1 h-px bg-border-soft" />
          </>
        )}

        {multi ? (
          <>
            <div className={SECTION}>Workspace</div>
            {/* The selected workspace stays neutral (the check carries it) — an
                amber row inside the menu would read as a CTA. */}
            {workspaces?.workspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                data-testid={`workspace-${w.id}`}
                onClick={() => {
                  onSwitchWorkspace(w.id)
                  setOpen(false)
                }}
                className={ROW}
              >
                {w.id === workspaces.active ? (
                  <Icon name="check" size={16} />
                ) : (
                  <span className="size-4 shrink-0" />
                )}
                <span className="truncate">{w.name}</span>
              </button>
            ))}
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
  )
}
