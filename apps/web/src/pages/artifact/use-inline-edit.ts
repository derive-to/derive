import { type RefObject, useEffect, useRef, useState } from "react"
import { ApiError, type Artifact, api, type QuoteEditInput } from "@/api"
import { toast } from "@/components/ui/sonner"
import { useApiMutation } from "@/lib/use-api-mutation"

const clip = (s: string, n = 28): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// The auto version message: a single edit reads as what changed; a batch as a count.
const editMessage = (edits: QuoteEditInput[]): string => {
  const first = edits[0]
  return edits.length === 1 && first
    ? `Inline edit: "${clip(first.quote.exact.trim())}" → "${clip(first.new_text.trim())}"`
    : `Inline edits (${edits.length})`
}

type SaveOutcome = { kind: "published"; version: number } | { kind: "proposed" } | null

/**
 * The host half of inline editing (click-to-type in the rendered artifact). The
 * frame owns the caret, the snapshots, and the diff→quote construction; this hook
 * owns the MODE — entering it (freezing the shown version so an SSE republish can't
 * reload the frame and wipe typed text), the dirty count the save bar shows, and
 * landing the collected quote edits through publish (editors) or propose
 * (commenters / locked artifacts) with the shared error grammar:
 *
 *  - 409 (a publish raced ours): refetch the head; edits stay in the frame, saving
 *    again re-resolves them against the new version.
 *  - 400 (a quote didn't resolve — formatted markdown spans, markup-crossing
 *    selections): surface the server's precise reason, offer the source editor.
 *
 * The session is bounded by the FRAME's lifetime: `onFrameGone` (wired to the
 * page's iframe onLoad) force-exits with a warning, because a reloaded frame boots
 * with no edit state and silently saving nothing would read as success.
 */
export function useInlineEdit(p: {
  shortId: string
  art: Artifact | undefined
  /** The artifact iframe — inbound edit messages are accepted from THIS window only. */
  frameRef: RefObject<HTMLIFrameElement | null>
  post: (msg: Record<string, unknown>) => void
  load: () => void
  /** The fallback surface when a quote can't be applied inline. */
  onOpenSourceEditor: () => void
  /** Clear selection/composer state the moment edit mode opens. */
  onEnter?: () => void
}) {
  // The version the rendered frame is pinned to while editing — the mode flag AND
  // the freeze in one value (active ⇔ non-null), so no exit path can ever leave
  // the two disagreeing. Freezing keeps `rawSrc` stable, so a concurrent publish
  // updates metadata without reloading the iframe out from under typed text.
  const [frozenVersion, setFrozenVersion] = useState<number | null>(null)
  const [dirty, setDirty] = useState(0)
  const active = frozenVersion !== null
  const activeRef = useRef(false)
  activeRef.current = active
  const collectWait = useRef<{
    nonce: number
    resolve: (e: QuoteEditInput[] | { desync: true }) => void
    timer: number
  } | null>(null)
  const nonceSeq = useRef(0)

  // Every way out of the mode funnels through here. `restoreFrame` posts mode-off
  // (the frame reverts unsaved text and re-arms its normal grammar) — right for
  // Done/stale exits and for a filed PROPOSAL (nothing is live until approval, so
  // the preview must not keep the suggested text painted); wrong for a PUBLISH,
  // where the version bump reloads the frame onto the saved content anyway.
  const exit = (restoreFrame: boolean) => {
    setFrozenVersion(null)
    setDirty(0)
    if (restoreFrame) p.post({ type: "edit-mode", on: false })
  }

  // Leaving the artifact ends the session: without this, edit mode (and the frozen
  // version) would ride along to the NEXT artifact the user navigates to, pinning
  // its shown version to a number from a different document.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed to the artifact change.
  useEffect(() => {
    setFrozenVersion(null)
    setDirty(0)
  }, [p.shortId])

  // The frame's edit-* messages ride the same postMessage channel as the anchor
  // protocol; listening here keeps the central frame router untouched.
  //
  // Trust boundary, stated plainly: this is a WRITE path fed by the sandboxed
  // frame, so inbound messages are accepted only from the artifact iframe's own
  // window — a popup or a nested iframe inside the artifact can't speak here. What
  // that check cannot do is distinguish the injected client from the artifact's OWN
  // scripts (they share the window), which is the protocol's standing model for
  // every message (select, anchor-click, deck…). The blast radius of a forged
  // edit-edits is bounded: it can only alter TEXT of the artifact the author
  // already controls (replacements are escaped / re-sanitized at render), the save
  // still requires this signed-in user's deliberate Save click, and the version
  // history records the exact spans changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: frameRef is a stable ref object; reading .current at event time is the point.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!p.frameRef.current?.contentWindow || e.source !== p.frameRef.current.contentWindow)
        return
      const d = e.data
      if (!d || d.source !== "derive") return
      if (d.type === "edit-state") {
        setDirty(typeof d.dirty === "number" ? d.dirty : 0)
      } else if (d.type === "edit-edits") {
        const w = collectWait.current
        // The nonce pins the reply to THIS collect: a slow page can answer a
        // timed-out collect after a newer one started, and those stale edits must
        // not save (they'd be missing the user's latest typing).
        if (!w || d.nonce !== w.nonce) return
        collectWait.current = null
        clearTimeout(w.timer)
        const edits = Array.isArray(d.edits) ? (d.edits as QuoteEditInput[]) : []
        // The frame counted changed blocks it could not express as edits (or the
        // frame reloaded and lost them): saving "nothing" now would present data
        // loss as success — surface it instead.
        const frameDirty = typeof d.dirty === "number" ? d.dirty : 0
        w.resolve(edits.length === 0 && frameDirty > 0 ? { desync: true } : edits)
      } else if (d.type === "edit-blocked") {
        // A click landed somewhere inline editing can't reach. Quiet + deduped —
        // information, not an alarm.
        toast(
          d.reason === "dynamic"
            ? "That part is generated by the page's own script, so it can't be edited inline."
            : "That control can't be edited inline.",
          { id: "inline-edit-blocked" },
        )
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [])

  const collect = (): Promise<QuoteEditInput[] | { desync: true }> =>
    new Promise((resolve, reject) => {
      const nonce = ++nonceSeq.current
      const timer = window.setTimeout(() => {
        collectWait.current = null
        reject(new Error("The page didn't report its edits. Try again."))
      }, 4000)
      collectWait.current = { nonce, resolve, timer }
      p.post({ type: "edit-collect", nonce })
    })

  const start = () => {
    if (!p.art || active) return
    p.onEnter?.()
    setDirty(0)
    setFrozenVersion(p.art.current_version)
    p.post({ type: "edit-mode", on: true })
  }
  // Done only ever exits CLEAN (the bar swaps to Discard/Save once dirty); the
  // frame-side mode-off also restores any stragglers as a belt-and-suspenders.
  const done = () => exit(true)
  const discard = () => p.post({ type: "edit-restore" })
  /** The frame reloaded (version swap, retry, source editor) — the edit session
   *  died with it. Exit and say so if anything was pending. */
  const onFrameGone = () => {
    if (!activeRef.current) return
    const hadEdits = dirty > 0
    exit(false) // the frame is a fresh document; there is nothing to restore
    if (hadEdits)
      toast.warning("The document reloaded, so unsaved inline edits were discarded.", {
        id: "inline-edit-stale",
      })
  }

  const save = useApiMutation({
    mutationFn: async (): Promise<SaveOutcome | { desync: true }> => {
      const art = p.art
      if (!art) throw new Error("save fired before the artifact loaded")
      const collected = await collect()
      if ("desync" in collected) return collected
      if (!collected.length) return null
      // Base = the CURRENT head, not the frozen view: if a publish landed mid-edit,
      // the quotes re-resolve against the new source (the strict matcher refuses
      // anything that moved), which is the closest thing to a clean auto-merge.
      const base = art.current_version
      const message = editMessage(collected)
      const canPublish = (art.my_role === "editor" || art.my_role === "owner") && !art.locked
      if (canPublish) {
        const a = await api.publishEdits(p.shortId, collected, base, message)
        return { kind: "published", version: a.current_version }
      }
      await api.proposeEdits(p.shortId, collected, base, message)
      return { kind: "proposed" }
    },
    errorToast: false,
    onSuccess: (r) => {
      if (r && "desync" in r) {
        // Changed blocks produced no expressible edits (typed into a spot with
        // nothing to anchor on, or the page's own script churned the DOM). Keep
        // the session so nothing is silently lost; point at the sure path.
        toast.error("Those changes couldn't be captured as text edits.", {
          id: "inline-edit-failed",
          description: "Try editing the surrounding sentence too, or use the source editor.",
          duration: 12_000,
          action: {
            label: "Open source editor",
            onClick: () => {
              exit(true)
              p.onOpenSourceEditor()
            },
          },
        })
        return
      }
      if (!r) {
        exit(true) // nothing actually changed — just leave edit mode
        return
      }
      if (r.kind === "published") {
        // The version bump reloads the frame onto the published content; posting
        // mode-off here would flash the pre-edit text for a beat first.
        exit(false)
        toast.success(`Saved v${r.version}`)
      } else {
        // A proposal does NOT change the live document — no version bump, no frame
        // reload. Mode-off restores the pre-edit text (the suggestion lives in the
        // review queue now) and re-arms the normal read grammar; without it the
        // frame stays edit-locked forever.
        exit(true)
        toast.success("Suggestion sent for review")
      }
      p.load()
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        p.load()
        toast.error("The document changed while you were editing.", {
          id: "inline-edit-conflict",
          description:
            "Your edits are still on the page. Save again to re-check them against the new version.",
          duration: 10_000,
        })
        return
      }
      // Inside useApiMutation's onError (errorToast off): the server's EditError text is
      // the product copy (WHICH edit failed and why), plus a bespoke fallback action the
      // global safety net can't carry. Opening the source editor ends the inline session
      // first — the editor unmounts the frame, and a phantom session pinned to a stale
      // frozen version would otherwise survive underneath it.
      // biome-ignore format: the escape-hatch comment must stay on the toast line.
      toast.error(err instanceof ApiError ? err.message : "Couldn't save your edits.", { // mutation-ignore: bespoke server-message toast with a source-editor fallback action
        id: "inline-edit-failed",
        duration: 12_000,
        action: {
          label: "Open source editor",
          onClick: () => {
            exit(true)
            p.onOpenSourceEditor()
          },
        },
      })
    },
  })

  return {
    active,
    dirty,
    frozenVersion,
    saving: save.isPending,
    start,
    done,
    discard,
    onFrameGone,
    save: () => save.mutate(),
  }
}
