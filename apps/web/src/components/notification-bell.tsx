import { useNavigate } from "@tanstack/react-router"
import { Bell } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { api, type Notification } from "@/api"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useAuth } from "@/ctx"
import { ago } from "@/lib/time"
import { cn } from "@/lib/utils"

// Header bell: unread badge + a panel of recent @mentions, kept live over SSE.
// Clicking an item deep-links to its comment thread (?c=) and marks it read.
// Built on the Popover primitive — outside-click, Escape and focus are handled.
export function NotificationBell() {
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
    nav({ to: "/a/$ref", params: { ref: n.artifact_short_id }, search: { c: n.thread_id } })
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
        <Button
          variant="outline"
          size="icon"
          className="relative"
          title="Notifications"
          data-testid="notif-bell"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell className="size-4" />
          {unread > 0 && (
            <span className="absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full px-1 bg-primary font-mono text-2xs font-bold text-primary-foreground ring-2 ring-card">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[330px] overflow-hidden p-0">
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
                    {n.kind === "mention" ? "mentioned you" : "commented"}
                    {n.artifact_title ? (
                      <>
                        {" in "}
                        <strong>{n.artifact_title}</strong>
                      </>
                    ) : null}
                  </span>
                  <span className="my-px block truncate text-xs text-muted-foreground">
                    {n.preview}
                  </span>
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
