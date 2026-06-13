import { useNavigate } from "@tanstack/react-router"
import { Check, ChevronDown } from "lucide-react"
import { api } from "@/api"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { THEMES, useAuth, useTheme } from "@/ctx"

// Avatar + name trigger; menu holds the theme picker (kept open while you try
// themes), Settings, and Sign out. Built on the DropdownMenu primitive.
export function UserMenu() {
  const { me, setMe } = useAuth()
  const { theme, setTheme } = useTheme()
  const nav = useNavigate()
  if (!me) return null
  const initials = (me.name ?? me.email).slice(0, 2).toUpperCase()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" data-testid="user-menu-trigger">
          <Avatar className="size-5">
            <AvatarFallback className="bg-primary text-xs text-primary-foreground">
              {initials}
            </AvatarFallback>
          </Avatar>
          <span className="max-w-[140px] truncate">{me.name ?? me.email}</span>
          <ChevronDown className="size-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-52">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        {THEMES.map((t) => (
          <DropdownMenuItem
            key={t.id}
            data-testid={`theme-option-${t.id}`}
            onSelect={(e) => {
              // Keep the menu open so several themes can be tried in a row.
              e.preventDefault()
              setTheme(t.id)
            }}
          >
            <span
              className="size-3.5 rounded-full border border-black/10"
              style={{ background: t.sw }}
            />
            {t.label}
            {theme === t.id && <Check className="ml-auto size-3.5 text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="menu-settings" onSelect={() => nav({ to: "/settings" })}>
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="menu-signout"
          className="text-muted-foreground"
          onSelect={async () => {
            await api.logout().catch(() => {})
            setMe(null)
            nav({ to: "/login" })
          }}
        >
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
