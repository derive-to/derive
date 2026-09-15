import { describe, expect, it } from "vitest"
import {
  analysisCounts,
  analysisStaleness,
  droppedIds,
  PAPER_ANALYSIS_SCHEMA,
  type PaperAnalysis,
  parsePaperAnalysis,
  renderPaperAnalysisMarkdown,
  serializePaperAnalysis,
} from "./paper-analysis"

const COMMIT = "0123456789abcdef0123456789abcdef01234567"

const valid = (over: Record<string, unknown> = {}) => ({
  schema: PAPER_ANALYSIS_SCHEMA,
  context: "ctx_abc",
  based_on: null,
  paper: { short_id: "p1", arxiv_version: 2 },
  implementation: { repository: "github.com/o/r", commit: COMMIT },
  summary: "The training loop implements the method; the loss weights its terms differently.",
  contributions: [
    {
      id: "c1",
      title: "A differentiable rasterizer",
      claim: "Splats are rasterized with a tile-based sort.",
      paper: [{ section: "main.tex#method", label: "eq:alpha" }],
      details: [
        {
          id: "c1.d1",
          title: "Tile-based sorting",
          paper: [{ section: "main.tex#method" }],
          code: [{ path: "code/src/render.py", symbol: "def sort_tiles", lines: "40-88" }],
          status: "implemented",
        },
        {
          id: "c1.d2",
          title: "Loss weighting",
          paper: [],
          code: [{ path: "src/loss.py", lines: "12" }],
          status: "differs",
          notes: "The code weights the SSIM term by `0.2`, where the paper says 0.25.",
        },
        { id: "c1.d3", title: "Densification schedule", paper: [], code: [], status: "not_found" },
      ],
    },
  ],
  unmapped: [
    { id: "u1", path: "src/utils/cuda.py", notes: "Custom kernels the paper never mentions." },
  ],
  open_questions: [
    { id: "q1", question: "Is the learning-rate decay the paper's, or only the code's?" },
  ],
  ...over,
})

const parse = (v: unknown) => parsePaperAnalysis(JSON.stringify(v))
const errorsOf = (v: unknown): string[] => {
  const r = parse(v)
  return r.ok ? [] : r.errors
}
const parsed = (v: unknown): PaperAnalysis => {
  const r = parse(v)
  if (!r.ok) throw new Error(r.errors.join("\n"))
  return r.analysis
}

describe("parsePaperAnalysis", () => {
  it("accepts a well-formed analysis and stores it in one canonical shape", () => {
    const analysis = parsed(valid())
    // A path given the way an agent reads it is stored the way the repository names it.
    expect(analysis.contributions[0]?.details[0]?.code[0]?.path).toBe("src/render.py")
    expect(analysis.removed).toEqual([])
    expect(parsePaperAnalysis(serializePaperAnalysis(analysis))).toEqual({ ok: true, analysis })
  })

  it("names every problem by its place, so one revision can fix them all", () => {
    const errors = errorsOf(
      valid({
        schema: "nope",
        contributions: [
          {
            id: "C 1",
            title: "x",
            claim: "y",
            extra: true,
            details: [
              { id: "d1", title: "a", code: [], status: "implemented" },
              { id: "d1", title: "b", code: [{ path: "a/../../etc" }], status: "partial" },
              { id: "d3", title: "c", code: [{ path: "x.py", lines: "9-3" }], status: "not_found" },
              { id: "d4", title: "d", code: [{ path: "x.py" }], status: "maybe" },
            ],
          },
        ],
      }),
    ).join("\n")
    for (const expected of [
      "analysis.schema must be",
      "analysis.contributions[0].extra is not a field",
      "analysis.contributions[0].id must be an id",
      "analysis.contributions[0].details[0].code must name the code",
      "analysis.contributions[0].details[1].code[0].path must be a file's path",
      "analysis.contributions[0].details[1].notes must say what the code does differently",
      "analysis.contributions[0].details[1].id repeats the id",
      "analysis.contributions[0].details[2].code[0].lines must be a line or a range",
      "analysis.contributions[0].details[2].code must be empty when the status is not_found",
      "analysis.contributions[0].details[3].status must be one of",
    ])
      expect(errors).toContain(expected)
  })

  it("refers to code and never quotes it", () => {
    const withNotes = (notes: string) =>
      valid({
        contributions: [
          {
            id: "c1",
            title: "t",
            claim: "c",
            paper: [],
            details: [{ id: "d1", title: "t", code: [{ path: "a.py" }], status: "differs", notes }],
          },
        ],
      })
    expect(errorsOf(withNotes("See ```py\nx = 1\n```"))[0]).toContain("a fenced code block")
    expect(errorsOf(withNotes("Before:\n\n    x = torch.zeros(3)"))[0]).toContain(
      "an indented code block",
    )
    expect(errorsOf(withNotes(`\`${"x".repeat(81)}\``))[0]).toContain("a code span over 80")
    expect(errorsOf(withNotes("<pre>x</pre>"))[0]).toContain("HTML")
    expect(errorsOf(withNotes("## Heading"))[0]).toContain("a heading")
    expect(errorsOf(withNotes("| a | b |"))[0]).toContain("a table")
    // Inline markdown, a short symbol in backticks and a nested list are all prose.
    expect(
      errorsOf(withNotes("Uses `Tensor<float>` and **clamps**:\n- first\n    - nested")),
    ).toEqual([])
  })
})

describe("updating an analysis", () => {
  const base = parsed(valid())

  it("finds an entry dropped without a reason, and allows one dropped with one", () => {
    expect(droppedIds(base, parsed(valid({ open_questions: [] })))).toEqual(["q1"])
    const said = parsed(
      valid({ open_questions: [], removed: [{ id: "q1", reason: "The appendix answers it." }] }),
    )
    expect(droppedIds(base, said)).toEqual([])
    // `removed` names only what this version drops, never what it still has.
    expect(errorsOf(valid({ removed: [{ id: "q1", reason: "x" }] })).join("\n")).toContain(
      "which this version still has",
    )
  })

  it("counts statuses and says what moved since it was made", () => {
    expect(analysisCounts(base)).toEqual({
      contributions: 1,
      details: 3,
      implemented: 1,
      partial: 0,
      differs: 1,
      not_found: 1,
      unmapped: 1,
      open_questions: 1,
    })
    const now = { arxivVersion: 2, repository: "github.com/o/r", commit: COMMIT }
    expect(analysisStaleness(base, now)).toEqual([])
    expect(analysisStaleness(base, { ...now, arxivVersion: 3 })[0]).toContain("version 3")
    expect(analysisStaleness(base, { ...now, commit: "f".repeat(40) })[0]).toContain(
      "commit 0123456",
    )
    expect(analysisStaleness(base, { ...now, repository: null })[0]).toContain("removed")
  })
})

describe("renderPaperAnalysisMarkdown", () => {
  it("writes every detail out with its status and links, and no code", () => {
    const md = renderPaperAnalysisMarkdown(parsed(valid()), {
      paperTitle: "Splatting",
      links: {
        code: (ref) =>
          ref.path.startsWith("src/utils/")
            ? { href: `https://github.com/sub/r/blob/main/${ref.path}`, pinned: false }
            : { href: `https://github.com/o/r/blob/${COMMIT}/${ref.path}`, pinned: true },
        paper: () => "https://derive.test/artifacts/p1",
      },
    })
    expect(md).toContain("# Implementation analysis: Splatting")
    expect(md).toContain("## 1. A differentiable rasterizer")
    expect(md).toContain("**Differs from the paper**")
    expect(md).toContain(
      `- Code: [\`src/render.py\` \`def sort_tiles\` lines 40-88](https://github.com/o/r/blob/${COMMIT}/src/render.py)`,
    )
    expect(md).toContain("(not pinned to a commit)")
    expect(md).toContain("## Code the paper does not describe")
    expect(md).not.toContain("```")
  })
})
