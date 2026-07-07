import { useNavigate } from "@tanstack/react-router"
import { api, type Workspaces } from "@/api"
import { Icon } from "@/components/icons"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import { useAuth } from "@/ctx"
import { getInitials } from "@/lib/initials"
import { ThemeSwitch } from "./theme-switch"

// The account + workspace menu at the foot of the nav rail (bottom-left), on the
// app's ONE menu primitive — a real DropdownMenu (roving focus, role=menu, arrow-key
// nav, typeahead), not a hand-rolled popover of look-alike rows. The
// SidebarMenuButton size="lg" trigger shrinks to just the avatar in the collapsed
// icon rail; the menu opens UPWARD. Four zones, top → bottom: IDENTITY (avatar +
// name + public handle) · ACCOUNT (View profile, Settings) · CONTEXT (workspace
// switcher when you're in more than one, then the segmented theme control — it stays
// open on toggle) · a set-off SIGN OUT. Separators bracket only the unlabelled
// breaks (after identity, before sign out); the mono Workspace/Theme labels are the
// dividers for their own sections. Selecting an item auto-closes the menu (Radix),
// so no manual open state. Keeps the e2e ids: user-menu-trigger, menu-signout, and
// theme-option-* (inside ThemeSwitch). "New workspace" deep-links to the Settings
// create dialog — the pod is the entry point, Settings stays the venue.
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
  if (!me) return null

  const initials = getInitials(me.name ?? me.email)
  // The switcher earns its place only when there's something to switch between —
  // a solo account never sees ambient workspace chrome (the concept arrives as
  // the "Create a workspace" action instead). The server's `multi` flag is
  // always-on plumbing; real membership count is the signal.
  const multi = (workspaces?.workspaces.length ?? 0) > 1
  // The personal workspace shows as "Personal", pinned first — it's provisioned
  // plumbing, not a name the user chose (stable sort keeps the rest in order).
  const wsName = (w: { name: string; personal: boolean }) => (w.personal ? "Personal" : w.name)
  const sorted = [...(workspaces?.workspaces ?? [])].sort(
    (a, b) => Number(b.personal) - Number(a.personal),
  )

  const goProfile = () => {
    if (me.username) nav({ to: "/users/$handle", params: { handle: me.username } })
  }
  const goSettings = () => nav({ to: "/settings" })
  // Deep-link into Settings → General with the create dialog open (one-shot param).
  const goNewWorkspace = () =>
    nav({
      to: "/settings/$section",
      params: { section: "general" },
      search: { "new-workspace": "1" },
    })
  const signOut = async () => {
    await api.logout().catch(() => {})
    setMe(null)
    nav({ to: "/login" })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton
          size="lg"
          data-testid="user-menu-trigger"
          className="data-[state=open]:bg-sidebar-accent"
        >
          {/* Soft brand tint — never a solid ink block. The identity row is the
              rail's one generous moment; collapsed, it shrinks to the avatar. */}
          <Avatar className="size-8 shrink-0">
            <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
          <span className="grid min-w-0 flex-1">
            <span className="truncate text-sm font-medium text-foreground">
              {me.name ?? me.email}
            </span>
            <span className="truncate text-sm text-muted-foreground">
              {workspaceLabel || me.email}
            </span>
          </span>
          {/* Opens upward — the chevron says so. */}
          <Icon name="caret-up" className="text-muted-foreground" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-64">
        {/* IDENTITY — who you're signed in as; leads with the public handle. A
            presentational header (not a menuitem), so arrow-keys land on the actions. */}
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <Avatar className="size-8 shrink-0">
            <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
          <span className="grid min-w-0">
            <span className="truncate text-sm font-medium text-foreground">
              {me.name ?? me.email}
            </span>
            <span className="truncate text-xs text-muted-foreground" data-testid="user-handle">
              {me.username ? `@${me.username}` : me.email}
            </span>
          </span>
        </div>

        <DropdownMenuSeparator />

        {/* ACCOUNT — go to your profile / your settings. */}
        <DropdownMenuGroup>
          {me.username && (
            <DropdownMenuItem data-testid="menu-profile" onSelect={goProfile}>
              <Icon name="user" size={16} /> View profile
            </DropdownMenuItem>
          )}
          <DropdownMenuItem data-testid="menu-settings" onSelect={goSettings}>
            <Icon name="settings" size={16} /> Settings
          </DropdownMenuItem>
        </DropdownMenuGroup>

        {/* CONTEXT — the workspace switcher, only when you're in more than one.
            The mono label is the section divider; the check carries the active one
            (neutral, no CTA); "Personal" pins first. A solo account gets just the
            first-need affordance — the workspace concept arrives as an action. */}
        {multi ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Workspace</DropdownMenuLabel>
            {sorted.map((w) => (
              <DropdownMenuItem
                key={w.id}
                data-testid={`workspace-${w.id}`}
                aria-current={w.id === workspaces?.active ? "true" : undefined}
                onSelect={() => onSwitchWorkspace(w.id)}
              >
                {w.id === workspaces?.active ? (
                  <Icon name="check" size={16} />
                ) : (
                  <span className="size-4 shrink-0" />
                )}
                <span className="truncate">{wsName(w)}</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem data-testid="menu-new-workspace" onSelect={goNewWorkspace}>
              <Icon name="plus" size={16} /> New workspace
            </DropdownMenuItem>
          </DropdownMenuGroup>
        ) : (
          <DropdownMenuGroup>
            <DropdownMenuItem data-testid="menu-new-workspace" onSelect={goNewWorkspace}>
              <Icon name="plus" size={16} /> Create a workspace…
            </DropdownMenuItem>
          </DropdownMenuGroup>
        )}

        {/* THEME — the segmented control lives in the menu (a Tabs, not a menuitem,
            so toggling it doesn't dismiss). The label doubles as the divider above. */}
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <div className="px-1 pb-1">
          <ThemeSwitch />
        </div>

        <DropdownMenuSeparator />

        {/* SIGN OUT — set off by the rule, held quiet (muted, not destructive red);
            focus re-inks it via the item's own focus grammar. */}
        <DropdownMenuItem
          data-testid="menu-signout"
          onSelect={signOut}
          className="text-muted-foreground"
        >
          <Icon name="signout" size={16} /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
