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

  return "freshness"
}
