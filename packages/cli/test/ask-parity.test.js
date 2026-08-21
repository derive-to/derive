import { describe, expect, it } from "vitest"
import { parseAnswer } from "../src/runner.js"

// ASK PARITY — the CLI's <answer> fields must be read exactly as @derive/core reads them.
//
// Two executors now answer an ask: this CLI runner (a coding agent in a container) and the
// in-process loop substrate. The loop does NOT ship a second <answer> contract — an ask is the
// revision contract on a turn where the model was allowed not to write, plus the fields only a
// waiting person can use. Those fields are the shared part, and this file is what keeps the two
// readings identical.
//
// A disagreement here is not cosmetic. `escalate` routes an answer to a human; `caveats` is how
// an answer says "treat this number with care"; the artifact channel is how a chart reaches the
// asker at all. A copy that read `escalate: "false"` as true would page somebody on every answer
// from one substrate and nobody from the other, and nothing would report an error.
//
// The CLI keeps a hand-copy because it is a dependency-free published package and cannot import
// the TS core at runtime — the same reason the revision contract is duplicated.
// The table below is the spec; packages/core/test/run-contract.test.ts holds core's implementation
// to the SAME table, so changing the reading means changing both and forgetting either fails.

/** The spec, as (name, block fields, expected reading). Deliberately the cases where a
 *  re-implementation actually drifts: coercions, precedence, and clamping. */
const ASK_FIELD_CASES = [
  ["nothing set reads as the quiet defaults", {}, {}],
  // A model writing "true" (or 1) is not a decision to page a human. Only the boolean is.
  ["escalate is the literal boolean, never a truthy string", { escalate: "true" }, {}],
  ["escalate is not a truthy number either", { escalate: 1 }, {}],
  [
    "escalate true carries its reason",
    { escalate: true, escalation_reason: "two sources disagree" },
    { escalate: true, reason: "two sources disagree" },
  ],
  [
    "a non-string reason reads as unstated",
    { escalate: true, escalation_reason: 7 },
    { escalate: true },
  ],
  ["caveats keep only the strings", { caveats: ["a", 3, null, "b"] }, { caveats: ["a", "b"] }],
  ["a caveats that is not a list is no caveats", { caveats: "careful" }, {}],
  // The artifact channel: a page needs a name, inline beats a path, and an inline page too big to
  // carry falls through to the path rather than being dropped on the floor.
  ["an artifact with no title is not an artifact", { artifact: { html: "<h1>x</h1>" } }, {}],
  [
    "an artifact with a blank title is not one either",
    { artifact: { title: "  ", path: "a.html" } },
    {},
  ],
  [
    "inline html wins over a path",
    { artifact: { title: "T", html: "<h1>x</h1>", path: "a.html" } },
    { inlineHtml: "<h1>x</h1>" },
  ],
  [
    "an oversized inline page falls through to the path",
    { artifact: { title: "T", html: "x".repeat(2_000_001), path: "a.html" } },
    { page: { title: "T", path: "a.html" } },
  ],
  [
    "a title is trimmed and clamped to 120",
    { artifact: { title: `  ${"t".repeat(200)}`, path: "a.html" } },
    { page: { title: "t".repeat(120), path: "a.html" } },
  ],
  ["a blank path is not an artifact", { artifact: { title: "T", path: "   " } }, {}],
  [
    "a path is trimmed",
    { artifact: { title: "T", path: "  a.html " } },
    { page: { title: "T", path: "a.html" } },
  ],
]

/** The quiet defaults every case is a delta against. */
const ASK_FIELD_DEFAULTS = {
  escalate: false,
  reason: null,
  caveats: [],
  page: null,
  inlineHtml: null,
}

/** The CLI's reading, normalized to the shared shape. Inline HTML is folded out of `artifact`
 *  because core treats an inline page as what it is — the complete source of a page, which is a
 *  revision — while only a PATH needs a filesystem and therefore its own field. */
const read = (fields) => {
  const out = parseAnswer(`<answer>${JSON.stringify({ body_md: "an answer", ...fields })}</answer>`)
  const a = out.answer
  return {
    escalate: a.escalate,
    reason: a.escalation_reason,
    caveats: a.caveats,
    page: a.artifact?.path ? { title: a.artifact.title, path: a.artifact.path } : null,
    inlineHtml: a.artifact?.html ?? null,
  }
}

describe("ask fields: parity with @derive/core", () => {
  for (const [name, fields, expected] of ASK_FIELD_CASES)
    it(name, () => {
      expect(read(fields)).toEqual({ ...ASK_FIELD_DEFAULTS, ...expected })
    })
})
