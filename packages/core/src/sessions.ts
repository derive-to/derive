import type { VersionRecord } from "./ports"

/**
 * A display-time grouping of consecutive revisions, Docs-style: every publish is
 * still its own immutable version, but the UI shows time-based "sessions" so a
 * burst of saves (or an agent iterating) reads as one entry instead of v41..v58.
 *
 * `n` is the latest revision in the session — the one to view. Storage, @vN
 * URLs, comment base_version, and analytics all stay at revision granularity.
 */
export interface VersionSession {
  /** Latest revision in the session — view this one. */
  n: number
  /** Earliest revision in the session. */
  from_n: number
  /** Revisions collapsed into this session. */
  count: number
  author: string
  /** The agent that produced the session's versions on the author's behalf, by name; null
   *  for the person's own edits. A session never mixes an agent's edits with the person's. */
  agent_name: string | null
  /** Named checkpoint label, or null for an ordinary time-grouped session. */
  name: string | null
  /** ISO time of the latest revision in the session. */
  created_at: string
}

export const DEFAULT_VERSION_WINDOW_MS = 30 * 60_000

/**
 * Group versions into sessions. A new session starts when the author changes,
 * when the gap since the last revision exceeds `windowMs`, or at a named
 * checkpoint (named versions are pinned and never absorb neighbors).
 * Returned newest-first for direct display.
 */
export function groupSessions(
  versions: (Pick<VersionRecord, "n" | "author" | "name" | "created_at"> &
    Partial<Pick<VersionRecord, "agent_id" | "agent_name">>)[],
  windowMs: number = DEFAULT_VERSION_WINDOW_MS,
): VersionSession[] {
  const asc = [...versions].sort((a, b) => a.n - b.n)
  // The grouping key (agent_id) stays internal; the session carries the display name.
  const out: (VersionSession & { agent_id: string | null })[] = []
  for (const v of asc) {
    const last = out[out.length - 1]
    const mergeable =
      last &&
      !v.name &&
      !last.name &&
      last.author === v.author &&
      last.agent_id === (v.agent_id ?? null) &&
      Date.parse(v.created_at) - Date.parse(last.created_at) <= windowMs
    if (mergeable) {
      last.n = v.n
      last.created_at = v.created_at
      last.count += 1
    } else {
      out.push({
        n: v.n,
        from_n: v.n,
        count: 1,
        author: v.author,
        agent_id: v.agent_id ?? null,
        agent_name: v.agent_id ? (v.agent_name ?? null) : null,
        name: v.name ?? null,
        created_at: v.created_at,
      })
    }
  }
  return out.reverse().map(({ agent_id: _key, ...s }) => s)
}
