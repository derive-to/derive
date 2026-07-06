import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useRef } from "react"
import { api } from "@/api"
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
//
// The live path only reaches a VISIBLE tab (the stream closes while hidden, on
// purpose — an idle tab shouldn't keep the per-user room billed active). So a
// push that lands while every tab is backgrounded would otherwise vanish the
// moment it happens: the bell notification still gets written server-side, but
// nothing here was listening to open it. Regaining visibility catches that up
// from the durable record (`api.notifications()`) instead of just the live
// event, so "away from the browser when it published" behaves the same as
// "watching it happen."

interface PushedEvent {
  event_id?: string
  short_id: string
  title: string | null
  version: number
  kind: "created" | "revised"
  agent: string
}

// Never act twice on one push: SSE reconnect replay, StrictMode double-fires,
// AND the live event vs. the refocus catch-up both reaching the same push land
// here. Small FIFO so the set can't grow unbounded in a long session.
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

// Currently viewing this artifact? The artifact channel's own version.published
// already live-reloads it — auto-open piling a navigate/toast on top is noise.
const viewingArtifact = (shortId: string): boolean => {
  const m = window.location.pathname.match(/^\/artifacts\/([^/]+)/)
  return !!m?.[1] && parseRef(decodeURIComponent(m[1])).shortId === shortId
}

export function AgentPushListener() {
  const { me } = useAuth()
  const nav = useNavigate()
  const qc = useQueryClient()
  const visible = usePageVisible()
  const wasVisible = useRef(visible)

  // `version` is undefined for the refocus catch-up (a notification row doesn't
  // carry one) — only used for the "revised" toast's copy, so it degrades to
  // "published an update" rather than a wrong/missing version number. Stable
  // identity (useCallback) so the refocus effect below can depend on it without
  // re-running every render.
  const act = useCallback(
    (
      id: string,
      short_id: string,
      title: string | null,
      kind: "created" | "revised",
      agent: string,
      version?: number,
    ) => {
      if (seen.has(id)) return
      remember(id)

      // The library should know about the draft without a reload: the grids and
      // the rail's Unlisted count both ride these queries.
      qc.invalidateQueries({ queryKey: ["artifacts"] })
      qc.invalidateQueries({ queryKey: ["summary"] })

      if (viewingArtifact(short_id)) return

      const ref = refFor({ short_id, title })
      const open = () => nav({ to: "/artifacts/$ref", params: { ref } })
      const autoOpen = localStorage.getItem(STORAGE_KEYS.autoOpen) !== "off"
      const blocked = !!document.querySelector('[role="dialog"][data-state="open"]')
      if (kind === "created" && autoOpen && !blocked && !inputHeld()) {
        open()
        return
      }
      toast(
        kind === "created"
          ? `${agent} published “${title ?? "a new artifact"}”`
          : `${agent} published ${version ? `v${version} of ` : "an update to "}“${title ?? "an artifact"}”`,
        { action: { label: kind === "created" ? "Open" : "View", onClick: open } },
      )
    },
    [nav, qc],
  )

  useUserEvent(
    "artifact.pushed",
    (e) => {
      let p: PushedEvent
      try {
        p = JSON.parse(e.data) as PushedEvent
      } catch {
        return
      }
      act(
        p.event_id ?? `${p.short_id}:${p.version}`,
        p.short_id,
        p.title,
        p.kind,
        p.agent,
        p.version,
      )
    },
    !!me && visible,
  )

  // Regaining visibility: fetch the notification feed and catch up on the
  // single newest thing we missed while hidden — bounded to the last few
  // minutes and to unread rows, so reopening a tab from yesterday doesn't
  // dredge up old pushes. Treated as "created" (always eligible to navigate)
  // regardless of whether the underlying push was actually a create or a
  // revision: the live path only withholds navigation to avoid interrupting
  // active reading, which doesn't apply here — nothing was on screen to
  // interrupt while the tab was hidden. Only the newest missed one navigates —
  // several unread rows in the window would otherwise each fire their own
  // `nav()`, and the LAST one processed wins the final URL, landing you on the
  // oldest of the batch instead of the most recent. The bell still lists the
  // rest for you to catch up on manually.
  useEffect(() => {
    if (!me || !visible || wasVisible.current) {
      wasVisible.current = visible
      return
    }
    wasVisible.current = true
    const since = Date.now() - 5 * 60_000
    api
      .notifications()
      .then((r) => {
        const missed = r.notifications.find(
          (n) =>
            !n.read &&
            (n.kind === "publish" || n.kind === "review") &&
            new Date(n.created_at).getTime() >= since,
        )
        if (missed)
          act(
            `n:${missed.id}`,
            missed.artifact_short_id,
            missed.artifact_title,
            "created",
            missed.actor,
          )
      })
      .catch(() => {})
  }, [me, visible, act])

  return null
}
