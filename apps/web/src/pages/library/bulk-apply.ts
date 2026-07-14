import type { Artifact } from "@/api"

// Applying one organize action to many artifacts.
//
// There is no bulk ROUTE by design. Every artifact in a selection carries its own
// authorization — a library view routinely mixes docs you own with docs you can only
// read — and the existing per-artifact endpoints already gate exactly right. So the
// honest primitive is N gated writes plus a summary of what landed, not one
// all-or-nothing call that a single 403 in the middle would sink. Six at a time keeps
// a 50-card selection quick without opening a connection per card.
const CONCURRENCY = 6

export interface BulkResult {
  ok: number
  failed: number
  // Filtered out BEFORE the call because the caller can't perform it on that artifact
  // (tagging a doc you only read, deleting one you don't own). Named separately from
  // `failed` so the toast can say "skipped" — nothing went wrong, it just wasn't yours.
  skipped: number
}

export async function bulkApply(
  items: Artifact[],
  write: (a: Artifact) => Promise<unknown>,
  skipped = 0,
): Promise<BulkResult> {
  let ok = 0
  let failed = 0
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const a = items[next++]
      if (!a) break
      try {
        await write(a)
        ok++
      } catch {
        // A per-artifact rejection (a 403 the client couldn't predict, a network blip)
        // is data, not an exception: it lands in the summary and the rest still run.
        failed++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
  // Nothing at all landed and it wasn't for lack of trying — surface it as a failure so
  // the mutation primitive's error toast fires and the selection survives for a retry.
  if (ok === 0 && failed > 0) throw new Error(`Couldn’t update ${failed} artifacts.`)
  return { ok, failed, skipped }
}

// One line for the toast: what landed, then anything that didn't.
export function summarize(verb: string, r: BulkResult): string {
  const parts = [`${verb} ${r.ok} ${r.ok === 1 ? "artifact" : "artifacts"}`]
  if (r.skipped > 0) parts.push(`${r.skipped} skipped`)
  if (r.failed > 0) parts.push(`${r.failed} failed`)
  return parts.join(" · ")
}
