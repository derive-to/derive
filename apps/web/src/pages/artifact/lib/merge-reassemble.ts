import type { MergeHunk } from "@/api"

// A resolution for one conflict hunk: take the current live text (ours), the
// editor's own text (theirs), or a hand-written reconciliation of the two.
export type Choice = { pick: "ours" } | { pick: "theirs" } | { pick: "edit"; text: string }

// The separator that rejoins hunk segments into a document, matching how
// @dock/core tokenized it: markdown blocks carry their own separators (join with
// ""), every other kind aligns on lines (join with "\n"). The editor only ever
// publishes markdown or html, and html always comes back as a single whole-blob
// conflict — so the separator there is moot (one segment joins to itself).
export const mergeSeparator = (format: "md" | "html"): string => (format === "md" ? "" : "\n")

// Rebuild the full document from the conflict hunks and the chosen resolution for
// each conflict region. Clean hunks pass through verbatim; a conflict hunk takes
// its picked side. Joining with the kind's separator is the exact inverse of
// core's `hunks.map(toks.join(sep))` decomposition, so a resolved document is
// byte-faithful to what the user assembled.
export const reassembleMerge = (
  hunks: MergeHunk[],
  choices: Record<number, Choice>,
  format: "md" | "html",
): string => {
  const sep = mergeSeparator(format)
  const parts = hunks.map((h, i) => {
    if (h.t === "clean") return h.text
    const c = choices[i]
    if (!c) throw new Error(`unresolved conflict at hunk ${i}`)
    return c.pick === "ours" ? h.ours : c.pick === "theirs" ? h.theirs : c.text
  })
  return parts.join(sep)
}

// Conflict regions and how many have a chosen resolution — drives the publish gate
// and the "(n of m resolved)" label. Clean hunks never need a choice.
export const conflictProgress = (
  hunks: MergeHunk[],
  choices: Record<number, Choice>,
): { total: number; resolved: number } => {
  let total = 0
  let resolved = 0
  hunks.forEach((h, i) => {
    if (h.t !== "conflict") return
    total++
    if (choices[i] != null) resolved++
  })
  return { total, resolved }
}

// True when every conflict hunk has been resolved (so the merge can publish).
export const allResolved = (hunks: MergeHunk[], choices: Record<number, Choice>): boolean => {
  const { total, resolved } = conflictProgress(hunks, choices)
  return resolved === total
}
