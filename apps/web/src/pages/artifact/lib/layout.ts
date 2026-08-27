import type { Comment } from "@/api"
import { type PinItem, parseAnchor } from "../types"

// Pure grouping for the comment threads. The anchor MODEL (Sel, ParsedAnchor,
// parseAnchor, ElementWire) lives in `../types`; this file only sorts threads.

export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

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
  /** Everything not resolved (open / outdated). */
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
    // for the anchors it was sent (open). An `outdated` thread is NOT sent
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
