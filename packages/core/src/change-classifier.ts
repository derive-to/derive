import type { ChangeKind } from "./autonomy"
import { diffLines } from "./diff"

// The freshness-vs-structural classifier: the WP4→WP2 bridge. It answers the
// one question the autonomy gate needs about a proposed revision — is this a
// freshness refresh (dates, counts, statuses updated in place, the things a
// living declaration names) or a structural edit (sections, list shape, or copy
// added/removed)? Deterministic and cheap: a line diff plus a few structure
// signals, so a cadenced refresh never waits on a model to be classified.
//
// FAIL-SAFE toward structural: anything the heuristic can't confidently call a
// freshness edit is structural, so the gate routes it to a human proposal. A
// freshness answer is a positive claim ("only in-place values moved"); the
// default is caution.

const HEADING = /^\s{0,3}#{1,6}\s/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/
const BLANK = /^\s*$/

// A freshness edit changes VALUES in place (a date, a count, a status word), so the changed
// line keeps most of its tokens. Below this shared-token fraction the line's meaning was
// swapped out wholesale — that is structural, and must not ride the auto-publish lane.
const FRESH_OVERLAP = 0.34

const tokens = (line: string): Set<string> =>
  new Set(
    line
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0),
  )

/** Fraction of the longer line's tokens shared with the other line, in [0,1]. Two blank
 *  lines count as identical; a blank vs a non-blank shares nothing. */
const overlap = (a: string, b: string): number => {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return ta.size === tb.size ? 1 : 0
  let common = 0
  for (const t of ta) if (tb.has(t)) common += 1
  return common / Math.max(ta.size, tb.size)
}

/** True when a line participates in document STRUCTURE — a heading or a list
 *  item. A change that adds, removes, or reshapes one of these is structural. */
const isStructural = (line: string): boolean => HEADING.test(line) || LIST_ITEM.test(line)

/**
 * Classify the change from `before` to `after`.
 *
 * Freshness requires ALL of:
 *  - the net line count is unchanged (nothing added or removed at the block level),
 *  - no heading or list-item line was added, removed, or newly became/ceased to be one,
 *  - every edit is an in-place replacement (a deleted line swapped for one added line).
 * Anything else is structural.
 */
export function classifyChange(before: string, after: string): ChangeKind {
  const ops = diffLines(before, after)
  const added = ops.filter((o) => o.t === "add").map((o) => o.line)
  const deleted = ops.filter((o) => o.t === "del").map((o) => o.line)

  // Nothing changed (or only whitespace-blank churn): trivially a freshness no-op.
  if (added.length === 0 && deleted.length === 0) return "freshness"

  // Block-level growth or shrink is structural by definition.
  if (added.length !== deleted.length) return "structural"

  // A heading or list line on either side of the change means the document's
  // shape moved, not just its values.
  if (added.some(isStructural) || deleted.some(isStructural)) return "structural"

  // Balanced, non-structural line swaps that aren't just blank-line shuffling:
  // in-place value edits. (Pure blank churn already returned above via counts,
  // but guard against a swap of a real line for a blank one, which drops content.)
  if (added.some((l) => BLANK.test(l)) !== deleted.some((l) => BLANK.test(l))) return "structural"

  // Every PROSE line that changed must be an in-place value edit: its replacement keeps most
  // of its tokens. A sentence swapped for wholly different text (a semantic swap, e.g. a
  // prompt-injected agent rewriting a policy line) shares few tokens and is structural, so it
  // routes to a human proposal instead of auto-publishing. Short value lines (a date, a
  // status word, a version, a count — fewer than 4 tokens) are exempt: they legitimately
  // change entirely and can't carry a meaningful injected payload.
  const bestOverlap = (d: string): number => Math.max(...added.map((a) => overlap(d, a)))
  if (deleted.some((d) => tokens(d).size >= 4 && bestOverlap(d) < FRESH_OVERLAP))
    return "structural"

  return "freshness"
}
