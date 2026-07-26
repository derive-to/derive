import type { Comment } from "@/api"
import { type PinItem, parseAnchor } from "../types"

// Pure geometry + grouping for the comment margin. The anchor MODEL (Sel, ParsedAnchor,
// parseAnchor, ElementWire) lives in `../types`; this file only arranges threads.

export const COMPOSER_ID = "__composer__"

export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

// Place pinned thread cards beside their highlights without overlap: stack from
// the top honouring each desired Y + a gap, then if a card is active, pin it to
// its exact Y and push its neighbours out of the way (above and below).
export function layoutPins(
  items: { id: string; desiredY: number }[],
  heights: Record<string, number>,
  activeId: string | null,
  gap: number,
): Record<string, number> {
  const sorted = [...items].sort((a, b) => a.desiredY - b.desiredY)
  const h = (id: string) => heights[id] ?? 116
  const pos: Record<string, number> = {}
  let prevBottom = -1e9
  for (const it of sorted) {
    const y = Math.max(it.desiredY, prevBottom + gap)
    pos[it.id] = y
    prevBottom = y + h(it.id)
  }
  const idx = activeId ? sorted.findIndex((s) => s.id === activeId) : -1
  const act = idx >= 0 ? sorted[idx] : undefined
  if (act) {
    pos[act.id] = act.desiredY
    let limit = act.desiredY
    for (let i = idx - 1; i >= 0; i--) {
      const it = sorted[i]
      if (!it) continue
      let p = pos[it.id] ?? it.desiredY
      if (p + h(it.id) + gap > limit) {
        p = limit - gap - h(it.id)
        pos[it.id] = p
      }
      limit = p
    }
    let top = act.desiredY + h(act.id)
    for (let i = idx + 1; i < sorted.length; i++) {
      const it = sorted[i]
      if (!it) continue
      let p = pos[it.id] ?? it.desiredY
      if (p < top + gap) {
        p = top + gap
        pos[it.id] = p
      }
      top = p + h(it.id)
    }
  }
  return pos
}

export function groupThreads(comments: Comment[]): Comment[][] {
  const map = new Map<string, Comment[]>()
  for (const c of comments) {
    if (!map.has(c.thread_id)) map.set(c.thread_id, [])
    map.get(c.thread_id)?.push(c)
  }
  return [...map.values()]
}

// The live-frame geometry the bucketer reads to decide where each thread belongs.
export type BucketInput = {
  comments: Comment[]
  /** The doc is showing live (not editing, not diffing) — only then do anchors pin. */
  docLive: boolean
  /** Deck position (null on an ordinary document). */
  deck: { i: number; total: number } | null
  /** Which anchor ids the frame reports resolving in the live doc. */
  inDoc: Record<string, boolean>
  /** Per-thread: the slide its anchor landed on (deck artifacts only). */
  landedSlides: Record<string, number | null>
  /** Per-thread: the doc-absolute top of its painted highlight. */
  anchorTops: Record<string, number>
}

export type ThreadBuckets = {
  /** Everything not resolved (open / addressed / outdated). */
  openThreads: Comment[][]
  resolvedThreads: Comment[][]
  /** Threads pinned beside their live highlight in the margin. */
  pinned: PinItem[]
  /** Open threads with no live anchor here — unanchored, orphaned, or off-slide. */
  general: Comment[][]
  openCount: number
}

/**
 * Sort threads into pinned (anchored & present in this live doc), general
 * (unanchored / orphaned / off the current slide), and resolved. Pins drive the
 * margin cards; general waits in the footer drawer. Pure — derived entirely from the
 * geometry the frame reported, so it unit-tests without a DOM.
 */
export function bucketThreads(p: BucketInput): ThreadBuckets {
  const all = groupThreads(p.comments)
  // `outdated` threads (their quoted text changed in a later version) stay in the
  // active list, not the resolved drawer — their anchor no longer resolves, so they
  // fall into the general/orphaned bucket and stay visible to triage.
  const openThreads = all.filter((t) => t[0] && t[0].state !== "resolved")
  const resolvedThreads = all.filter((t) => t[0]?.state === "resolved")
  const pinned: PinItem[] = []
  const general: Comment[][] = []
  // desiredY is DOC-ABSOLUTE — the pin layer subtracts the live scroll once for
  // everyone, so buckets (and the page) never recompute on scroll.
  const pinHere = (t: Comment[], id: string) => {
    const top = p.anchorTops[id]
    pinned.push({ thread: t, desiredY: top != null ? top : 0, located: top != null })
  }
  for (const t of openThreads) {
    const head = t[0]
    if (!head) continue
    const id = head.thread_id
    const a = parseAnchor(head.anchor)
    // Does this thread's anchor resolve in the live doc? The frame reports `inDoc`
    // for the anchors it was sent (open/addressed). An `outdated` thread is NOT sent
    // to the frame, so `inDoc[id]` is undefined — fall back to the server's `anchored`
    // flag rather than defaulting to "present" (which would pin it invisibly at
    // opacity 0 instead of showing it as an orphan in the general list).
    const present = id in p.inDoc ? p.inDoc[id] !== false : head.anchored !== false
    if (p.deck && a) {
      // Deck: a comment belongs to the slide its text actually resolved on (landed),
      // or, until that's known, the slide it was made on (recorded). Pin it only on
      // that slide; otherwise it waits in the drawer with a "Slide N" badge.
      const landed = p.landedSlides[id]
      const effSlide = landed != null ? landed : a.slide
      if (effSlide != null && effSlide !== p.deck.i) general.push(t)
      else if (p.docLive && present) pinHere(t, id)
      else general.push(t)
    } else if (p.docLive && a && present) {
      pinHere(t, id)
    } else {
      general.push(t)
    }
  }
  return { openThreads, resolvedThreads, pinned, general, openCount: openThreads.length }
}

/* === Pin-layer local offset (pure math; the imperative half lives in use-pin-layer) ===
   Cards sit at doc-absolute Ys inside a layer translated by `datum − scrollY − offset`.
   `offset` is the panel's own scroll-like term: positive shifts cards up (revealing a
   dense cluster buried below the panel), negative shifts them down (revealing cards
   anchored in the doc's first pixels, which start above the zone because the zone sits
   `−datum` below the iframe's top — a comment on the title is unreachable otherwise). */

/** A wheel delta in pixels: line-mode (Firefox mice) and page-mode deltas scaled. */
export const normalizeWheel = (deltaY: number, deltaMode: number, pageH: number): number =>
  deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * pageH : deltaY

/**
 * The offset's legal range at the current geometry.
 * - max reveals the bottom of the relaxed stack (`maxBottom` doc-absolute).
 * - min goes negative in exactly two cases:
 *   (a) the doc is at its top — mid-document, wheel-up must scroll the doc
 *       (forwarding), not slide cards down; at the top there is nothing left to
 *       forward, so the remaining gesture may reveal the above-zone band
 *       (`minY + datum` = the topmost card's zone-local Y at scrollY 0);
 *   (b) the ACTIVE item (an open composer, the selected thread) sits above the
 *       zone's top at the current scroll — its reveal must survive the
 *       clamp-on-notify, or a composer opened on a selection near the viewport's
 *       top would be clipped away by the very next scroll message.
 */
export function pinOffsetBounds(p: {
  /** Topmost card's layout Y (doc-absolute). */
  minY: number
  /** Bottom of the lowest card in the relaxed stack (doc-absolute). */
  maxBottom: number
  /** The active item's layout Y (doc-absolute), if any. */
  activeY: number | null
  datum: number
  scrollY: number
  zoneH: number
}): { min: number; max: number } {
  return {
    min: Math.min(
      0,
      p.scrollY <= 1 ? p.minY + p.datum : 0,
      p.activeY != null ? p.activeY + p.datum - p.scrollY : 0,
    ),
    max: Math.max(0, p.maxBottom + p.datum - p.scrollY - p.zoneH),
  }
}

/**
 * Split a wheel delta: the part the local offset absorbs (bounded) and the remainder
 * forwarded to the document. Splitting one event is deliberate — today's all-or-nothing
 * hand-off dropped the tail of the tick that exhausted the local room.
 */
export function consumeWheel(
  offset: number,
  delta: number,
  min: number,
  max: number,
): { offset: number; forward: number } {
  const next = clamp(offset + delta, min, max)
  return { offset: next, forward: delta - (next - offset) }
}
