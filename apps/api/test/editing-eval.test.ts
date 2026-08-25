import {
  type ArtifactRecord,
  fingerprintOf,
  roleOf,
  scanElements,
  type VersionRecord,
} from "@derive/core"
import { describe, expect, it } from "vitest"
import {
  EditConflictError,
  MAX_EDITS_PER_BATCH,
  materializeEdits,
  materializeSlideOps,
  parseBaseVersion,
} from "../src/lib/edits"

const mkDeps = (versions: Record<number, { text: string; contentType?: string }>) => {
  const byN = new Map(Object.entries(versions).map(([n, value]) => [Number(n), value]))
  return {
    getVersion: async (_artifactId: string, n: number): Promise<VersionRecord | null> => {
      const value = byN.get(n)
      return value
        ? ({
            blob_key: `blob-${n}`,
            content_type: value.contentType ?? "text/markdown",
          } as VersionRecord)
        : null
    },
    sourceText: async (version: Pick<VersionRecord, "blob_key">): Promise<string | null> =>
      byN.get(Number(version.blob_key.replace("blob-", "")))?.text ?? null,
  }
}

const artifact = (
  currentVersion: number,
): Pick<ArtifactRecord, "id" | "short_id" | "kind" | "current_version"> => ({
  id: "editing-eval-artifact",
  short_id: "editing-eval",
  kind: "file",
  current_version: currentVersion,
})

describe("editing eval — API materialization boundary", () => {
  it("[PIPE-001] rejects a stale base version before materializing any edit", async () => {
    const deps = mkDeps({
      1: { text: "old source" },
      2: { text: "new source" },
    })
    await expect(
      materializeEdits(deps, artifact(2), [{ quote: { exact: "old" }, new_text: "changed" }], 1),
    ).rejects.toBeInstanceOf(EditConflictError)
  })

  it("[PIPE-002] materializes a quote and resize in one source-safe result", async () => {
    const source = '<img id="hero" src="hero.png" alt="Hero"><p>Old caption.</p>'
    const descriptor = scanElements(source).find((entry) => entry.tag === "img")
    expect(descriptor).toBeDefined()
    if (!descriptor) return
    const role = roleOf(descriptor)
    const out = await materializeEdits(
      mkDeps({ 1: { text: source, contentType: "text/html" } }),
      artifact(1),
      [
        {
          op: "resize",
          target: {
            type: "ElementSelector",
            tag: "img",
            role,
            id: descriptor.id,
            fingerprint: fingerprintOf(descriptor),
            ordinal: descriptor.ordinal,
            docFraction: descriptor.srcFraction,
            snapshot: { tag: "img", label: "Image — Hero" },
          },
          width: 360,
          height: "auto",
        },
        { quote: { exact: "Old", suffix: " caption" }, new_text: "New" },
      ],
      1,
    )
    expect(out.content).toBe(
      '<img id="hero" src="hero.png" alt="Hero" style="width: 360px; height: auto"><p>New caption.</p>',
    )
  })

  it("[PIPE-003] materializes quote and scene ops atomically", async () => {
    const source =
      '<main data-derive-video><section data-derive-scene="opening">Old headline.</section>\n' +
      '<section data-derive-scene="proof">Proof.</section></main>'
    const out = await materializeEdits(
      mkDeps({ 1: { text: source, contentType: "text/x-derive-video" } }),
      artifact(1),
      [
        { quote: { exact: "Old headline." }, new_text: "New headline." },
        { op: "scene-update", id: "opening", caption: 'Safe "><caption>' },
        { op: "scene-duplicate", id: "proof" },
      ],
      1,
    )
    expect(out.content).toContain("New headline.")
    expect(out.content).toContain("Safe &quot;&gt;&lt;caption&gt;")
    expect(out.content.match(/data-derive-scene=/g)).toHaveLength(3)
  })

  it("[PIPE-004] retains Markdown/HTML typing, including MIME parameters", async () => {
    const markdown = await materializeEdits(
      mkDeps({
        1: { text: "This is **bold** text.", contentType: "text/markdown; charset=utf-8" },
      }),
      artifact(1),
      [{ quote: { exact: "is bold text" }, new_text: "is fixed text" }],
      1,
    )
    expect(markdown).toEqual({ content: "This is fixed text.", filename: "index.md" })

    const html = await materializeEdits(
      mkDeps({ 1: { text: "<p>Old</p>", contentType: "text/html; charset=utf-8" } }),
      artifact(1),
      [{ quote: { exact: "Old" }, new_text: "New" }],
      1,
    )
    expect(html).toEqual({ content: "<p>New</p>", filename: "index.html" })
  })

  it("[PIPE-005] refuses mixed semantics and oversized batches", async () => {
    const deps = mkDeps({ 1: { text: "alpha beta" } })
    await expect(
      materializeEdits(
        deps,
        artifact(1),
        [
          { quote: { exact: "alpha" }, new_text: "A" },
          { old_str: "beta", new_str: "B" },
        ],
        1,
      ),
    ).rejects.toThrow(/mixes quote edits and old_str edits/)

    const tooMany = Array.from({ length: MAX_EDITS_PER_BATCH + 1 }, () => ({
      quote: { exact: "alpha" },
      new_text: "A",
    }))
    await expect(materializeEdits(deps, artifact(1), tooMany, 1)).rejects.toThrow(
      /maximum per request/,
    )
  })

  it("[PIPE-006] refuses slide-op batches that cancel instead of minting a version", async () => {
    const source =
      '<section class="slide" data-derive-slide="1">A</section>\n' +
      '<section class="slide" data-derive-slide="2">B</section><script>"derive-deck"</script>'
    await expect(
      materializeSlideOps(
        mkDeps({ 1: { text: source, contentType: "text/html" } }),
        artifact(1),
        [
          { op: "move", from: 1, to: 2 },
          { op: "move", from: 2, to: 1 },
        ],
        1,
      ),
    ).rejects.toThrow(/nothing to publish/)
  })

  it("[PIPE-007] accepts only canonical positive-integer base versions", () => {
    expect(parseBaseVersion(undefined)).toBeUndefined()
    expect(parseBaseVersion("1")).toBe(1)
    for (const raw of ["", "0", "01", "1.0", "1e0", " 1 ", "+1", "0x1"])
      expect(() => parseBaseVersion(raw)).toThrow(/not a valid version number/)
  })
})
