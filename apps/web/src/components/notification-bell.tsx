import { useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { api, type Notification } from "@/api"
import { EmptyState } from "@/components/shared/empty-state"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useAuth } from "@/ctx"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"
import { refFor } from "@/pages/artifact/parse-ref"
import { Icon } from "./icons"

// Notifications: an unread badge + a panel of recent @mentions, kept live over
// SSE. Lives in the rail's utility menu (a SidebarMenuItem); clicking an item
// deep-links to its comment thread (?comment=) and marks it read. Built on the
// Popover primitive with a SidebarMenuButton trigger.
export function NotificationBell() {
  const { me } = useAuth()
  const { state, isMobile } = useSidebar()
  const nav = useNavigate()
  const [items, setItems] = useState<Notification[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)

  const load = useCallback(() => {
    api
      .notifications()
      .then((r) => {
        setItems(r.notifications)
        setUnread(r.unread)
      })
      .catch(() => {})
  }, [])

  // Initial load + live updates. EventSource reconnects on its own.
  useEffect(() => {
    if (!me) return
    load()
    const ev = new EventSource(api.notificationsStreamUrl(), { withCredentials: true })
    ev.addEventListener("notification", load)
    return () => ev.close()
  }, [me, load])

  // Mirror the unread count into the tab title — "(3) Derive" (the house
  // grammar). Strip any previous prefix first so updates replace, never stack.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\+?\)\s*/, "")
    document.title = unread > 0 ? `(${unread > 99 ? "99+" : unread}) ${base}` : base
  }, [unread])

  if (!me) return null

  const openItem = (n: Notification) => {
    setOpen(false)
    if (!n.read) {
      setUnread((u) => Math.max(0, u - 1))
      setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, read: 1 } : x)))
      api
        .markNotificationsRead({ ids: [n.id] })
        .then((r) => setUnread(r.unread))
        .catch(() => {})
    }
    // A follow notification has no artifact — open the follower's profile instead.
    if (n.kind === "follow") {
      nav({ to: "/users/$handle", params: { handle: n.actor } })
      return
    }
    nav({
      to: "/artifacts/$ref",
      params: { ref: refFor({ short_id: n.artifact_short_id, title: n.artifact_title }) },
      // A share/publish notification has no thread; open the artifact itself.
      search: n.thread_id ? { comment: n.thread_id } : {},
    })
  }

  const markAll = () => {
    setUnread(0)
    setItems((cur) => cur.map((x) => ({ ...x, read: 1 })))
    api
      .markNotificationsRead({ all: true })
      .then((r) => setUnread(r.unread))
      .catch(() => {})
  }

  // Icon rail: the unread signal collapses into the ink dot on the bell —
  // the ink accent means "this matters", so it never inflates into a solid count block.
  const iconMode = state === "collapsed" && !isMobile

  return (
    <SidebarMenuItem>
      <Popover open={open} onOpenChange={setOpen}>
        {/* No Tooltip layer here: stacking TooltipTrigger and PopoverTrigger
            asChild on one button loops radix's composed refs (verified in e2e).
            The dynamic aria-label carries the unread count instead. */}
        <PopoverTrigger asChild>
          <SidebarMenuButton
            data-testid="notif-bell"
            aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
            className={cn(
              "[&_svg]:text-muted-foreground hover:[&_svg]:text-foreground data-open:bg-sidebar-accent",
              unread > 0 && "pr-9",
            )}
          >
            <span className="relative flex size-4 shrink-0 items-center justify-center">
              <Icon name="bell" />
              {/* The ink dot is the unread signal in BOTH the collapsed strip and
                  the expanded rail — the ink accent means "this matters"; the count badge
                  beside it stays neutral like every other sidebar count. */}
              {unread > 0 && (
                <span
                  className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary"
                  aria-hidden
                />
              )}
            </span>
            <span>Notifications</span>
          </SidebarMenuButton>
        </PopoverTrigger>
        {/* The count is decoration here — the button's aria-label announces it. */}
        {!iconMode && unread > 0 && (
          <SidebarMenuBadge aria-hidden className="top-1.5 text-muted-foreground">
            {unread > 9 ? "9+" : unread}
          </SidebarMenuBadge>
        )}
        <PopoverContent side="right" align="end" className="w-82.5 gap-0 overflow-hidden p-0">
          <div className="flex items-center justify-between border-b border-border-soft px-3 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            {unread > 0 && (
              <Button variant="link" size="xs" onClick={markAll} data-testid="notif-mark-all">
                Mark all read
              </Button>
            )}
          </div>
          <div className="max-h-95 overflow-auto">
            {items.length === 0 ? (
              <EmptyState className="py-8">Nothing yet.</EmptyState>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  data-testid={`notif-item-${n.id}`}
                  onClick={() => openItem(n)}
                  className="flex w-full items-start gap-2.5 border-b border-border-soft px-3 py-2.5 text-left last:border-b-0 hover:bg-secondary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  {/* Kind glyph: mentions/replies are about you, so they take the brand
                    ink; follows/publishes/shares stay neutral — the ink accent is reserved. */}
                  {n.kind === "mention" ? (
                    <Icon name="at" className="mt-0.5 text-primary" />
                  ) : (
                    <Icon
                      name={
                        n.kind === "follow"
                          ? "user"
                          : n.kind === "publish"
                            ? "history"
                            : n.kind === "share"
                              ? "share"
                              : "comments"
                      }
                      size={16}
                      className={cn(
                        "mt-0.5",
                        n.kind === "follow" || n.kind === "publish" || n.kind === "share"
                          ? "text-muted-foreground"
                          : "text-primary",
                      )}
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-foreground">
                      <strong>{n.actor}</strong>{" "}
                      {n.kind === "follow" ? (
                        "started following you"
                      ) : n.kind === "publish" ? (
                        <>
                          published{" "}
                          {n.artifact_title ? <strong>{n.artifact_title}</strong> : "an update"}
                        </>
                      ) : n.kind === "share" ? (
                        <>
                          shared{" "}
                          {n.artifact_title ? <strong>{n.artifact_title}</strong> : "an artifact"}
                          {" with you"}
                        </>
                      ) : (
                        <>
                          {n.kind === "mention" ? "mentioned you" : "commented"}
                          {n.artifact_title ? (
                            <>
                              {" in "}
                              <strong>{n.artifact_title}</strong>
                            </>
                          ) : null}
                        </>
                      )}
                    </span>
                    {/* The preview is a snippet for mention/comment; for follow/publish the
                      main line already says it all, so skip the duplicate. */}
                    {(n.kind === "mention" || n.kind === "comment") && (
                      <span className="my-px block truncate text-sm text-muted-foreground">
                        {n.preview}
                      </span>
                    )}
                    <span className="block font-mono text-2xs text-muted-foreground">
                      {ago(n.created_at)}
                    </span>
                  </span>
                  {/* Unread carries the ink dot; read rows carry nothing. */}
                  {!n.read && (
                    <span
                      className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                      aria-hidden
                    />
                  )}
                </button>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  )
}
