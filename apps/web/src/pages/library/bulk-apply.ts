import type { BulkSummary } from "@/api"

// One line for the toast, from the summary a /v1/bulk/* route returns: what landed, then
// anything that didn't. `skipped` is not a failure — the server passed over artifacts the
// caller can't perform this action on (tagging a doc you only read, deleting one you don't
// own), which a mixed library selection routinely includes.
export function summarize(verb: string, r: BulkSummary): string {
  const parts = [`${verb} ${r.ok} ${r.ok === 1 ? "artifact" : "artifacts"}`]
  if (r.skipped > 0) parts.push(`${r.skipped} skipped`)
  if (r.failed > 0) parts.push(`${r.failed} failed`)
  return parts.join(" · ")
}
