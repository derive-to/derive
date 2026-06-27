import { useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { api, type Notification } from "@/api"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useAuth } from "@/ctx"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"
import { refFor } from "@/pages/artifact/parse-ref"
import { Icon } from "./icons"

// Nav-rail row classes (kept in sync with NavRail's SideItem so notifications +
// settings sit flush with the nav items above them).
const ROW =
  "flex w-full items-center gap-2.5 whitespace-nowrap rounded-[9px] px-2.5 py-2 text-left text-sm font-semibold text-foreground transition-colors hover:bg-hover"
const ROW_RAIL = "justify-center px-0 py-2.5"

// Notifications: an unread badge + a panel of recent @mentions, kept live over
// SSE. Lives at the foot of the nav rail; clicking an item deep-links to its
// comment thread (?c=) and marks it read. Built on the Popover primitive.
export function NotificationBell({ collapsed }: { collapsed?: boolean }) {
  const { me } = useAuth()
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
      nav({ to: "/u/$handle", params: { handle: n.actor } })
      return
    }
    nav({
      to: "/a/$ref",
      params: { ref: refFor({ short_id: n.artifact_short_id, title: n.artifact_title }) },
      // A share/publish notification has no thread; open the artifact itself.
      search: n.thread_id ? { c: n.thread_id } : {},
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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="notif-bell"
          title="Notifications"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
          className={cn(ROW, collapsed && ROW_RAIL)}
        >
          <span className="relative flex w-[18px] shrink-0 items-center justify-center">
            <Icon name="bell" size={18} />
            {collapsed && unread > 0 && (
              <span className="absolute -right-2 -top-2 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 font-mono text-2xs font-bold text-primary-foreground ring-2 ring-card">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </span>
          {!collapsed && <span className="overflow-hidden text-ellipsis">Notifications</span>}
          {!collapsed && unread > 0 && (
            <span className="ml-auto font-mono text-2xs text-muted-foreground">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" className="w-[330px] overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-border-soft px-3 py-2.5">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 && (
            <button
              type="button"
              onClick={markAll}
              data-testid="notif-mark-all"
              className="text-xs text-primary underline-offset-2 hover:underline"
            >
              Mark all read
            </button>
          )}
        </div>
        <div className="max-h-[380px] overflow-auto">
          {items.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">Nothing yet</div>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                type="button"
                data-testid={`notif-item-${n.id}`}
                onClick={() => openItem(n)}
                className={cn(
                  "flex w-full gap-2.5 border-b border-border-soft px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-hover",
                  !n.read && "bg-accent",
                )}
              >
                <span
                  className={cn(
                    "mt-1.5 size-[7px] shrink-0 rounded-full",
                    n.read ? "bg-border" : "bg-primary",
                  )}
                />
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
                    <span className="my-px block truncate text-xs text-muted-foreground">
                      {n.preview}
                    </span>
                  )}
                  <span className="block font-mono text-2xs text-muted-foreground">
                    {ago(n.created_at)}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
