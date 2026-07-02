import { useNavigate } from "@tanstack/react-router"
import { ChevronUp } from "lucide-react"
import { useState } from "react"
import { api, type Workspaces } from "@/api"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SidebarMenuButton } from "@/components/ui/sidebar"
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

// The account + workspace pod at the foot of the nav rail (bottom-left) — the
// official sidebar footer pattern: a SidebarMenuButton size="lg" trigger that
// shrinks to just the avatar in the collapsed icon rail. Opens UPWARD. Holds
// the workspace switcher (switch between the ones you're in), the segmented
// theme control, and the account actions. Creating a NEW workspace lives in
// Settings → Workspace (a deliberate, infrequent action), not here. Keeps the
// e2e test-ids: user-menu-trigger, theme-option-*, menu-signout, workspace-*.
export function UserPod({
  workspaceLabel,
  workspaces,
  onSwitchWorkspace,
}: {
  workspaceLabel: string
  workspaces: Workspaces | null
  onSwitchWorkspace: (id: string) => void
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
        <SidebarMenuButton
          size="lg"
          data-testid="user-menu-trigger"
          title={me.name ?? me.email}
          className="data-open:bg-sidebar-accent"
        >
          {/* Soft brand tint — never a solid amber block. Footer register: the
              identity row is the rail's one generous moment. In the collapsed
              icon rail the button shrinks to exactly the avatar. */}
          <Avatar className="size-8 shrink-0">
            <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
          <span className="grid min-w-0 flex-1">
            <span className="truncate text-sm font-medium text-foreground">
              {me.name ?? me.email}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {workspaceLabel || me.email}
            </span>
          </span>
          {/* Opens upward — the chevron says so. */}
          <ChevronUp className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </SidebarMenuButton>
      </PopoverTrigger>

      <PopoverContent side="top" align="start" className="w-64 gap-0 p-1">
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <Avatar className="size-7 shrink-0">
            <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{me.name ?? me.email}</span>
            {/* Lead with the public handle, not the (private) email. */}
            <span
              className="block truncate text-xs text-muted-foreground"
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
