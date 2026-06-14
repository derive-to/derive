import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate, useParams } from "@tanstack/react-router"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { API_BASE, api, type Comment, type Diff, type Mention } from "@/api"
import { useIsMobile, useToast } from "@/components"
import { Icon } from "@/components/icons"
import { ShareButton } from "@/components/ShareDialog"
import { Spinner } from "@/components/shared/spinner"
import { useTopBarSlot } from "@/components/shell-context"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { useAuth } from "@/ctx"
import { artifactQuery, commentsQuery } from "@/lib/queries"
import { STORAGE_KEYS } from "@/lib/storage-keys"
import { cn } from "@/lib/utils"
import { ActionsCtx, type CommentActions } from "./comment-actions"
import { MobileComments, OpenPanel } from "./comment-panels"
import { DiffView } from "./diff-view"
import { CollectionsMenu, ReportButton, StarButton, TagsMenu } from "./header-actions"
import { clamp, groupThreads, parseAnchor } from "./lib/layout"
import { toggleReaction } from "./lib/reactions"
import { parseRef } from "./parse-ref"
import { DeckBar, Presence, Rail } from "./rail-deck"
import type { Panel, PinItem, Sel } from "./types"

// Heavy on-demand surfaces — split out of the artifact route's initial chunk and
// loaded only when the user opens them (review proposals / insights / history).
const ReviewOverlay = lazy(() =>
  import("@/components/review").then((m) => ({ default: m.ReviewOverlay })),
)
const Insights = lazy(() => import("./insights-history").then((m) => ({ default: m.Insights })))
const HistoryDrawer = lazy(() =>
  import("./insights-history").then((m) => ({ default: m.HistoryDrawer })),
)

const PANEL_KEY = STORAGE_KEYS.commentsPanel
const loadPanel = (): Panel => {
  try {
    const v = localStorage.getItem(PANEL_KEY)
    return v === "rail" || v === "hidden" ? v : "open"
  } catch {
    return "open"
  }
}

export function Artifact() {
  const { ref } = useParams({ from: "/a/$ref" })
  const { shortId, version } = parseRef(ref)
  const { me, loading } = useAuth()
  const nav = useNavigate()
  const { toast, show } = useToast()
  const isMobile = useIsMobile()
  // The persistent shell exposes its top-bar region; this page's header actions
  // are portaled into it (the shell is mounted once, above the route Outlet).
  // Its own context, so the artifact page doesn't re-render on shell-state churn.
  const topBarSlot = useTopBarSlot()

  // Artifact metadata + comments come from React Query, so the route loader's
  // intent preload (ensureQueryData) warms exactly what we render here — the
  // click that follows a hover reads straight from cache. Optimistic edits and
  // the SSE live updates below write through the same client.
  const qc = useQueryClient()
  const { data: art, isError: failed } = useQuery(artifactQuery(shortId))
  const { data: comments = [] } = useQuery(commentsQuery(shortId))
  const [editing, setEditing] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  // Which "⋯ More" surface is open (large dialog / drawer).
  const [surface, setSurface] = useState<null | "insights" | "history">(null)
  const [proposeMsg, setProposeMsg] = useState("")
  const [view, setView] = useState<"preview" | "diff">("preview")
  const [diff, setDiff] = useState<Diff | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [viewers, setViewers] = useState<string[]>([])
  const [src, setSrc] = useState("")

  // Comments UI state. On phones the panel is a slide-up sheet that starts
  // closed (document-first); on desktop it restores the saved rail/open state.
  const [panel, setPanel] = useState<Panel>(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width:640px)").matches
      ? "hidden"
      : loadPanel(),
  )
  const [sel, setSel] = useState<{
    selector: Sel
    top: number
    vTop: number
    vBottom: number
    vLeft: number
    vRight: number
  } | null>(null)
  const [composer, setComposer] = useState<{ anchor: Sel | null; top: number | null } | null>(null)
  const [activeThread, setActiveThread] = useState<string | null>(null)
  const [hoverThread, setHoverThread] = useState<string | null>(null)

  // The anchor channel with the sandboxed iframe (see ANCHOR_CLIENT_JS).
  const frame = useRef<HTMLIFrameElement>(null)
  const presentWrap = useRef<HTMLDivElement>(null)
  const [frameReady, setFrameReady] = useState(0)
  const [inDoc, setInDoc] = useState<Record<string, boolean>>({})
  const [anchorTops, setAnchorTops] = useState<Record<string, number>>({})
  const [scrollY, setScrollY] = useState(0)
  // Set when the artifact announces itself as a deck (dock-deck protocol).
  const [deck, setDeck] = useState<{ i: number; total: number } | null>(null)

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage({ source: "dock-host", ...msg }, "*")
  }, [])

  // ---- Live multiplayer cursors (one viewer for everyone — ported from the old
  // server shell). The anchor client inside the iframe relays pointer moves out via
  // postMessage; we publish them (throttled) and render peers as an overlay layer. ----
  const cursorLayer = useRef<HTMLDivElement>(null)
  const cursorSelf = useRef<{ id: string; color: string }>({ id: "", color: "" })
  if (!cursorSelf.current.id) {
    const id = Math.random().toString(36).slice(2, 9)
    let h = 0
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360
    cursorSelf.current = { id, color: `hsl(${h} 72% 52%)` } // tokens-ignore: per-peer identity hue (hashed), not a theme color
  }
  const cursorXY = useRef<[number, number] | null>(null)
  const cursorSentAt = useRef(0)
  const peerCursors = useRef(new Map<string, HTMLDivElement>())
  const cursorTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const sendCursor = useCallback(() => {
    const xy = cursorXY.current
    if (!xy) return
    cursorSentAt.current = Date.now()
    fetch(`${API_BASE}/v1/artifacts/${shortId}/cursor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        id: cursorSelf.current.id,
        name: me?.name ?? me?.email ?? "Guest",
        color: cursorSelf.current.color,
        x: xy[0],
        y: xy[1],
      }),
    }).catch(() => {})
  }, [shortId, me])

  const showPeerCursor = useCallback(
    (d: { id: string; name?: string; color?: string; x: number; y: number }) => {
      if (d.id === cursorSelf.current.id) return
      const layer = cursorLayer.current
      if (!layer) return
      let el = peerCursors.current.get(d.id)
      if (!el) {
        el = document.createElement("div")
        el.className =
          "pointer-events-none absolute left-0 top-0 z-30 transition-[transform,opacity] duration-100"
        // tokens-ignore: #fff is the fixed white cursor outline + label text (contrast on any artifact bg), not a theme color
        el.innerHTML =
          '<svg width="20" height="20" viewBox="0 0 16 20"><path d="M1 1 L1 16 L5 12.5 L8 19 L10.5 18 L7.5 11.5 L13 11.5 Z" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg><b style="position:absolute;left:13px;top:13px;padding:1px 6px;border-radius:5px;color:#fff;font:600 10.5px ui-sans-serif,system-ui;white-space:nowrap"></b>' // tokens-ignore
        layer.appendChild(el)
        peerCursors.current.set(d.id, el)
      }
      const color = d.color || "#655999" // tokens-ignore: lavender fallback only if a peer sends no color
      const svg = el.querySelector("svg")
      if (svg) (svg as SVGElement).style.fill = color
      const tag = el.querySelector("b")
      if (tag) {
        tag.textContent = d.name || "Guest"
        ;(tag as HTMLElement).style.background = color
      }
      const r = layer.getBoundingClientRect()
      el.style.transform = `translate(${(d.x * r.width).toFixed(1)}px, ${(d.y * r.height).toFixed(1)}px)`
      el.style.opacity = "1"
      const prev = cursorTimers.current.get(d.id)
      if (prev) clearTimeout(prev)
      cursorTimers.current.set(
        d.id,
        setTimeout(() => {
          peerCursors.current.get(d.id)?.remove()
          peerCursors.current.delete(d.id)
          cursorTimers.current.delete(d.id)
        }, 8000),
      )
    },
    [],
  )

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data
      if (!d) return
      // A slide deck reporting its position (any HTML that speaks the protocol).
      if (d.source === "dock-deck" && d.type === "state") {
        setDeck({ i: d.i ?? 0, total: d.total ?? 1 })
        return
      }
      if (d.source !== "dock") return
      if (d.type === "select") {
        if (d.selector && d.rect) {
          const fr = frame.current?.getBoundingClientRect()
          const ft = fr?.top ?? 0
          const fl = fr?.left ?? 0
          setSel({
            selector: d.selector,
            top: d.rect.top,
            vTop: ft + d.rect.top,
            vBottom: ft + d.rect.bottom,
            // left/right are sent by the current anchor client; guard against a
            // stale-cached client posting only top/bottom so we never get NaN.
            vLeft: fl + (d.rect.left ?? 0),
            vRight: fl + (d.rect.right ?? d.rect.left ?? 0),
          })
        } else setSel(null)
      } else if (d.type === "anchors-resolved") setInDoc(d.resolved ?? {})
      else if (d.type === "anchor-rects") {
        setAnchorTops(d.tops ?? {})
        if (typeof d.scrollY === "number") setScrollY(d.scrollY)
      } else if (d.type === "scroll") {
        if (typeof d.scrollY === "number") setScrollY(d.scrollY)
      } else if (d.type === "anchor-hover") setHoverThread(d.id ?? null)
      else if (d.type === "anchor-click") {
        setActiveThread(d.id)
        setPanel((p) => (p === "open" ? p : "open"))
      } else if (d.type === "cursor" && typeof d.x === "number" && typeof d.y === "number") {
        cursorXY.current = [d.x, d.y]
        if (Date.now() - cursorSentAt.current >= 45) sendCursor()
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [sendCursor])

  // Persist the collapse state.
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_KEY, panel)
    } catch {
      /* private mode — ignore */
    }
  }, [panel])

  // Keyboard: 'c' toggles the panel open/closed; Escape cancels a composer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.key === "Escape") {
        setComposer(null)
        return
      }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      if (el && /^(input|textarea|select)$/i.test(el.tagName)) return
      if (e.key === "c" || e.key === "C") setPanel((p) => (p === "open" ? "rail" : "open"))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Two-way hover: emphasize the highlight in the doc when a card is hovered.
  useEffect(() => {
    post({ type: "emphasize", id: hoverThread })
  }, [hoverThread, post])

  // Drive the deck from the host bar; fullscreen wraps the iframe + bar so the
  // controls stay reachable while presenting.
  const deckCmd = useCallback(
    (action: "next" | "prev" | "goto", n?: number) =>
      frame.current?.contentWindow?.postMessage(
        { source: "dock-host", type: "deck", action, n },
        "*",
      ),
    [],
  )
  const toggleFullscreen = () => {
    const el = presentWrap.current
    if (!el) return
    if (document.fullscreenElement) document.exitFullscreen()
    else el.requestFullscreen?.()
  }
  // Reset deck state when the artifact/version changes (re-announced on load).
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed to the artifact/version change, not to anything the callback reads.
  useEffect(() => setDeck(null), [shortId, version])
  // Arrow keys drive the deck from the host (when not typing in a field).
  useEffect(() => {
    if (!deck) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return
      if (e.key === "ArrowRight") deckCmd("next")
      else if (e.key === "ArrowLeft") deckCmd("prev")
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [deck, deckCmd])

  // Paint highlights for open, anchored threads whenever the doc or comments change.
  const sendAnchors = useCallback(() => {
    const w = frame.current?.contentWindow
    if (!w) return
    const anchors = groupThreads(comments)
      .filter((t) => t[0].state === "open")
      .map((t) => ({ id: t[0].thread_id, sel: parseAnchor(t[0].anchor) }))
      .filter((x): x is { id: string; sel: NonNullable<ReturnType<typeof parseAnchor>> } => !!x.sel)
      .map((x) => ({ id: x.id, exact: x.sel.exact, prefix: x.sel.prefix, suffix: x.sel.suffix }))
    w.postMessage({ source: "dock-host", type: "anchors", anchors }, "*")
  }, [comments])
  // biome-ignore lint/correctness/useExhaustiveDependencies: frameReady is an intentional repaint trigger (re-send anchors when the iframe reloads).
  useEffect(() => {
    sendAnchors()
  }, [sendAnchors, frameReady])

  // biome-ignore lint/correctness/useExhaustiveDependencies: clears transient selection when the artifact/version changes.
  useEffect(() => {
    setActiveThread(null)
    setComposer(null)
    setSel(null)
  }, [shortId, version])

  // Clicking a thread's quote scrolls the document to its highlight.
  const jumpTo = (threadId: string) => {
    setActiveThread(threadId)
    post({ type: "focus-anchor", id: threadId })
  }

  useEffect(() => {
    // Anonymous can view a public artifact (read-only, with a sign-up CTA). Only
    // bounce to login when it isn't readable for them (private / 404) — then an
    // account is required. A signed-in user with no access bounces the same way.
    if (!loading && !me && failed) nav({ to: "/login" })
  }, [loading, me, failed, nav])

  // Re-pull the artifact + comments from the server (after a publish/restore, or
  // an SSE version.published). The initial fetch is handled by the useQuery hooks
  // above; this just invalidates so they refetch.
  const load = useCallback(() => {
    qc.invalidateQueries({ queryKey: artifactQuery(shortId).queryKey })
    qc.invalidateQueries({ queryKey: commentsQuery(shortId).queryKey })
  }, [qc, shortId])
  // Pull comments fresh (server is the source of truth after a write or SSE ping).
  const refetchComments = useCallback(() => {
    qc.invalidateQueries({ queryKey: commentsQuery(shortId).queryKey })
  }, [qc, shortId])

  // Deep link: ?c=<thread> opens the panel, activates that thread, and jumps to
  // its text. Runs once, after comments are in.
  const deepLinked = useRef(false)
  useEffect(() => {
    if (deepLinked.current || comments.length === 0) return
    deepLinked.current = true
    const cid = new URLSearchParams(window.location.search).get("c")
    if (cid && comments.some((c) => c.thread_id === cid)) {
      setPanel("open")
      setActiveThread(cid)
      setTimeout(() => post({ type: "focus-anchor", id: cid }), 320)
    }
  }, [comments, post])

  // live updates
  useEffect(() => {
    const ev = new EventSource(`${API_BASE}/v1/artifacts/${shortId}/events`, {
      withCredentials: true,
    })
    ev.addEventListener("comment.created", refetchComments)
    ev.addEventListener("comment.resolved", refetchComments)
    ev.addEventListener("comment.reacted", refetchComments)
    ev.addEventListener("comment.updated", refetchComments)
    ev.addEventListener("version.published", load)
    ev.addEventListener("presence", (e) => {
      try {
        setViewers((JSON.parse((e as MessageEvent).data).viewers as string[]) ?? [])
      } catch {
        /* ignore malformed frames */
      }
    })
    ev.addEventListener("cursor", (e) => {
      try {
        showPeerCursor(JSON.parse((e as MessageEvent).data))
      } catch {
        /* ignore malformed frames */
      }
    })
    return () => ev.close()
  }, [shortId, load, refetchComments, showPeerCursor])

  // Announce we're viewing (anon shows up as "Guest" — Google-Docs-style presence),
  // keep the heartbeat alive (TTL 45s), and re-send our cursor so a still pointer
  // doesn't fade out for peers.
  useEffect(() => {
    const name = me ? (me.name ?? me.email) : "Guest"
    const beat = () =>
      api
        .heartbeat(shortId, name)
        .then((r) => setViewers(r.viewers))
        .catch(() => {})
    beat()
    const t = setInterval(beat, 20_000)
    const ct = setInterval(() => {
      if (cursorXY.current) sendCursor()
    }, 3000)
    return () => {
      clearInterval(t)
      clearInterval(ct)
    }
  }, [shortId, me, sendCursor])

  // Record one view per artifact open.
  const recorded = useRef("")
  useEffect(() => {
    if (recorded.current === shortId) return
    recorded.current = shortId
    api.recordView(shortId).catch(() => {})
  }, [shortId])

  // Switching versions returns to the rendered preview.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets the view on a version/artifact change.
  useEffect(() => setView("preview"), [version, shortId])

  // In history mode, "show changes" diffs the version being viewed against the
  // current one — what's changed since this older version.
  useEffect(() => {
    if (view !== "diff" || !art) return
    const shownN = version ?? art.current_version
    if (shownN >= art.current_version) {
      setDiff(null)
      return
    }
    setDiff(null)
    let alive = true
    api
      .diff(shortId, shownN, art.current_version)
      .then((d) => alive && setDiff(d))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [view, version, art, shortId])

  if (failed)
    return (
      <div className="grid h-full place-items-center gap-2.5">
        <div className="text-muted-foreground">Artifact not found, or you don't have access.</div>
        <Button
          variant="outline"
          data-testid="artifact-notfound-back"
          onClick={() => nav({ to: "/" })}
        >
          Back to library
        </Button>
      </div>
    )
  if (!art)
    return (
      <div className="grid h-full place-items-center">
        <Spinner />
      </div>
    )

  // Removed artifacts show a tombstone instead of the document — content is
  // gone (the server 410s the raw routes), but an owner can still reinstate.
  if (art.removed)
    return (
      <div className="grid h-full place-items-center gap-3 text-center">
        <Icon name="removed" size={40} className="opacity-55" />
        <div className="text-lg font-semibold">This artifact was removed</div>
        <div className="max-w-[360px] text-sm leading-relaxed text-muted-foreground">
          It was taken down by a moderator and is no longer available.
        </div>
        <div className="flex gap-2">
          {art.my_role === "owner" && (
            <Button
              variant="outline"
              data-testid="artifact-reinstate"
              onClick={async () => {
                try {
                  await api.reinstate(shortId)
                  show("Reinstated")
                  load()
                } catch (e) {
                  show((e as Error).message)
                }
              }}
            >
              Reinstate
            </Button>
          )}
          <Button
            variant="outline"
            data-testid="artifact-removed-back"
            onClick={() => nav({ to: "/" })}
          >
            Back to library
          </Button>
        </div>
      </div>
    )

  const shown = version ?? art.current_version
  const editable = art.kind === "file" && shown === art.current_version
  const rawSrc = `${API_BASE}/raw/${shortId}/v/${shown}/index.html`
  // Editors publish directly; commenters propose a candidate for review.
  const canPublish = art.my_role === "editor" || art.my_role === "owner"
  const canPropose = canPublish || art.my_role === "commenter"
  // A logged-out visitor on a public/link artifact: strictly view-only. They get
  // the document + live presence/cursors (Google-Docs style) and nothing else —
  // no favorite, tags, collections, share, report, comments, or version tools.
  // The API gates every one of those for anon (anonLocked); hiding them here keeps
  // the chrome honest so there's no dead/forbidden affordance to bump into.
  const isAnon = !me

  // Sort threads into pinned (anchored & present in this live doc), general
  // (unanchored or orphaned), and resolved. Pins drive both the margin cards
  // and the collapsed rail dots.
  const docLive = !editing && view === "preview"
  const all = groupThreads(comments)
  const openThreads = all.filter((t) => t[0].state === "open")
  const resolvedThreads = all.filter((t) => t[0].state === "resolved")
  const pinned: PinItem[] = []
  const general: Comment[][] = []
  for (const t of openThreads) {
    const id = t[0].thread_id
    const hasAnchor = !!parseAnchor(t[0].anchor)
    const present = inDoc[id] !== false
    if (docLive && hasAnchor && present) {
      const top = anchorTops[id]
      pinned.push({ thread: t, desiredY: top != null ? top - scrollY : 0, located: top != null })
    } else {
      general.push(t)
    }
  }
  const openCount = openThreads.length

  const startEdit = async () => {
    setEditing(true)
    setSrc(await api.getContent(shortId))
  }
  const publishEdit = async () => {
    try {
      const a = await api.publishText(
        shortId,
        src,
        art.title ? `${art.short_id}.md` : "edit.md",
        "edited in browser",
      )
      show(`Published v${a.current_version}`)
      setEditing(false)
      load()
    } catch (e) {
      show((e as Error).message)
    }
  }
  // A commenter can't publish; their edit becomes a proposal for review. The
  // message is the "why" the reviewer reads, so we ask for it before sending.
  const proposeEdit = async () => {
    try {
      await api.propose(
        shortId,
        src,
        art.title ? `${art.short_id}.md` : "edit.md",
        proposeMsg.trim() || "Proposed change",
      )
      show("Proposed — sent for review")
      setEditing(false)
      setProposeMsg("")
      load()
    } catch (e) {
      show((e as Error).message)
    }
  }
  const addComment = async (
    text: string,
    opts?: { threadId?: string; anchor?: Sel | null; mentions?: Mention[] },
  ) => {
    if (!text.trim()) return
    await api
      .comment(shortId, {
        body_md: text,
        thread_id: opts?.threadId,
        anchor: opts?.threadId ? undefined : (opts?.anchor ?? undefined),
        mentions: opts?.mentions?.length ? opts.mentions : undefined,
      })
      .catch((e) => show((e as Error).message))
    refetchComments()
  }
  const reply = (text: string, threadId: string, mentions: Mention[] = []) =>
    addComment(text, { threadId, mentions })
  const submitNew = async (text: string, mentions: Mention[] = []) => {
    await addComment(text, { anchor: composer?.anchor ?? null, mentions })
    setComposer(null)
    setSel(null)
  }
  const toggleResolve = async (root: Comment) => {
    await api.resolve(shortId, root.id, root.state === "open" ? "resolved" : "open")
    refetchComments()
  }
  const activate = (id: string) => {
    setActiveThread((cur) => (cur === id ? cur : id))
    post({ type: "emphasize", id })
  }
  const startSelComment = () => {
    if (!sel) return
    setComposer({ anchor: sel.selector, top: sel.top })
    setActiveThread(null)
  }
  const actions: CommentActions = {
    meName: me?.name ?? me?.email ?? "",
    react: (commentId, emoji) => {
      // Optimistic: reflect the toggle in the cache immediately, reconcile on
      // the response.
      qc.setQueryData(commentsQuery(shortId).queryKey, (cs) =>
        (cs ?? []).map((c) =>
          c.id === commentId ? toggleReaction(c, emoji, me?.name ?? me?.email ?? "anonymous") : c,
        ),
      )
      api.react(shortId, commentId, emoji).then(refetchComments).catch(refetchComments)
    },
    edit: async (commentId, body) => {
      await api.editComment(shortId, commentId, body).catch((e) => show((e as Error).message))
      refetchComments()
    },
    remove: (commentId) => {
      api
        .deleteComment(shortId, commentId)
        .then(refetchComments)
        .catch((e) => show((e as Error).message))
    },
    copyLink: (threadId) => {
      const url = `${window.location.origin}${window.location.pathname}?c=${threadId}`
      navigator.clipboard
        ?.writeText(url)
        .then(() => show("Link copied"))
        .catch(() => show(url))
    },
  }
  const restore = async (n: number) => {
    setRestoring(true)
    try {
      const a = await api.restore(shortId, n)
      show(`Restored as v${a.current_version}`)
      nav({ to: "/a/$ref", params: { ref: shortId } }) // jump to the new current
      load()
    } catch (e) {
      show((e as Error).message)
    } finally {
      setRestoring(false)
    }
  }

  // On phones the comments live in a slide-up sheet, so the in-flow aside has
  // no width and the document gets the full screen.
  const asideWidth = isMobile ? 0 : panel === "open" ? 340 : panel === "rail" ? 50 : 0

  return (
    <>
      {topBarSlot &&
        createPortal(
          <>
            {!isMobile && <Presence viewers={viewers} self={me?.name ?? me?.email ?? ""} />}
            {!isAnon && (
              <>
                <StarButton
                  shortId={shortId}
                  favorite={!!art.favorite}
                  onChange={(fav) =>
                    qc.setQueryData(artifactQuery(shortId).queryKey, (a) =>
                      a ? { ...a, favorite: fav } : a,
                    )
                  }
                />
                <TagsMenu
                  shortId={shortId}
                  tags={art.tags ?? []}
                  canEdit={art.my_role === "editor" || art.my_role === "owner"}
                  onChange={(tags) =>
                    qc.setQueryData(artifactQuery(shortId).queryKey, (a) =>
                      a ? { ...a, tags } : a,
                    )
                  }
                />
                <CollectionsMenu
                  shortId={shortId}
                  inCollections={art.collections ?? []}
                  onChange={(collections) =>
                    qc.setQueryData(artifactQuery(shortId).queryKey, (a) =>
                      a ? { ...a, collections } : a,
                    )
                  }
                />
                <ShareButton shortId={shortId} myRole={art.my_role} />
                <ReportButton shortId={shortId} onDone={show} />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      title="More"
                      data-testid="artifact-more"
                      className={cn(
                        art.open_proposals &&
                          art.open_proposals > 0 &&
                          "border-primary text-primary",
                      )}
                    >
                      <Icon name="more" size={18} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem
                      data-testid="artifact-insights"
                      onSelect={() => setSurface("insights")}
                    >
                      <Icon name="insights" size={16} /> Insights
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      data-testid="artifact-history"
                      onSelect={() => setSurface("history")}
                    >
                      <Icon name="history" size={16} /> Version history
                    </DropdownMenuItem>
                    {!!art.proposals_total && art.proposals_total > 0 && (
                      <DropdownMenuItem
                        data-testid="artifact-review"
                        onSelect={() => setReviewing(true)}
                      >
                        <Icon name="review" size={16} />
                        {art.open_proposals && art.open_proposals > 0
                          ? `Review proposals (${art.open_proposals})`
                          : "Proposals"}
                      </DropdownMenuItem>
                    )}
                    {editable && canPropose && !editing && (
                      <DropdownMenuItem data-testid="artifact-edit" onSelect={startEdit}>
                        <Icon name="edit" size={16} />
                        {canPublish ? "Edit source (dev)" : "Propose change (dev)"}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                {/* On phones the bottom-right FAB opens comments, so the header
                button would just be a redundant extra wrap-row. */}
                {!isMobile && panel !== "open" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    data-testid="artifact-show-comments"
                    onClick={() => setPanel("open")}
                    title="Show comments (c)"
                  >
                    <Icon name="comments" size={16} />
                    {openCount > 0 && <b className="font-bold">{openCount}</b>}
                  </Button>
                )}
              </>
            )}
          </>,
          topBarSlot,
        )}
      <ActionsCtx.Provider value={actions}>
        {reviewing && (
          <Suspense fallback={null}>
            <ReviewOverlay
              shortId={shortId}
              currentVersion={art.current_version}
              myRole={art.my_role}
              meName={me?.name ?? me?.email ?? null}
              onClose={() => setReviewing(false)}
              onApplied={load}
            />
          </Suspense>
        )}
        {surface === "insights" && (
          <Suspense fallback={null}>
            <Insights
              shortId={shortId}
              title={art.title}
              open
              onOpenChange={(o) => setSurface(o ? "insights" : null)}
            />
          </Suspense>
        )}
        {surface === "history" && (
          <Suspense fallback={null}>
            <HistoryDrawer
              art={art}
              shown={shown}
              goTo={(n) =>
                nav({
                  to: "/a/$ref",
                  params: { ref: n === art.current_version ? shortId : `${shortId}@v${n}` },
                })
              }
              open
              onOpenChange={(o) => setSurface(o ? "history" : null)}
            />
          </Suspense>
        )}
        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              // On phones, the comments sheet sits in the bottom half — reserve
              // that space so the document stays visible above it (and a
              // jumped-to highlight lands in view, not behind the sheet).
              "relative flex min-w-0 flex-1 flex-col transition-[padding] duration-[260ms]",
              isMobile && panel === "open" && "pb-[50vh]",
            )}
          >
            {editing ? (
              <div className="fixed inset-0 z-[70] flex flex-col bg-card">
                <div className="flex items-center gap-2 border-b border-border-soft px-4 py-2.5">
                  <Icon name="edit" size={16} />
                  <span className="font-mono text-xs text-muted-foreground">
                    {canPublish ? `Editing source · ${art.title ?? shortId}` : "Proposing a change"}
                  </span>
                  {/* The proposer's "why" — shown to the reviewer. Editors who
                      publish directly don't need it. */}
                  {!canPublish && (
                    <Input
                      value={proposeMsg}
                      onChange={(e) => setProposeMsg(e.target.value)}
                      placeholder="What are you changing, and why?"
                      data-testid="artifact-propose-message"
                      className="h-8 max-w-[420px] flex-1 text-sm"
                    />
                  )}
                  <span className="flex-1" />
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="artifact-edit-cancel"
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </Button>
                  {canPublish ? (
                    <Button
                      variant="primary"
                      size="sm"
                      data-testid="artifact-publish-version"
                      onClick={publishEdit}
                    >
                      Publish new version
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      data-testid="artifact-propose-submit"
                      onClick={proposeEdit}
                    >
                      Propose change
                    </Button>
                  )}
                </div>
                <textarea
                  value={src}
                  onChange={(e) => setSrc(e.target.value)}
                  spellCheck={false}
                  data-testid="artifact-source-editor"
                  className="flex-1 resize-none border-0 bg-card px-5 py-4 font-mono text-sm leading-relaxed text-foreground outline-none"
                />
              </div>
            ) : (
              <>
                {/* History-viewing banner: only when looking at a past version.
                  The current version just shows the artifact, no version chrome. */}
                {shown !== art.current_version && (
                  <div className="flex flex-wrap items-center gap-2.5 gap-y-1.5 border-b border-border-soft bg-accent px-3.5 py-2 text-sm">
                    <span className="font-semibold text-primary">Viewing an earlier version</span>
                    <span className="text-muted-foreground">·</span>
                    <button
                      type="button"
                      data-testid="artifact-toggle-diff"
                      className="text-primary underline underline-offset-2 hover:opacity-80"
                      onClick={() => setView(view === "diff" ? "preview" : "diff")}
                    >
                      {view === "diff" ? "Hide changes" : "Show changes since this"}
                    </button>
                    <span className="flex-1" />
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="artifact-restore"
                      onClick={() => restore(shown)}
                      disabled={restoring}
                    >
                      {restoring ? "Restoring…" : "Restore this version"}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      data-testid="artifact-back-to-current"
                      onClick={() => nav({ to: "/a/$ref", params: { ref: shortId } })}
                    >
                      Back to current
                    </Button>
                  </div>
                )}
                {view === "diff" && shown !== art.current_version ? (
                  <DiffView diff={diff} fromLabel={`v${shown}`} toLabel="current" />
                ) : (
                  <div ref={presentWrap} className="relative flex min-h-0 flex-1 flex-col bg-white">
                    <iframe
                      ref={frame}
                      onLoad={() => setFrameReady((n) => n + 1)}
                      title={art.title ?? shortId}
                      src={rawSrc}
                      allow="fullscreen"
                      sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
                      className="flex-1 border-0 bg-white"
                    />
                    {deck && (
                      <DeckBar
                        deck={deck}
                        onPrev={() => deckCmd("prev")}
                        onNext={() => deckCmd("next")}
                        onFullscreen={toggleFullscreen}
                      />
                    )}
                    {/* Live peer cursors (Google-Docs style). The iframe is a
                        separate opaque origin, so its anchor script forwards
                        mousemove out via postMessage; we paint the dots here in
                        the parent, over the frame. Anon viewers see + are seen. */}
                    <div
                      ref={cursorLayer}
                      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
                    />
                  </div>
                )}
              </>
            )}
            {!isAnon && panel === "hidden" && (
              <button
                type="button"
                onClick={() => setPanel("open")}
                title="Show comments (c)"
                data-testid="artifact-comments-fab"
                className="absolute bottom-[18px] right-[18px] flex h-11 items-center gap-2 rounded-full border border-border bg-card px-4 text-sm font-semibold text-foreground shadow-[var(--shadow)]"
              >
                <Icon name="comments" size={18} />
                {openCount > 0
                  ? `${openCount} comment${openCount === 1 ? "" : "s"}`
                  : "Show comments"}
              </button>
            )}
          </div>

          {!isMobile && !isAnon && (
            <aside
              className={cn(
                "flex min-h-0 shrink-0 grow-0 flex-col overflow-hidden bg-card transition-[width,flex-basis] duration-200",
                panel !== "hidden" && "border-l border-border",
              )}
              style={{ width: asideWidth, flexBasis: asideWidth }}
            >
              {panel === "rail" ? (
                <Rail
                  pins={pinned}
                  generalCount={general.length}
                  active={activeThread}
                  onExpand={() => setPanel("open")}
                  onHide={() => setPanel("hidden")}
                  onDot={(id) => {
                    setPanel("open")
                    jumpTo(id)
                  }}
                />
              ) : (
                <OpenPanel
                  openCount={openCount}
                  pinned={pinned}
                  general={general}
                  resolved={resolvedThreads}
                  activeThread={activeThread}
                  hoverThread={hoverThread}
                  inDoc={inDoc}
                  composer={composer}
                  onMinimize={() => setPanel("rail")}
                  onHide={() => setPanel("hidden")}
                  onActivate={activate}
                  onHover={setHoverThread}
                  onResolve={toggleResolve}
                  onReply={reply}
                  onJump={jumpTo}
                  onNewGeneral={() => {
                    setComposer({ anchor: null, top: null })
                    setActiveThread(null)
                  }}
                  onSubmitNew={submitNew}
                  onCancelNew={() => {
                    setComposer(null)
                    setSel(null)
                  }}
                />
              )}
            </aside>
          )}
        </div>
        {/* Phones: comments live in a slide-up sheet that takes the bottom half,
          so the document stays visible above it. A flat thread list (no document
          margin); tapping a quote scrolls the visible document to the highlight
          without closing the sheet. The grip expands it to full for reading. */}
        {isMobile && !isAnon && (
          <MobileComments
            open={panel === "open"}
            openThreads={openThreads}
            resolved={resolvedThreads}
            openCount={openCount}
            composer={composer}
            activeThread={activeThread}
            inDoc={inDoc}
            onClose={() => {
              setPanel("hidden")
              setComposer(null)
              setSel(null)
            }}
            onNewGeneral={() => {
              setComposer({ anchor: null, top: null })
              setActiveThread(null)
            }}
            onActivate={activate}
            onResolve={toggleResolve}
            onReply={reply}
            onJump={jumpTo}
            onSubmitNew={submitNew}
            onCancelNew={() => {
              setComposer(null)
              setSel(null)
            }}
          />
        )}
        {/* The "comment on selection" affordance floats beside the selection in
          every panel state — minimized or hidden included. Clicking it opens
          the panel if needed and starts a composer pinned to the selection.
          Hidden for anon (commenting is logged-in only). */}
        {!isAnon && docLive && sel && !composer && (
          <button
            type="button"
            className="fixed z-50 inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-primary bg-card px-3.5 py-2 text-sm font-semibold text-primary shadow-[var(--shadow)] transition-colors hover:bg-primary hover:text-primary-foreground"
            title="Comment on the selection"
            data-testid="comment-on-selection"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (panel !== "open") setPanel("open")
              startSelComment()
            }}
            style={{
              // Float just above the selection, horizontally centered on it, so it
              // lands where the user is actually reading. Clamp into the document
              // column (left of the aside) and below the top header.
              top: clamp(sel.vTop - 44, 64, window.innerHeight - 52),
              left: clamp(
                (sel.vLeft + sel.vRight) / 2 - 60,
                12,
                window.innerWidth - asideWidth - 132,
              ),
            }}
          >
            <Icon name="comments" size={16} /> Comment
          </button>
        )}
        {toast}
      </ActionsCtx.Provider>
    </>
  )
}
