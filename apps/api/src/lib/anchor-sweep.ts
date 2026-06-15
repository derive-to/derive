import {
  type AnchorThread,
  type AnchorTransition,
  type BlobStore,
  type MetaStore,
  planAnchorSweep,
  type VersionRecord,
} from "@dock/core"
import { pageTextResolver } from "./bundle"

/** A thread reduced for the sweep, plus the bundle page it lives on (null = a
 *  single-file artifact or whole-document thread). */
type Thread = AnchorThread & { path: string | null }

/**
 * Re-anchor a published artifact's comment threads against the new version and
 * apply the resulting state flips (open↔outdated). Called after every version
 * bump (publish, restore, proposal approve) so feedback whose quoted text
 * changed is marked `outdated` — and un-marked if the text reappears.
 *
 * Each thread is checked against ITS page's text (single-file artifacts use the
 * whole document; bundle threads use their own page via the manifest), so a
 * comment on one page of a bundle never goes stale because a different page
 * changed. A thread is open/resolved/outdated as a unit, so we collapse its
 * comments to the root's anchor + state + path before planning. One
 * `listComments`, one blob read per referenced page, one `setThreadState` per
 * thread that actually changes — never per comment.
 */
export async function sweepAnchors(
  meta: Pick<MetaStore, "listComments" | "setThreadState">,
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
        thread_id: cm.thread_id,
        anchor: cm.anchor,
        state: cm.state,
        path: cm.path,
      })
      continue
    }
    // The root comment (id == thread_id) is authoritative for the anchor, state,
    // and page; a reply only contributes an anchor if the root somehow lacked one.
    if (cm.id === cm.thread_id) {
      cur.state = cm.state
      cur.path = cm.path
      if (cm.anchor) cur.anchor = cm.anchor
    } else if (!cur.anchor && cm.anchor) {
      cur.anchor = cm.anchor
    }
  }

  const resolveText = await pageTextResolver(blobs, version)
  // Group by page so each page's text is read once, then plan per page.
  const byPage = new Map<string | null, Thread[]>()
  for (const t of byThread.values()) {
    const list = byPage.get(t.path)
    if (list) list.push(t)
    else byPage.set(t.path, [t])
  }

  const transitions: AnchorTransition[] = []
  for (const [path, threads] of byPage) {
    const text = await resolveText(path)
    if (text == null) continue // page no longer resolvable — leave its threads alone
    transitions.push(...planAnchorSweep(threads, text))
  }
  for (const t of transitions) await meta.setThreadState(artifactId, t.thread_id, t.state)
  return transitions
}
