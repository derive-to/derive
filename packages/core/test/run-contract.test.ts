import { describe, expect, it } from "vitest"
import {
  ASK_CONTRACT,
  MAX_ARTIFACT_CHARS,
  parseAsk,
  parseRevision,
  REVISION_CONTRACT,
} from "../src/run-contract"

// The run contract, held to the same spec as the CLI's hand-copy.
//
// packages/cli/test/contract-parity.test.js asserts the identical cases against the CLI's
// implementation. Two copies exist because the CLI is a dependency-free published package and
// cannot import this module at runtime; these two test files are what stop them drifting.
//
// The cases are chosen for where a re-implementation actually diverges. Not "does valid JSON
// parse" — every copy manages that — but the forgiving branches, which are easy to write
// slightly differently and impossible to notice in production.
describe("run contract: parseRevision", () => {
  const block = (obj: unknown) => `Some preamble.\n<revision>${JSON.stringify(obj)}</revision>`

  it("accepts a well-formed block", () => {
    const out = parseRevision(
      block({ content: "# Hi", filename: "notes.md", confidence: 0.9, message: "note" }),
    )
    expect(out.revision).toEqual({
      content: "# Hi",
      filename: "notes.md",
      confidence: 0.9,
      message: "note",
    })
  })

  it("strips ``` fences the model wrapped the JSON in", () => {
    const out = parseRevision(
      '<revision>```json\n{"content":"# Hi","filename":"a.md"}\n```</revision>',
    )
    expect(out.revision?.content).toBe("# Hi")
  })

  it("falls back to index.html when the filename sets no content type", () => {
    expect(parseRevision(block({ content: "x", filename: "README" })).revision?.filename).toBe(
      "index.html",
    )
    expect(parseRevision(block({ content: "x" })).revision?.filename).toBe("index.html")
  })

  it("clamps an out-of-range confidence and nulls a non-numeric one", () => {
    // The null case matters because the value is SHOWN to people: a string "0.9" must read
    // as unstated on every substrate alike, or two readers of the same reply display two
    // different answers. Clamping, by contrast, keeps completed work rather than failing
    // a run over a model saying 1.5 when it meant "very sure".
    expect(parseRevision(block({ content: "x", confidence: 1.5 })).revision?.confidence).toBe(1)
    expect(parseRevision(block({ content: "x", confidence: -2 })).revision?.confidence).toBe(0)
    expect(
      parseRevision(block({ content: "x", confidence: "0.9" })).revision?.confidence,
    ).toBeNull()
    expect(parseRevision(block({ content: "x" })).revision?.confidence).toBeNull()
  })

  it("refuses what it must never guess", () => {
    // `content` is the one field with no safe fallback — inventing one publishes silence.
    expect(parseRevision("no block here").error).toMatch(/no <revision> block/)
    expect(parseRevision("<revision>not json</revision>").error).toMatch(/parse/)
    expect(parseRevision(block({ content: "   " })).error).toMatch(/non-empty/)
    expect(parseRevision(block({ filename: "a.md" })).error).toMatch(/non-empty/)
    expect(parseRevision(block({ content: "x".repeat(MAX_ARTIFACT_CHARS + 1) })).error).toMatch(
      /2MB/,
    )
  })

  it("the contract text names the block and forbids trailing output", () => {
    // The two properties the parser depends on. If the contract stopped asking for the block, or
    // stopped saying "NOTHING after it", parseRevision's regex would still compile and every run
    // would quietly start failing to produce one.
    expect(REVISION_CONTRACT).toContain("<revision>")
    expect(REVISION_CONTRACT).toContain("NOTHING after it")
  })
})

// THE ASK: the revision contract on a turn where the model was allowed not to write.
//
// This file is the definition's half of the parity pair. packages/cli/test/ask-parity.test.js
// holds the CLI runner's hand-copied <answer> reader to the SAME table, because the CLI is a
// dependency-free published package and cannot import this module at runtime. Changing how a
// field is read means changing both tables; forgetting either fails loudly on one side.
describe("run contract: parseAsk", () => {
  /** The spec, hand-copied from packages/cli/test/ask-parity.test.js. Deliberately the cases where
   *  a re-implementation actually drifts: coercions, precedence, and clamping. */
  const ASK_FIELD_CASES: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["nothing set reads as the quiet defaults", {}, {}],
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

  const ASK_FIELD_DEFAULTS = {
    escalate: false,
    reason: null,
    caveats: [] as string[],
    page: null as { title: string; path: string } | null,
    inlineHtml: null as string | null,
  }

  const read = (fields: Record<string, unknown>) => {
    const p = parseAsk(`<revision>${JSON.stringify(fields)}</revision>`)
    if (!p.reply) throw new Error(`expected a reply, got ${p.error}`)
    return {
      escalate: p.reply.escalate,
      reason: p.reply.escalationReason,
      caveats: p.reply.caveats,
      page: p.reply.pageOnDisk,
      // An inline page IS a revision: "the complete source of a page" is the only thing a revision
      // ever was, so it folds in rather than becoming a second way to say the same thing.
      inlineHtml: p.reply.revision?.content ?? null,
    }
  }

  describe("ask fields: the definition the CLI's copy is held to", () => {
    for (const [name, fields, expected] of ASK_FIELD_CASES)
      it(name, () => {
        expect(read(fields)).toEqual({ ...ASK_FIELD_DEFAULTS, ...expected })
      })
  })

  describe("an ask is the revision contract, minus the obligation to write", () => {
    const block = (obj: unknown) => `Here you go.\n<revision>${JSON.stringify(obj)}</revision>`

    it("a reply with NO block is an ANSWER, not a miss", () => {
      // The whole insight. An automation that replies without the block produced nothing and is
      // nudged; an ask that replies without the block answered the question. Same contract, and the
      // difference is whether anybody was waiting.
      const p = parseAsk("It is about three paragraphs long.")
      expect(p.reply?.revision).toBeNull()
      expect(p.reply?.body_md).toBe("It is about three paragraphs long.")
      expect(p.error).toBeUndefined()
    })

    it("a block with NO content is an answer that carries session fields", () => {
      // The only way a model can escalate a turn it deliberately wrote nothing on. parseRevision
      // rejects this ("content must be a non-empty string") and is right to: an automation with no
      // content produced nothing.
      const p = parseAsk(block({ escalate: true, caveats: ["stale feed"] }))
      expect(p.reply?.revision).toBeNull()
      expect(p.reply?.escalate).toBe(true)
      expect(p.reply?.body_md).toBe("Here you go.")
    })

    it("reads a written revision exactly as the automation lane does", () => {
      const p = parseAsk(block({ content: "# Hi", filename: "notes.md", confidence: 1.5 }))
      expect(p.reply?.revision).toMatchObject({ content: "# Hi", filename: "notes.md" })
      // Clamped, not rejected — the same forgiveness parseRevision extends.
      expect(p.reply?.revision?.confidence).toBe(1)
    })

    it("a STRING confidence reads as unstated — never coerced to a number", () => {
      expect(
        parseAsk(block({ content: "x", confidence: "0.9" })).reply?.revision?.confidence,
      ).toBeNull()
    })

    it("errors only on a block that was PRESENT and unreadable", () => {
      // That is the model trying and failing the contract, which earns the one nudge. Choosing not
      // to write never does.
      expect(parseAsk("<revision>not json</revision>").error).toMatch(/parse/)
      expect(parseAsk(block({ content: "x".repeat(2_000_001) })).error).toMatch(/2MB/)
      expect(parseAsk("no block at all").error).toBeUndefined()
    })

    it("prefers an explicit body_md over the surrounding prose", () => {
      expect(parseAsk(block({ body_md: "The answer.", content: "# Doc" })).reply?.body_md).toBe(
        "The answer.",
      )
    })

    it("never hands back an empty answer", () => {
      // The transcript is what the asker is looking at, and a blank turn reads as the agent
      // having crashed.
      expect(parseAsk("").reply?.body_md).toBe("(no reply)")
    })

    it("asks for the SAME block the automation contract does", () => {
      // Not a parallel <answer> contract: the same tag, the same keys, plus the two a waiting
      // person can use. A second block shape would fork the one thing that must not fork.
      for (const key of ['"content"', '"filename"', '"confidence"', '"message"'])
        expect(ASK_CONTRACT).toContain(key)
      expect(ASK_CONTRACT).toContain("<revision>")
      expect(ASK_CONTRACT).toContain('"escalate"')
      // And it does NOT tell an ask it is an automation, which REVISION_CONTRACT correctly does.
      expect(REVISION_CONTRACT).toContain("You are running an AUTOMATION")
      expect(ASK_CONTRACT).not.toContain("AUTOMATION")
      expect(ASK_CONTRACT).toContain("Someone ASKED you this")
    })
  })
})
