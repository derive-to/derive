import {
  type AnchorThread,
  type AnchorTransition,
  type BlobStore,
  type ElementSelector,
  type MetaStore,
  parseElementSelector,
  planAnchorSweep,
  planElementForwardWalk,
  type VersionRecord,
} from "@dock/core"
import { pageTextResolver } from "./bundle"

/** Forward-walk recovery is one blob read + scan per version, on the publish path.
 *  A genuinely-removed element early-exits at the first hop (cheap), but a recoverable
 *  one drifting across a long history would read every version. Cap the walk to the
 *  most recent N versions so an artifact with a huge history can't turn one republish
 *  into hundreds of blob reads. A comment older than this window simply doesn't get
 *  the gradual-recovery benefit (it still resolves directly if its content held). */
const MAX_WALK_VERSIONS = 60

/** A thread reduced for the sweep, plus the bundle page it lives on (null = a
 *  single-file artifact or whole-document thread) and the version it was made on
 *  (the start of any forward-walk). `id` is the root comment id (== thread_id). */
type Thread = AnchorThread & { id: string; path: string | null; base: number }

type SweepStore = Pick<
  MetaStore,
  "listComments" | "setThreadState" | "listVersions" | "getVersion" | "updateComment"
>

/**
 * Re-anchor a published artifact's comment threads against the new version and
 * apply the resulting state flips (open↔outdated). Called after every version
 * bump (publish, restore, proposal approve) so feedback whose anchor changed is
 * marked `outdated` — and un-marked if it reappears.
 *
 * Text anchors re-grep their quote; element anchors relocate via the cascade
 * against the page's HTML. Each thread is checked against ITS page's content, so a
 * comment on one bundle page never goes stale because a different page changed.
 *
 * The element path adds the Dock-only move: before giving up on an element that
 * doesn't resolve in the new version, FORWARD-WALK it through the version history
 * from where it was made — re-deriving the selector at each hop it still resolves.
 * An element edited gradually (renamed, moved, rewrapped) is recovered because each
 * single-version delta stays resolvable. On recovery we self-heal: the root
 * comment's selector is rewritten to the carried-forward one, so the live client
 * (which resolves in a single jump) can find it too.
 */
export async function sweepAnchors(
  meta: SweepStore,
  blobs: BlobStore,
  artifactId: string,
  version: VersionRecord,
): Promise<AnchorTransition[]> {
  const comments = await meta.listComments(artifactId)
  if (comments.length === 0) return []

  const byThread = new Map<string, Thread>()
  for (const cm of comments) {
    const cur = byThread.get(cm.thread_id)
    if (!cur) {
      byThread.set(cm.thread_id, {
        id: cm.thread_id,
        thread_id: cm.thread_id,
        anchor: cm.anchor,
        state: cm.state,
        path: cm.path,
        base: cm.base_version,
      })
      continue
    }
    // The root comment (id == thread_id) is authoritative for the anchor, state,
    // page, and base version; a reply only contributes an anchor if the root lacked one.
    if (cm.id === cm.thread_id) {
      cur.state = cm.state
      cur.path = cm.path
      cur.base = cm.base_version
      if (cm.anchor) cur.anchor = cm.anchor
    } else if (!cur.anchor && cm.anchor) {
      cur.anchor = cm.anchor
    }
  }

  const resolveText = await pageTextResolver(blobs, version)
  // Group by page so each page's content is read once, then plan per page.
  const byPage = new Map<string | null, Thread[]>()
  for (const t of byThread.values()) {
    const list = byPage.get(t.path)
    if (list) list.push(t)
    else byPage.set(t.path, [t])
  }

  const transitions: AnchorTransition[] = []
  for (const [path, threads] of byPage) {
    const content = await resolveText(path)
    if (content == null) continue // page no longer resolvable — leave its threads alone
    const planned = planAnchorSweep(threads, content)
    // Element threads about to be marked outdated get a forward-walk rescue.
    const rescued = await rescueElements(meta, blobs, artifactId, version, threads, planned)
    transitions.push(...planned.filter((t) => !rescued.has(t.thread_id)))
  }
  for (const t of transitions) await meta.setThreadState(artifactId, t.thread_id, t.state)
  return transitions
}

/**
 * For each element thread the plan wants to mark `outdated`, walk the version
 * history forward and try to recover it. Returns the thread ids that were rescued
 * (so the caller drops their outdated flip). Recovered selectors are persisted to
 * the root comment so the live client resolves them in one jump.
 */
async function rescueElements(
  meta: SweepStore,
  blobs: BlobStore,
  artifactId: string,
  current: VersionRecord,
  threads: Thread[],
  planned: AnchorTransition[],
): Promise<Set<string>> {
  const rescued = new Set<string>()
  const goingStale = new Map<string, Thread>()
  for (const t of planned) {
    if (t.state !== "outdated") continue
    const th = threads.find((x) => x.thread_id === t.thread_id)
    if (th && parseElementSelector(th.anchor)) goingStale.set(th.thread_id, th)
  }
  if (goingStale.size === 0) return rescued

  // Versions up to current, ascending. Read each page's HTML once and reuse across
  // threads on the same page.
  const versions = (await meta.listVersions(artifactId))
    .filter((v) => v.n <= current.n)
    .sort((a, b) => a.n - b.n)
  const htmlCache = new Map<string, string | null>() // `${version} ${path}` -> html

  const htmlAt = async (v: VersionRecord, path: string | null): Promise<string | null> => {
    const key = `${v.n} ${path ?? ""}`
    const hit = htmlCache.get(key)
    if (hit !== undefined) return hit
    const resolve = await pageTextResolver(blobs, v)
    const html = await resolve(path)
    htmlCache.set(key, html)
    return html
  }

  for (const th of goingStale.values()) {
    const start = parseElementSelector(th.anchor)
    if (!start) continue
    let trail = versions.filter((v) => v.n > th.base)
    if (trail.length === 0) continue
    // Bound the work: only walk the most recent versions. (Older history can't turn a
    // single republish into an unbounded read storm.)
    if (trail.length > MAX_WALK_VERSIONS) trail = trail.slice(trail.length - MAX_WALK_VERSIONS)
    const htmls: string[] = []
    for (const v of trail) {
      const html = await htmlAt(v, th.path)
      if (html != null) htmls.push(html)
    }
    if (htmls.length === 0) continue
    const walk = planElementForwardWalk(start, htmls)
    if (!walk.resolved) continue
    rescued.add(th.thread_id)
    // Self-heal: rewrite the root comment's selector to the recovered one (carrying
    // the original snapshot through) so the next sweep + the live client resolve in
    // one jump.
    const healed: ElementSelector = { ...walk.selector, snapshot: start.snapshot }
    if (JSON.stringify(healed) !== th.anchor) {
      await meta.updateComment(th.id, { anchor: JSON.stringify(healed) })
    }
    // If it had drifted to outdated in a prior sweep, bring it back to open.
    if (th.state === "outdated") await meta.setThreadState(artifactId, th.thread_id, "open")
  }
  return rescued
}
