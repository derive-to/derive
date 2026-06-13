import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { Logo } from "@/components/shared/logo"
import { NotificationBell } from "./notification-bell"
import { UserMenu } from "./user-menu"

// App header: brand left, actions + bell + avatar right. On phones the actions
// wrap to their own right-aligned row so nothing overflows and popovers stay
// anchored to their button.
export function Header({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  return (
    <header className="flex items-center gap-2.5 border-b border-border bg-card px-5.5 py-3 max-sm:flex-wrap max-sm:gap-2 max-sm:px-3.5 max-sm:py-2.5">
      {left}
      <Link to="/" className="mr-auto flex items-center gap-2.5 text-foreground">
        <Logo />
        <span className="font-display text-lg font-semibold">Dock</span>
      </Link>
      {right && (
        <div className="flex items-center gap-2 max-sm:order-3 max-sm:w-full max-sm:flex-wrap max-sm:justify-end">
          {right}
        </div>
      )}
      <NotificationBell />
      <UserMenu />
    </header>
  )
}
