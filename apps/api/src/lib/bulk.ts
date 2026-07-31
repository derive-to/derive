import { z } from "@hono/zod-openapi"

// The server side of the library's multi-select bar. There is deliberately no "bulk"
// concept in the data model: a bulk route resolves each artifact and runs the SAME
// per-artifact authorization the single-artifact route does, just over a set. That is the
// honest shape, because a library selection routinely mixes artifacts you own with ones
// you only read — one all-or-nothing call would either over-reach or fail the whole batch
// on the first artifact you can't touch.

/** What a bulk mutation did, counted per artifact. `skipped` is not an error — the
 *  artifact wasn't found, or the caller may not perform THIS action on it (tagging a doc
 *  you only read, deleting one you don't own). `failed` is a write that was attempted and
 *  threw. Every /v1/bulk/* route returns this one shape so the client renders a single
 *  consistent "N done · M skipped" line. */
export interface BulkSummary {
  ok: number
  skipped: number
  failed: number
}

export const BulkSummarySchema = z
  .object({
    ok: z.number().describe("Artifacts the operation applied to."),
    skipped: z.number().describe("Not found, or the caller may not do this to it — not an error."),
    failed: z.number().describe("The write was attempted but threw."),
  })
  .openapi("BulkSummary")

/** A hard ceiling on one bulk request. A library selection is human-sized (you check
 *  cards), so this guards against a scripted or pathological call, not a normal limit. */
export const BULK_MAX = 500

// A fan-out width for the authorize/apply passes. It buys real concurrency for anything
// that is NOT Postgres — R2 reads, a hosted-tier subrequest — and on the Node/self-host
// tier it parallelises database work too.
//
// It does NOT parallelise Postgres on the hosted edge, and the comment here used to claim
// it did ("enough to keep a 50-item set from serializing a few hundred DB round-trips").
// The edge opens one pg.Client per invocation (see edge-pg.ts) and node-postgres queues
// everything on it, so eight workers issuing queries produce eight queued queries, not
// eight concurrent ones. Reducing the NUMBER of round trips is the only lever; `resolve`
// is now batched out of the loop entirely for that reason.
const CONCURRENCY = 8

/**
 * The one bulk primitive: resolve every (deduped) shortId UP FRONT in a single batched
 * lookup, then authorize and apply per artifact — bounded-concurrent — returning the
 * {ok, skipped, failed} tally. Not-found or authz-refused counts as `skipped`; a thrown
 * `apply` counts as `failed` and never sinks the rest of the batch. The `allow`/`apply`
 * split is what lets every caller reuse the existing per-artifact authz
 * (`authorize(c, action, a)`) unchanged.
 *
 * `resolveAll` takes the whole id set because resolving one artifact per id was one round
 * trip per id — up to BULK_MAX of them, ~80ms each, before any work happened. Authorization
 * and the writes themselves remain per-artifact by design: authz is a per-artifact question
 * (a selection routinely mixes docs you own with ones you only read) and the writes are
 * genuinely distinct rows. Those are the remaining per-item cost, and batching authz would
 * mean priming the request's actor cache from a multi-artifact grants query — a bigger,
 * auth-sensitive change than this one.
 */
export async function bulkArtifactOp<A>(
  shortIds: string[],
  resolveAll: (shortIds: string[]) => Promise<A[]>,
  allow: (a: A) => Promise<boolean>,
  apply: (a: A) => Promise<void>,
): Promise<BulkSummary> {
  const uniq = [...new Set(shortIds)]
  const summary: BulkSummary = { ok: 0, skipped: 0, failed: 0 }
  const found = await resolveAll(uniq)
  // Ids that resolved to nothing are skipped, exactly as a null `resolve` used to be.
  summary.skipped += uniq.length - found.length
  let next = 0
  const worker = async () => {
    while (next < found.length) {
      const a = found[next++]
      if (a === undefined) break
      if (!(await allow(a))) {
        summary.skipped++
        continue
      }
      try {
        await apply(a)
        summary.ok++
      } catch {
        // A per-artifact failure is data, not an exception — it lands in the tally and the
        // remaining artifacts still run.
        summary.failed++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, found.length) }, worker))
  return summary
}
