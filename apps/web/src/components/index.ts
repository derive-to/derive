// Barrel for the app chrome. Keeps existing `@/components` / `../components`
// imports working now that the old components.tsx is split into focused files.

export { useIsMobile } from "@/lib/use-is-mobile"
export { Header } from "./header"
export { NotificationBell } from "./notification-bell"
export { Logo } from "./shared/logo"
export { UserMenu } from "./user-menu"
