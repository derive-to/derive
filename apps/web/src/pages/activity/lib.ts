import type { ActivityItem } from "@/api"

export interface CoalescedActivity {
  kind: ActivityItem["kind"]
  actor: string
  actor_id: string | null
  actor_kind: "user" | "agent"
  artifact_id: string
  artifact_short_id: string
  artifact_title: string | null
  thread_id: string | null
  count: number
  versionMin: number | null
  versionMax: number | null
  preview: string | null
  created_at: string
  ids: string[]
}

// Merge consecutive rows from the SAME actor, on the SAME artifact, doing the SAME
// kind of thing into one story — "Claude published 3 revisions", not three rows.
// Items are already newest-first (the API's order); only ADJACENT runs merge, so
// something else happening in between (a different doc, a different person) still
// breaks the run into separate beats.
export function coalesceActivity(items: ActivityItem[]): CoalescedActivity[] {
  const out: CoalescedActivity[] = []
  for (const item of items) {
    const last = out[out.length - 1]
    const sameRun =
      last &&
      last.kind === item.kind &&
      last.artifact_id === item.artifact_id &&
      (item.actor_id ? last.actor_id === item.actor_id : last.actor === item.actor)
    if (sameRun && last) {
      last.count += 1
      last.ids.push(item.id)
      if (item.version_n != null) {
        last.versionMin =
          last.versionMin == null ? item.version_n : Math.min(last.versionMin, item.version_n)
        last.versionMax =
          last.versionMax == null ? item.version_n : Math.max(last.versionMax, item.version_n)
      }
      // Keep the MOST RECENT preview (items arrive newest-first, so the first one
      // seen for this run already is the most recent — nothing to do here).
      continue
    }
    out.push({
      kind: item.kind,
      actor: item.actor,
      actor_id: item.actor_id,
      actor_kind: item.actor_kind,
      artifact_id: item.artifact_id,
      artifact_short_id: item.artifact_short_id,
      artifact_title: item.artifact_title,
      thread_id: item.thread_id,
      count: 1,
      versionMin: item.version_n,
      versionMax: item.version_n,
      preview: item.preview,
      created_at: item.created_at,
      ids: [item.id],
    })
  }
  return out
}

/** The verb phrase + optional detail line for one coalesced story, e.g.
 *  { action: "published 3 revisions of", detail: "v5 → v8" }. The caller appends the
 *  artifact title as a link after `action`. */
export function describeActivity(a: CoalescedActivity): { action: string; detail?: string } {
  switch (a.kind) {
    case "publish": {
      const range =
        a.versionMin != null && a.versionMax != null && a.versionMin !== a.versionMax
          ? `v${a.versionMin} → v${a.versionMax}`
          : a.versionMax != null
            ? `v${a.versionMax}`
            : undefined
      return a.count > 1
        ? { action: `published ${a.count} revisions of`, detail: range }
        : { action: range ? `published ${range} of` : "published" }
    }
    case "comment":
      return {
        action: a.count > 1 ? `commented ${a.count} times on` : "commented on",
        detail: a.preview ?? undefined,
      }
    case "resolve":
      return { action: a.count > 1 ? `resolved ${a.count} threads on` : "resolved a thread on" }
    case "share":
      return { action: "shared", detail: a.preview ?? undefined }
    case "proposal":
      return a.preview === "approved"
        ? {
            action: "approved a proposal on",
            detail: a.versionMax != null ? `v${a.versionMax} went live` : undefined,
          }
        : { action: "requested changes on a proposal on" }
    case "view":
      return {
        action: "read",
        detail: a.versionMax != null ? `first read of v${a.versionMax}` : undefined,
      }
    default:
      return { action: "acted on" }
  }
}
