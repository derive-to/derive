import type { ArtifactRecord, VersionRecord } from "@derive/core"
import { EditError } from "@derive/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  EditConflictError,
  MAX_EDITS_PER_BATCH,
  materializeEdits,
  parseBaseVersion,
  preservingFilename,
} from "../src/lib/edits"

// A minimal MaterializeEditsDeps backed by an in-memory version map, keyed by n.
// blob_key doubles as the lookup key ("bk1", "bk2", ...) so sourceText can resolve it
// without a real blob store.
const mkDeps = (versions: Record<number, { text: string; contentType?: string }>) => {
  const byN = new Map(Object.entries(versions).map(([n, v]) => [Number(n), v]))
  return {
    getVersion: async (_artifactId: string, n: number): Promise<VersionRecord | null> => {
      const v = byN.get(n)
      if (!v) return null
      // text/markdown is a passthrough in toMarkdown (no HTML→Markdown reflow), so
      // these plain line-based fixtures diff line-for-line exactly as written.
      return { blob_key: `bk${n}`, content_type: v.contentType ?? "text/markdown" } as VersionRecord
    },
    sourceText: async (v: Pick<VersionRecord, "blob_key">): Promise<string | null> => {
      const n = Number(v.blob_key.replace("bk", ""))
      return byN.get(n)?.text ?? null
    },
  }
}

const fileArtifact = (
  currentVersion: number,
): Pick<ArtifactRecord, "id" | "short_id" | "kind" | "current_version"> => ({
  id: "art1",
  short_id: "short1",
  kind: "file",
  current_version: currentVersion,
})

describe("materializeEdits: conflict diff (compactDiff / conflictDiffNote)", () => {
  it("a conflict at the very first line does not print a spurious leading ellipsis (regression)", async () => {
    const deps = mkDeps({
      1: { text: "first\nsecond\nthird" },
      2: { text: "FIRST\nsecond\nthird" },
    })
    let msg = ""
    try {
      await materializeEdits(deps, fileArtifact(2), [{ old_str: "x", new_str: "y" }], 1)
    } catch (e) {
      msg = e instanceof EditConflictError ? e.message : `wrong type: ${e}`
    }
    expect(msg).toContain("What changed (v1 → v2):")
    // The diff section itself must start with the changed line, not a bogus "…"
    // implying (falsely) that unchanged content was collapsed before the start.
    const diffSection = msg.split("What changed (v1 → v2):\n")[1] ?? ""
    expect(diffSection.startsWith("…")).toBe(false)
    expect(diffSection).toContain("- first")
    expect(diffSection).toContain("+ FIRST")
  })

  it("a genuine gap between two real hunks still shows the collapsing ellipsis (fix doesn't over-correct)", async () => {
    const base = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n")
    const head = base.replace("line 0", "LINE 0").replace("line 9", "LINE 9")
    const deps = mkDeps({ 1: { text: base }, 2: { text: head } })
    let msg = ""
    try {
      await materializeEdits(deps, fileArtifact(2), [{ old_str: "x", new_str: "y" }], 1)
    } catch (e) {
      msg = e instanceof EditConflictError ? e.message : `wrong type: ${e}`
    }
    // First hunk (line 0) has nothing before it — no leading "…" — but the real gap
    // between the two hunks (lines 1-7 unchanged) must still collapse to one.
    const diffSection = msg.split("What changed (v1 → v2):\n")[1] ?? ""
    expect(diffSection.startsWith("…")).toBe(false)
    expect(diffSection).toContain("…")
    expect(diffSection).toContain("- line 0")
    expect(diffSection).toContain("- line 9")
  })

  it("a near-total rewrite falls back to an added/removed summary instead of a mid-word-truncated fragment (regression)", async () => {
    const base = Array.from(
      { length: 40 },
      (_, i) => `alpha line ${i} unchanged-looking text`,
    ).join("\n")
    const head = Array.from(
      { length: 40 },
      (_, i) => `beta line ${i} completely different text`,
    ).join("\n")
    const deps = mkDeps({ 1: { text: base }, 2: { text: head } })
    let msg = ""
    try {
      await materializeEdits(deps, fileArtifact(2), [{ old_str: "x", new_str: "y" }], 1)
    } catch (e) {
      msg = e instanceof EditConflictError ? e.message : `wrong type: ${e}`
    }
    expect(msg).toMatch(
      /\d+ lines? added, \d+ lines? removed — too different to summarize as a diff\./,
    )
    // Must not contain a mid-word truncation marker — the summary IS the whole output.
    expect(msg).not.toContain("[truncated]")
  })

  it("a large document skips the diff (size guard) but still reports the conflict itself, and stays fast", async () => {
    const bigLine = "x".repeat(200)
    const base = Array.from({ length: 1000 }, (_, i) => `${bigLine} ${i}`).join("\n") // ~200KB
    const head = base.replace(" 500", " CHANGED")
    expect(base.length).toBeGreaterThan(150_000)
    const deps = mkDeps({ 1: { text: base }, 2: { text: head } })

    const start = performance.now()
    let msg = ""
    try {
      await materializeEdits(deps, fileArtifact(2), [{ old_str: "x", new_str: "y" }], 1)
    } catch (e) {
      msg = e instanceof EditConflictError ? e.message : `wrong type: ${e}`
    }
    expect(performance.now() - start).toBeLessThan(500)
    expect(msg).toMatch(/moved to v2/)
    expect(msg).not.toContain("What changed")
  })

  describe("conflictDiffNote failure logging", () => {
    afterEach(() => vi.restoreAllMocks())

    it("a lookup failure while building the diff is logged, not silently swallowed (regression)", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
      const deps = {
        getVersion: async (): Promise<VersionRecord | null> => {
          throw new Error("simulated store failure")
        },
        sourceText: async (): Promise<string | null> => null,
      }
      let msg = ""
      try {
        await materializeEdits(deps, fileArtifact(2), [{ old_str: "x", new_str: "y" }], 1)
      } catch (e) {
        msg = e instanceof EditConflictError ? e.message : `wrong type: ${e}`
      }
      // Best-effort: the conflict itself still reports cleanly, just without a diff.
      expect(msg).toMatch(/moved to v2/)
      expect(msg).not.toContain("What changed")
      // But the failure is no longer invisible — it's logged, with the real cause.
      expect(errSpy).toHaveBeenCalledOnce()
      const [loggedMsg, fields] = errSpy.mock.calls[0] as [string, Record<string, unknown>]
      expect(loggedMsg).toContain("conflictDiffNote failed")
      expect(fields.error).toBe("simulated store failure")
    })
  })
})

describe("materializeEdits: quote-scoped edits (the inline editor's shape)", () => {
  it("applies a quote edit to markdown and keeps the .md filename", async () => {
    const deps = mkDeps({ 1: { text: "# T\n\nIt was teh best of times.\n" } })
    const out = await materializeEdits(
      deps,
      fileArtifact(1),
      [{ quote: { exact: "teh", prefix: "It was ", suffix: " best" }, new_text: "the" }],
      1,
    )
    expect(out.content).toContain("It was the best of times.")
    expect(out.filename).toBe("index.md")
  })

  it("applies a quote edit to html source via the projection map", async () => {
    const deps = mkDeps({
      1: {
        text: "<p>The quick brown fox jumps over the lazy dog.</p>",
        contentType: "text/html",
      },
    })
    const out = await materializeEdits(
      deps,
      fileArtifact(1),
      [{ quote: { exact: "lazy", prefix: "over the ", suffix: " dog" }, new_text: "sleepy" }],
      1,
    )
    expect(out.content).toBe("<p>The quick brown fox jumps over the sleepy dog.</p>")
    expect(out.filename).toBe("index.html")
  })

  it("refuses a batch that mixes quote edits with old_str edits", async () => {
    // The two shapes resolve against different baselines (quotes all-at-once vs
    // old_str sequentially) — a mixed batch would silently reorder, so it's refused.
    const deps = mkDeps({ 1: { text: "alpha beta gamma" } })
    await expect(
      materializeEdits(
        deps,
        fileArtifact(1),
        [
          { quote: { exact: "alpha", suffix: " beta" }, new_text: "ALPHA" },
          { old_str: "gamma", new_str: "GAMMA" },
        ],
        1,
      ),
    ).rejects.toThrow(/mixes quote edits and old_str edits/)
  })

  it("a malformed quote edit (numeric prefix) is a clean EditError, not a TypeError 500", async () => {
    const deps = mkDeps({ 1: { text: "the pricing page" } })
    await expect(
      materializeEdits(
        deps,
        fileArtifact(1),
        // isQuoteEdit rejects the shape, so it falls to applyEdits' old_str
        // validation — either way the caller gets a 400-shaped EditError.
        [{ quote: { exact: "pricing", prefix: 123 }, new_text: "cost" } as never],
        1,
      ),
    ).rejects.toThrow(EditError)
  })

  it("caps the batch size with a clean EditError", async () => {
    const deps = mkDeps({ 1: { text: "word ".repeat(10) } })
    const edits = Array.from({ length: MAX_EDITS_PER_BATCH + 1 }, () => ({
      quote: { exact: "word" },
      new_text: "x",
    }))
    await expect(materializeEdits(deps, fileArtifact(1), edits, 1)).rejects.toThrow(
      /maximum per request/,
    )
  })

  it("a failing quote edit rejects the batch as a plain EditError (400-shaped)", async () => {
    const deps = mkDeps({ 1: { text: "no such phrase here" } })
    await expect(
      materializeEdits(
        deps,
        fileArtifact(1),
        [{ quote: { exact: "vanished text" }, new_text: "x" }],
        1,
      ),
    ).rejects.toThrow(/wasn't found/)
  })

  it("still enforces base_version for quote edits (409-shaped conflict)", async () => {
    const deps = mkDeps({ 1: { text: "one" }, 2: { text: "two" } })
    await expect(
      materializeEdits(deps, fileArtifact(2), [{ quote: { exact: "one" }, new_text: "1" }], 1),
    ).rejects.toThrow(EditConflictError)
  })

  it("a non-array edits payload is a clean EditError, not a TypeError-shaped 500", async () => {
    const deps = mkDeps({ 1: { text: "one" } })
    await expect(
      // Simulates `edits: "{}"` on the wire — JSON.parse gives an object, not an array.
      materializeEdits(deps, fileArtifact(1), {} as never, 1),
    ).rejects.toThrow(EditError)
  })
})

describe("preservingFilename", () => {
  it("keeps a markdown artifact typed as markdown", () => {
    expect(preservingFilename("text/markdown")).toBe("index.md")
    expect(preservingFilename("text/markdown; charset=utf-8")).toBe("index.md")
  })

  it("defaults everything else to index.html", () => {
    expect(preservingFilename("text/html")).toBe("index.html")
    expect(preservingFilename(null)).toBe("index.html")
  })
})

describe("parseBaseVersion", () => {
  it("undefined when absent", () => {
    expect(parseBaseVersion(undefined)).toBeUndefined()
  })

  it("parses a clean positive integer", () => {
    expect(parseBaseVersion("3")).toBe(3)
  })

  it("rejects a malformed value loudly instead of coercing to NaN", () => {
    expect(() => parseBaseVersion("not-a-number")).toThrow(EditError)
    expect(() => parseBaseVersion("0")).toThrow(EditError)
    expect(() => parseBaseVersion("-1")).toThrow(EditError)
    expect(() => parseBaseVersion("1.5")).toThrow(EditError)
  })
})

// The inline editor's image swap: an image URL lives in an attribute, where there is
// no visible text to quote, so it rides the old_str shape instead. This pins the
// round trip the "replace this picture" affordance depends on.
describe("image swap (old_str on a src attribute)", () => {
  const doc = (src: string) =>
    `<!doctype html><html><body><h1>Report</h1><img src="${src}" alt="chart"><p>after</p></body></html>`

  it("swaps the URL and leaves the rest of the markup byte-identical", async () => {
    const deps = mkDeps({
      1: { text: doc("https://old.example/chart.png"), contentType: "text/html" },
    })
    const out = await materializeEdits(
      deps,
      fileArtifact(1),
      [{ old_str: "https://old.example/chart.png", new_str: "https://blob.example/abc123.png" }],
      1,
    )
    expect(out.content).toBe(doc("https://blob.example/abc123.png"))
    expect(out.filename).toBe("index.html")
  })

  it("refuses when the same URL appears twice (which picture did you mean?)", async () => {
    const src = "https://old.example/chart.png"
    const deps = mkDeps({ 1: { text: `${doc(src)}<img src="${src}">`, contentType: "text/html" } })
    await expect(
      materializeEdits(deps, fileArtifact(1), [{ old_str: src, new_str: "x" }], 1),
    ).rejects.toThrow(EditError)
  })
})
