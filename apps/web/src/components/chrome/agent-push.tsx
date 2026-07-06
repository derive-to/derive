import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "@/components/ui/sonner"
import { useAuth } from "@/ctx"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { usePageVisible } from "@/lib/use-page-visible"
import { useUserEvent } from "@/lib/use-user-events"
import { parseRef, refFor } from "@/pages/artifact/parse-ref"

// Auto-open on agent push — the browser half of the MCP loop. When YOUR agent
// publishes (the server emits `artifact.pushed` on your user channel, only ever
// to the granting owner), a newly created artifact opens right here; a revision
// you're already viewing live-reloads via the artifact channel, and anything
// else offers a toast. Renders nothing; mounted once in the root.

interface PushedEvent {
  event_id?: string
  short_id: string
  title: string | null
  version: number
  kind: "created" | "revised"
  agent: string
}

// Never act twice on one push: SSE reconnect replay and StrictMode double-fires
// both land here. Small FIFO so the set can't grow unbounded in a long session.
const seen = new Set<string>()
const remember = (id: string) => {
  seen.add(id)
  if (seen.size > 64) {
    const oldest = seen.values().next().value
    if (oldest) seen.delete(oldest)
  }
}

// Don't yank navigation out from under typing: a focused input/textarea/
// contenteditable WITH CONTENT (a comment being written, a doc being edited)
// downgrades auto-open to a toast. An open modal does the same.
const inputHeld = (): boolean => {
  const el = document.activeElement
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)
    return el.value.trim().length > 0
  return el instanceof HTMLElement && el.isContentEditable && !!el.textContent?.trim()
}

export function AgentPushListener() {
  const { me } = useAuth()
  const nav = useNavigate()
  const qc = useQueryClient()
  const visible = usePageVisible()

  useUserEvent(
    "artifact.pushed",
    (e) => {
      let p: PushedEvent
      try {
        p = JSON.parse(e.data) as PushedEvent
      } catch {
        return
      }
      const id = p.event_id ?? `${p.short_id}:${p.version}`
      if (seen.has(id)) return
      remember(id)

      // The library should know about the draft without a reload: the grids and
      // the rail's Unlisted count both ride these queries.
      qc.invalidateQueries({ queryKey: ["artifacts"] })
      qc.invalidateQueries({ queryKey: ["summary"] })

      // Already looking at it → the artifact channel's version.published
      // live-reloads in place; anything more here would be noise.
      const m = window.location.pathname.match(/^\/artifacts\/([^/]+)/)
      if (m?.[1] && parseRef(decodeURIComponent(m[1])).shortId === p.short_id) return

      const ref = refFor({ short_id: p.short_id, title: p.title })
      const open = () => nav({ to: "/artifacts/$ref", params: { ref } })
      const autoOpen = localStorage.getItem(STORAGE_KEYS.autoOpen) !== "off"
      const blocked = !!document.querySelector('[role="dialog"][data-state="open"]')
      if (p.kind === "created" && autoOpen && !blocked && !inputHeld()) {
        open()
        return
      }
      toast(
        p.kind === "created"
          ? `${p.agent} published “${p.title ?? "a new artifact"}”`
          : `${p.agent} published v${p.version} of “${p.title ?? "an artifact"}”`,
        { action: { label: p.kind === "created" ? "Open" : "View", onClick: open } },
      )
    },
    !!me && visible,
  )
  return null
}
