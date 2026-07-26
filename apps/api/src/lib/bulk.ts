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

// Enough to keep a 50-item set from serializing a few hundred DB round-trips, without
// opening a connection per artifact.
const CONCURRENCY = 8

/**
 * The one bulk primitive: for each (deduped) shortId, resolve it, authorize it, and apply
 * to the ones that pass — bounded-concurrent — returning the {ok, skipped, failed} tally.
 * Not-found or authz-refused counts as `skipped`; a thrown `apply` counts as `failed` and
 * never sinks the rest of the batch. The `allow`/`apply` split is what lets every caller
 * reuse the existing per-artifact authz (`authorize(c, action, a)`) unchanged.
 */
export async function bulkArtifactOp<A>(
  shortIds: string[],
  resolve: (shortId: string) => Promise<A | null>,
  allow: (a: A) => Promise<boolean>,
  apply: (a: A) => Promise<void>,
): Promise<BulkSummary> {
  const uniq = [...new Set(shortIds)]
  const summary: BulkSummary = { ok: 0, skipped: 0, failed: 0 }
  let next = 0
  const worker = async () => {
    while (next < uniq.length) {
      const shortId = uniq[next++]
      if (shortId === undefined) break
      const a = await resolve(shortId)
      if (!a || !(await allow(a))) {
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
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, uniq.length) }, worker))
  return summary
}
