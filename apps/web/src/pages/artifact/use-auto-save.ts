import type { SourceOp, SourceToken, SyncReply, SyncWire } from "@derive/core"
import { useEffect, useRef, useState } from "react"
import { ApiError, type Artifact, api, type InlineEditInput, type SourceMap } from "@/api"
import { toast } from "@/components/ui/sonner"
import { STORAGE_KEYS } from "@/lib/storage-keys"

/** A pause this long after the last keystroke saves. */
const IDLE_MS = 750
/** A gesture that ends (a move, a resize, leaving a block) saves this soon: at once, but
 *  after the moment the person is still in the middle of (the next click, the next key). */
const SOON_MS = 200

/** What the save indicator says. */
export type SaveStatus = {
  kind: "saved" | "pending" | "saving" | "offline" | "conflict" | "error"
  /** Edits kept on this device while offline. */
  waiting: number
  /** The page's edit counter the server holds everything up to. */
  savedRev: number
}

const clip = (s: string, n = 28): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// The auto version message for a quote save (Markdown, LaTeX, video): a single edit
// reads as what changed; a batch as a count.
const editMessage = (edits: InlineEditInput[]): string => {
  const first = edits[0]
  if (edits.length !== 1 || !first) return `Inline edits (${edits.length})`
  if ("op" in first && first.op === "resize")
    return `Resized ${first.target.snapshot?.label ?? first.target.tag} to ${first.width}px`
  if ("op" in first) return `Updated video scene ${first.id}`
  return `Inline edit: "${clip(first.quote.exact.trim())}" → "${clip(first.new_text.trim())}"`
}

/** A save's message for exact-source ops: one edit reads as its new words. */
const opsMessage = (ops: SourceOp[]): string => {
  const first = ops[0]
  if (ops.length !== 1 || !first) return `Inline edits (${ops.length})`
  if (first.op === "attrs") return first.attrs ? "Changed a layout" : "Resized an element"
  const words = (ts: SourceToken[]): string =>
    ts.map((t) => ("text" in t ? t.text : "children" in t ? words(t.children ?? []) : "")).join("")
  const text = words(first.children).trim()
  return text ? `Inline edit: "${clip(text)}"` : "Inline edit"
}

/** Ops as sent: every element they name carries its hash from the source map. */
const withHashes = (ops: SourceOp[], hashes: string[]): SourceOp[] => {
  const hash = (n: number) => {
    const h = hashes[n]
    if (h === undefined) throw new Error("The page is out of date. Reload it and edit again.")
    // The source doesn't say where this element ends (misnested markup).
    if (!h)
      throw new Error(
        "Part of this edit is in markup the editor can't save. Use the source editor.",
      )
    return h
  }
  const token = (t: SourceToken): SourceToken =>
    "keep" in t || "tag" in t
      ? {
          ...t,
          ...("keep" in t && { hash: hash(t.keep) }),
          ...(t.children && { children: t.children.map(token) }),
        }
      : t
  return ops.map((o) =>
    o.op === "content"
      ? { ...o, hash: hash(o.src), children: o.children.map(token) }
      : { ...o, hash: hash(o.src) },
  )
}

/** A sync as the frame takes it, from the wire (SyncWire in @derive/core): the remap from
 *  its runs, and the new source map from the one the page holds (`held`). */
const fromWire = (w: SyncWire, held: readonly string[]): SyncReply => {
  const remap = new Array<number>(w.from).fill(-1)
  for (const [o, n, len] of w.runs) for (let k = 0; k < len; k++) remap[o + k] = n + k
  let hashes = w.hashes
  if (!hashes) {
    const next = new Array<string>(w.count).fill("")
    for (const [o, n, len] of w.runs)
      for (let k = 0; k < len && n + k < w.count; k++) next[n + k] = held[o + k] ?? ""
    for (const [n, h] of w.changed) next[n] = h
    hashes = next
  }
  return { version: w.version, sha: w.sha, head: w.head, patches: w.patches, remap, hashes }
}

/** What the frame reports on collect: `ops` (with the version and source sha the page
 *  holds) on a stamped page (HTML or Markdown), quote `edits` everywhere else, and the
 *  edit counter they were taken at. */
export type Collected = {
  edits?: InlineEditInput[]
  ops?: SourceOp[]
  base?: { version: number; sha: string }
  rev?: number
  uncaptured?: number
  stale?: number
}

/** A retry will do: the network, or the server having a moment. */
const retryable = (e: unknown) =>
  !(e instanceof ApiError) || e.status >= 500 || e.status === 429 || e.status === 0
const noChange = (e: unknown) => e instanceof ApiError && /exactly as it is/.test(e.message)

/** A save the server hasn't confirmed, kept on this device until it does (offline, or the
 *  tab closed mid-save) and sent again on the next visit. One per artifact: a save carries
 *  everything that differs from what the server holds. localStorage, because the unload
 *  guard must read it synchronously. */
type QueuedSave = { ops: SourceOp[]; base: number; message: string; session: string; count: number }
const queueKey = (shortId: string) => `${STORAGE_KEYS.editQueue}.${shortId}`
const queuedSave = (shortId: string): QueuedSave | null => {
  try {
    const q = JSON.parse(localStorage.getItem(queueKey(shortId)) ?? "null")
    return q && Array.isArray(q.ops) && typeof q.base === "number" ? q : null
  } catch {
    return null
  }
}
const queueSave = (shortId: string, save: QueuedSave | null) => {
  try {
    if (save) localStorage.setItem(queueKey(shortId), JSON.stringify(save))
    else localStorage.removeItem(queueKey(shortId))
  } catch {
    /* storage full or blocked: the in-memory retry still runs while the page is open */
  }
}

/** The auto-save's state: one session, one save or sync in flight at a time. */
const fresh = () => ({
  session: "",
  /** The frame's edit counter, and the last value the server holds everything of. */
  rev: 0,
  savedRev: 0,
  saving: false,
  syncing: false,
  /** A newer version arrived while busy: take it in when free. */
  remote: false,
  timer: 0,
  remoteTimer: 0,
  /** When the person last changed something: someone else's edit waits for a pause. */
  lastTouch: 0,
  /** A delete's Undo is on screen: its save waits so Undo can simply put it back. */
  holdUntil: 0,
  retry: 0,
  conflictRetry: 0,
  offline: false,
  error: false,
  waiting: 0,
  table: null as Pick<SourceMap, "version" | "sha" | "hashes"> | null,
  /** Bumped when the frame reloads: answers for the old document are dropped. */
  frame: 0,
  /** Save now even if no edit has been reported yet (⌘S, Done): the page is asked. */
  force: false,
  resending: false,
})

/**
 * Auto-save for inline editing: the queue between the page's edits and the server.
 *
 * The frame counts the person's edits (`touch`); a pause, leaving a block, or a
 * gesture ending sends everything that differs from what the server holds, one request
 * at a time, then syncs the page to the result in place (no reload: see
 * packages/core/src/source-sync.ts). Edits made while a save is in flight simply make
 * the next one. A save that can't reach the server is kept on this device and retried
 * with backoff; one someone else's edit got in the way of takes their version in first
 * (the page holds the blocks you have unsaved words in as conflicts) and goes again.
 * Nothing is dropped silently: what can't be saved says so and stays on the page.
 */
export function useAutoSave(p: {
  shortId: string
  art: () => Artifact | undefined
  active: () => boolean
  /** Edits save themselves (live auto-save), or wait for Save / ⌘S / Done. */
  live: () => boolean
  /** Ask the frame something and wait for its answer. */
  ask: <T>(type: string, payload: Record<string, unknown>, reply: string) => Promise<T>
  /** The frame now shows `version`'s content (no reload needed to show it). */
  onSynced: (version: number) => void
  /** A version this page saved (its live event is no news). */
  onOwnVersion: (version: number) => void
  /** The page can't take a version in place: load it fresh, keeping the reader's place. */
  reloadFrame: () => void
  /** Who made `version`, for the name on their edit. */
  authorOf: (version: number) => string
  load: () => void
  onOpenSourceEditor: () => void
}) {
  const pr = useRef(p)
  pr.current = p
  const s = useRef(fresh())
  const [, setTick] = useState(0)
  const refresh = () => setTick((n) => n + 1)
  /** A save that failed for good says so, with the way out. */
  const failed = {
    id: "inline-edit-failed",
    duration: 12_000,
    action: { label: "Open source editor", onClick: () => pr.current.onOpenSourceEditor() },
  }

  const schedule = (ms: number) => {
    const x = s.current
    window.clearTimeout(x.timer)
    x.timer = window.setTimeout(() => void run(), Math.max(ms, x.holdUntil - Date.now(), 0))
  }

  const tableFor = async (base: { version: number; sha: string }) => {
    const x = s.current
    if (x.table?.sha === base.sha) return x.table
    const map = await api.sourceMap(pr.current.shortId, base.version)
    if (map.sha !== base.sha) throw new Error("The page is out of date. Reload it and edit again.")
    x.table = map
    return map
  }

  /** Bring the page to the newest version: after this page's own save (`own`, whose
   *  answer carries the sync as `wire`), or because someone else published. */
  const syncIn = async (own: boolean, wire?: SyncWire) => {
    const x = s.current
    const P = pr.current
    const frame = x.frame
    const table = x.table
    if (!table) {
      if (own) P.reloadFrame()
      return
    }
    let reply: SyncReply
    try {
      reply = fromWire(wire ?? (await api.syncArtifact(P.shortId, table.sha)), table.hashes)
    } catch {
      // Without the sync the page's ids are stale after a save: only a fresh page is safe.
      if (own && frame === x.frame) P.reloadFrame()
      return
    }
    if (frame !== x.frame || (!own && reply.sha === table.sha)) return
    const by = own ? "" : P.authorOf(reply.version)
    // The frame needs the remap and patches; the source map stays here.
    const r = await P.ask<{ ok: boolean; reload?: boolean; lost?: boolean }>(
      "edit-sync",
      { ...reply, hashes: [], own, by },
      "edit-synced",
    )
    if (frame !== x.frame) return
    if (r.lost)
      toast.warning(
        r.ok
          ? "A block was redrawn as saved, and the last few words typed in it didn't carry over."
          : "The page reloaded to catch up, and the last few words typed didn't save.",
        {
          id: "inline-edit-lost",
          description: "Type them again; everything before them is saved.",
          duration: 12_000,
        },
      )
    if (r.ok) {
      x.table = { version: reply.version, sha: reply.sha, hashes: reply.hashes }
      P.onSynced(reply.version)
      return
    }
    x.table = null
    P.reloadFrame()
  }

  const run = async () => {
    const x = s.current
    const P = pr.current
    if (!P.active() || x.saving || x.syncing) return
    const wait = x.holdUntil - Date.now()
    if (wait > 0) return schedule(wait)
    if (x.rev <= x.savedRev && !x.force) return refresh()
    x.force = false
    x.saving = true
    x.error = false
    refresh()
    const frame = x.frame
    let rev = x.rev
    try {
      const c = await P.ask<Collected>("edit-collect", {}, "edit-edits")
      if (frame !== x.frame) return
      rev = typeof c.rev === "number" ? c.rev : rev
      if ((c.uncaptured ?? 0) > 0) {
        x.error = true
        toast.error(
          c.stale
            ? "A block that was already saved as deleted can't be put back here."
            : "Those changes couldn't be captured as edits.",
          {
            ...failed,
            description: c.stale
              ? "Undo it again, or restore that version from History."
              : "Try editing the surrounding sentence too, or use the source editor.",
          },
        )
        return
      }
      const edits = c.edits ?? []
      if (!(c.ops ?? edits).length) {
        x.savedRev = Math.max(x.savedRev, rev)
        x.offline = false
        x.waiting = 0
        return
      }
      const art = P.art()
      if (!art) throw new Error("save fired before the artifact loaded")
      if (c.ops && c.base) {
        const table = await tableFor(c.base)
        const sent = withHashes(c.ops, table.hashes)
        const message = opsMessage(c.ops)
        x.waiting = c.ops.length
        queueSave(P.shortId, {
          ops: sent,
          base: c.base.version,
          message,
          session: x.session,
          count: c.ops.length,
        })
        let wire: SyncWire | undefined
        try {
          const a = await api.publishOps(
            P.shortId,
            sent,
            c.base.version,
            message,
            x.session,
            table.sha,
          )
          P.onOwnVersion(a.current_version)
          wire = a.sync
        } catch (e) {
          if (!noChange(e)) throw e
        }
        queueSave(P.shortId, null)
        if (frame !== x.frame) return
        await syncIn(true, wire)
      } else {
        // Quotes (LaTeX) and video scenes resolve against the current head, and the
        // page's text becomes the new baseline — unless it moved on while this saved.
        const a = await api.publishEdits(
          P.shortId,
          edits,
          art.current_version,
          editMessage(edits),
          x.session,
        )
        P.onOwnVersion(a.current_version)
        const r = await P.ask<{ ok: boolean }>("edit-rebase", { rev }, "edit-rebased")
        if (frame !== x.frame) return
        if (r.ok) P.onSynced(a.current_version)
        else P.reloadFrame()
      }
      x.savedRev = Math.max(x.savedRev, rev)
      x.offline = false
      x.retry = 0
      x.conflictRetry = 0
      x.waiting = 0
    } catch (err) {
      if (frame !== x.frame) return
      if (err instanceof ApiError && err.status === 409 && x.conflictRetry < 3) {
        // Someone changed what this save names. Take their version in (a block you have
        // unsaved words in becomes a choice on the page) and send the rest again.
        x.conflictRetry++
        queueSave(pr.current.shortId, null)
        await syncIn(false).catch(() => {})
        // The next try reads the source map afresh rather than trusting the one carried.
        if (frame === x.frame) x.table = null
        schedule(0)
      } else if (retryable(err) && !(err instanceof Error && /out of date/.test(err.message))) {
        x.offline = true
        x.retry++
        schedule(Math.min(30_000, 1500 * 2 ** Math.min(x.retry - 1, 5)))
      } else {
        x.error = true
        const message =
          err instanceof ApiError
            ? `Nothing was saved: ${err.message}`
            : err instanceof Error
              ? err.message
              : "Couldn't save your edits."
        toast.error(message, failed) // mutation-ignore: bespoke server-message toast with a source-editor fallback action
      }
    } finally {
      if (frame === x.frame) {
        x.saving = false
        if (x.remote) remote()
        else if (x.force && !x.error && !x.offline) schedule(0)
        else if (x.rev > x.savedRev && !x.error && !x.offline && pr.current.live())
          schedule(IDLE_MS)
      }
      refresh()
    }
  }

  /** Someone else published: take it in when nothing of ours is in flight and the
   *  person has paused (a block being typed in never changes under the caret). */
  const remote = () => {
    const x = s.current
    if (!pr.current.active()) return
    if (x.saving || x.syncing) {
      x.remote = true
      return
    }
    const typing = x.lastTouch + IDLE_MS - Date.now()
    if (typing > 0) {
      window.clearTimeout(x.remoteTimer)
      x.remoteTimer = window.setTimeout(remote, typing)
      return
    }
    x.remote = false
    x.syncing = true
    const frame = x.frame
    syncIn(false)
      .catch(() => {})
      .finally(() => {
        if (frame !== x.frame) return
        x.syncing = false
        if (x.remote) remote()
        else if (x.rev > x.savedRev && pr.current.live()) schedule(IDLE_MS)
        refresh()
      })
  }

  // Back online: send what's waiting now rather than at the next backoff.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run reads refs only.
  useEffect(() => {
    const online = () => {
      if (s.current.offline) schedule(0)
    }
    window.addEventListener("online", online)
    return () => window.removeEventListener("online", online)
  }, [])

  // A save still waiting from an earlier visit (the tab closed offline or mid-save):
  // send it now, then show the page as saved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed to the artifact; everything else is read through refs.
  useEffect(() => {
    let timer = 0
    const resend = async () => {
      const x = s.current
      const P = pr.current
      const q = queuedSave(P.shortId)
      if (!q || x.resending || P.active()) return
      x.resending = true
      try {
        const a = await api.publishOps(P.shortId, q.ops, q.base, q.message, q.session)
        queueSave(P.shortId, null)
        P.onOwnVersion(a.current_version)
        P.load()
        P.reloadFrame()
        toast.success(`Saved ${q.count} edit${q.count === 1 ? "" : "s"} made offline`, {
          id: "inline-edit-resent",
        })
      } catch (e) {
        if (noChange(e)) queueSave(P.shortId, null)
        else if (!retryable(e)) {
          queueSave(P.shortId, null)
          toast.error("Edits kept on this device couldn't be applied to the newer version.", {
            id: "inline-edit-resent",
            description: "Someone changed the same blocks meanwhile. Open History to compare.",
            duration: 12_000,
          })
        } else timer = window.setTimeout(resend, 15_000)
      } finally {
        x.resending = false
        refresh()
      }
    }
    void resend()
    window.addEventListener("online", resend)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener("online", resend)
    }
  }, [p.shortId])

  const x = s.current
  const pending = x.rev > x.savedRev
  return {
    status: (conflicts: number): SaveStatus => ({
      kind:
        conflicts > 0
          ? "conflict"
          : x.offline
            ? "offline"
            : x.saving
              ? "saving"
              : x.error && pending
                ? "error"
                : pending
                  ? "pending"
                  : "saved",
      waiting: x.waiting,
      savedRev: x.savedRev,
    }),
    /** Anything the server doesn't hold yet (the unload guard asks this). */
    unsaved: () =>
      (pr.current.active() && (s.current.rev > s.current.savedRev || s.current.saving)) ||
      queuedSave(pr.current.shortId) !== null,
    /** A session opened on a page showing `version`. */
    begin: () => {
      const y = s.current
      window.clearTimeout(y.timer)
      window.clearTimeout(y.remoteTimer)
      Object.assign(y, fresh(), {
        session: crypto.randomUUID(),
        frame: y.frame + 1,
        resending: y.resending,
      })
      refresh()
    },
    /** The page reports the source it shows (as edit mode opens on it): fetch the
     *  element hashes for it now, so the first save doesn't wait. A page older than its
     *  version's source (a save rewrote that version since it loaded) loads fresh first. */
    based: (version: number, sha: string) => {
      const y = s.current
      const frame = y.frame
      api
        .sourceMap(pr.current.shortId, version)
        .then((map) => {
          if (frame !== y.frame || y.table) return
          if (map.sha === sha) y.table = map
          else if (y.rev === 0) pr.current.reloadFrame()
        })
        .catch(() => {})
    },
    /** The session ended: finish it on the server (one version, announced once). */
    end: () => {
      const y = s.current
      window.clearTimeout(y.timer)
      window.clearTimeout(y.remoteTimer)
      if (y.session && y.savedRev > 0)
        api.finishEditSession(pr.current.shortId, y.session).catch(() => {})
      y.session = ""
      y.frame++
    },
    /** The page is going away: finish the session without waiting for an answer. */
    leave: () => {
      const y = s.current
      if (y.session && y.savedRev > 0) api.finishEditSessionBeacon(pr.current.shortId, y.session)
    },
    /** The frame reloaded: its edit counter and ids start over. */
    frameGone: () => {
      const y = s.current
      window.clearTimeout(y.timer)
      Object.assign(y, { rev: 0, savedRev: 0, saving: false, syncing: false, table: null })
      y.frame++
      refresh()
    },
    touch: (rev: number, flush: boolean) => {
      const y = s.current
      // Typing re-renders nothing: the indicator only changes when it turns to "Edited".
      const shown = y.rev > y.savedRev && !y.error
      if (rev > y.rev) y.rev = rev
      if (!flush) y.lastTouch = Date.now()
      y.error = false
      if (!shown) refresh()
      // Without live auto-save the edit waits for Save (⌘S) or Done.
      if (pr.current.live()) schedule(flush ? SOON_MS : IDLE_MS)
    },
    /** Save now (⌘S, leaving a block, a gesture ending). */
    flush: () => {
      s.current.holdUntil = 0
      s.current.force = true
      schedule(0)
    },
    hold: (ms: number) => {
      s.current.holdUntil = Date.now() + ms
    },
    release: () => {
      s.current.holdUntil = 0
      if (pr.current.live()) schedule(IDLE_MS)
    },
    remote,
    /** Save what's left and wait for it (Done): resolves when saved, or when it can't
     *  be (offline, a conflict, an error), or after a few seconds regardless. */
    settle: () =>
      new Promise<void>((resolve) => {
        const y = s.current
        y.holdUntil = 0
        y.force = true
        schedule(0)
        const t0 = Date.now()
        const tick = () => {
          const idle = !y.saving && !y.syncing
          const settled = y.offline || y.error || (!y.force && y.rev <= y.savedRev)
          if ((idle && settled) || Date.now() - t0 > 8000) resolve()
          else window.setTimeout(tick, 80)
        }
        window.setTimeout(tick, 30)
      }),
  }
}
