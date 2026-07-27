/**
 * A run's `meta` blob — one definition of its shape and its semantics.
 *
 * The run table keeps its open-ended result in a JSON text column rather than in columns, which
 * is the right call (outcomes and write shapes evolve; a schema migration per field would not).
 * The cost is that everything touching it has to parse defensively, and that parsing had drifted
 * into five copies across two packages: the store adapters counting reclaim attempts, the finish
 * route counting retries, and the activity view reading the outcome. Same blob, five hand-rolled
 * readers, each free to disagree about what a malformed value means.
 *
 * So the rules live here, once:
 *   - A malformed or absent blob reads as EMPTY, never throws. A bad row must never break a
 *     claim, a sweep, or the activity list.
 *   - A counter that isn't a positive number reads as 0. Corrupt meta must never grant a run
 *     unlimited attempts — the failure has to be toward the cap, not past it.
 *   - Writers merge, never replace: a reclaim must not drop the outcome of the attempt before it.
 *
 * Kept in core (not the API) because both the store adapters and the routes need it, and a
 * shared definition is the only way those two stay honest about the same bytes.
 */

/** The parsed blob. Deliberately open: callers read the fields they own. */
export type RunMeta = Record<string, unknown>

/** Parse a run's meta column. Absent, empty, malformed, or non-object all read as `{}`. */
export const parseRunMeta = (raw: string | null | undefined): RunMeta => {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === "object" && !Array.isArray(v) ? (v as RunMeta) : {}
  } catch {
    return {}
  }
}

/** Read a non-negative counter (`attempts`, `retries`) — anything else is 0, so corrupt meta
 *  fails toward the cap rather than past it. */
export const runCounter = (meta: RunMeta, key: "attempts" | "retries"): number => {
  const n = meta[key]
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * Has this run consumed untrusted EXTERNAL content? If so it can never live-publish — the
 * autonomy gate demotes its writes to proposals (see decideWrite's `tainted`).
 *
 * Two independent sources, unioned here so "what counts as tainted" has exactly one definition:
 *   - `payloads` — a webhook fire body. Untrusted by construction (it is whatever the caller
 *     POSTed), so a run carrying one is tainted from the moment it is claimed.
 *   - `tainted` — stamped mid-run by the tool endpoint when the server proxies a source-tool
 *     call, which is the moment data from an outside system actually enters the run.
 *
 * Read defensively (Array.isArray, === true) because meta is a free-form blob several writers
 * merge into: anything malformed must read as a plain false rather than throwing inside a
 * claim.
 */
export const runTainted = (meta: RunMeta): boolean =>
  meta.tainted === true || (Array.isArray(meta.payloads) && meta.payloads.length > 0)

/** Merge fields into a run's meta and serialize. Merging (not replacing) is the point: an
 *  attempt counter must not erase the previous attempt's outcome or writes. */
export const mergeRunMeta = (raw: string | null | undefined, fields: RunMeta): string =>
  JSON.stringify({ ...parseRunMeta(raw), ...fields })

/** A string field, or null — the shape every reader of `outcome` / `why` actually wants. */
export const runMetaString = (meta: RunMeta, key: string): string | null => {
  const v = meta[key]
  return typeof v === "string" && v ? v : null
}
