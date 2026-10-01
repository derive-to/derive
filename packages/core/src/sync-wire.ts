/**
 * A sync on the wire (see `syncStamped` and `SyncReply` in source-edit): the save's or
 * `/sync`'s answer without the two arrays as long as the page, which the page mostly holds
 * already. The editor's host decodes it (apps/web use-auto-save `fromWire`).
 */

import type { StampedSync, SyncReply } from "./source-edit"

/**
 * A sync as sent: a {@link SyncReply} without the two arrays that are as long as the page
 * (tens of thousands of ids on a long deck), which the page mostly holds already.
 *  - `runs`: the remap as runs `[oldId, newId, length]` (old ids outside every run: -1).
 *    One edit renumbers everything after it by the same amount, so a save is a few runs.
 *  - the new source map: the page's own hashes carried through the remap, with `changed`
 *    (`[newId, hash]`) where that differs; `count` ids in all. `hashes` instead, whole,
 *    when the page's can't be carried (a whole-page swap).
 */
export interface SyncWire {
  version: number
  sha: string
  head: boolean
  patches: StampedSync["patches"]
  /** Length of the remap (the old page's id count). */
  from: number
  runs: [number, number, number][]
  count: number
  changed: [number, string][]
  hashes?: string[]
}

/** Encode a sync for the wire, given the source map the page holds (`held`). */
export const syncWire = (reply: SyncReply, held: readonly string[] | null): SyncWire => {
  const { remap, hashes, version, sha, head, patches } = reply
  const runs: [number, number, number][] = []
  for (let o = 0; o < remap.length; o++) {
    const n = remap[o] as number
    if (n < 0) continue
    const last = runs.at(-1)
    if (last && last[0] + last[2] === o && last[1] + last[2] === n) last[2]++
    else runs.push([o, n, 1])
  }
  const base = { version, sha, head, patches, from: remap.length, runs, count: hashes.length }
  if (head || !held) return { ...base, changed: [], hashes }
  const carried = new Array<string | undefined>(hashes.length)
  for (const [o, n, len] of runs)
    for (let k = 0; k < len; k++) if (n + k < hashes.length) carried[n + k] = held[o + k]
  const changed: [number, string][] = []
  hashes.forEach((h, n) => {
    if (carried[n] !== h) changed.push([n, h])
  })
  return { ...base, changed }
}
