import { describe, expect, it } from "vitest"
import { bundleFactsAdvisory, missingBlobAdvisory, publishAdvisories } from "./advisories"
import type { BlobStore } from "./ports"

const HTML_NO_VIEWPORT = "<!doctype html><html><head><title>x</title></head><body>hi</body></html>"
const HTML_WITH_VIEWPORT =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body>hi</body></html>'

describe("publishAdvisories", () => {
  it("flags a styled page publishing into the reflow injection (no viewport meta)", () => {
    const out = publishAdvisories(HTML_NO_VIEWPORT, "text/html")
    expect(out).toHaveLength(1)
    expect(out[0]).toContain("viewport")
    expect(out[0]).toContain("data-reflow-exempt")
  })

  it("says nothing when the author declared a viewport (they considered layout)", () => {
    expect(publishAdvisories(HTML_WITH_VIEWPORT, "text/html")).toHaveLength(0)
  })

  it("never gives the viewport advisory to markdown", () => {
    expect(publishAdvisories("# just a doc", "text/markdown")).toHaveLength(0)
  })

  it("flags large inlined base64 (binaries that should be assets), with the size", () => {
    const blob = "A".repeat(20 * 1024)
    const out = publishAdvisories(
      `${HTML_WITH_VIEWPORT}<img src="data:image/png;base64,${blob}">`,
      "text/html",
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toContain("/v1/assets")
    expect(out[0]).toMatch(/~20KB/)
  })

  it("stays quiet for icon-sized data URIs (under the threshold)", () => {
    const out = publishAdvisories(
      `${HTML_WITH_VIEWPORT}<img src="data:image/png;base64,${"A".repeat(2048)}">`,
      "text/html",
    )
    expect(out).toHaveLength(0)
  })

  it("sums base64 across many small URIs — death by a thousand icons still flags", () => {
    const imgs = Array.from(
      { length: 20 },
      (_, i) => `<img src="data:image/png;base64,${"B".repeat(1024)}${i}">`,
    ).join("")
    const out = publishAdvisories(HTML_WITH_VIEWPORT + imgs, "text/html")
    expect(out).toHaveLength(1)
  })

  it("flags a temporary upload URL embedded as a permanent one (it expires in minutes)", () => {
    const out = publishAdvisories(
      `${HTML_WITH_VIEWPORT}<img src="https://derive.example/v1/assets/t/abc.def">`,
      "text/html",
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toContain("UPLOAD url")
    expect(out[0]).toContain("permanent")
  })

  it("flags HTML page markup stored as markdown (CSS would render as visible text)", () => {
    const out = publishAdvisories(
      "some prose\n<style>body{color:red}</style>\nmore prose",
      "text/markdown",
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('filename:"index.html"')
    // The same content stored as HTML is fine (modulo the viewport advisory,
    // which needs a <style> page to have considered layout).
    expect(
      publishAdvisories(
        `<meta name="viewport" content="width=device-width"><style>body{}</style>`,
        "text/html",
      ),
    ).toHaveLength(0)
  })

  it("ordinary markdown with inline HTML tags stays quiet — only page markup flags", () => {
    expect(
      publishAdvisories('# Doc\n\n<div align="center">badge</div>\n\n<b>bold</b>', "text/markdown"),
    ).toHaveLength(0)
  })
})

describe("missingBlobAdvisory", () => {
  const store = (existing: string[]): BlobStore => ({
    put: async () => "0".repeat(64),
    get: async () => null,
    has: async (key: string) => existing.includes(key),
  })
  const KEY_A = "a".repeat(64)
  const KEY_B = "b".repeat(64)
  const page = (keys: string[]) =>
    keys.map((k) => `<img src="https://derive.example/blob/${k}.jpg">`).join("")

  it("null when every embedded blob exists", async () => {
    expect(await missingBlobAdvisory(page([KEY_A, KEY_B]), store([KEY_A, KEY_B]))).toBeNull()
  })

  it("names missing blobs (the image will 404), deduped across repeats", async () => {
    const out = await missingBlobAdvisory(page([KEY_A, KEY_B, KEY_B]), store([KEY_A]))
    expect(out).not.toBeNull()
    expect(out).toContain("1 embedded asset URL(s)")
    expect(out).toContain(KEY_B.slice(0, 12))
  })

  it("skips entirely when the store can't answer cheaply (no `has`)", async () => {
    const blind: BlobStore = { put: async () => "0".repeat(64), get: async () => null }
    expect(await missingBlobAdvisory(page([KEY_B]), blind)).toBeNull()
  })

  it("a store hiccup never fails the publish — advisory just goes quiet", async () => {
    const flaky: BlobStore = {
      put: async () => "0".repeat(64),
      get: async () => null,
      has: async () => {
        throw new Error("store down")
      },
    }
    expect(await missingBlobAdvisory(page([KEY_B]), flaky)).toBeNull()
  })
})

describe("bundleFactsAdvisory (the silent drop, found by dogfooding)", () => {
  const block = '<script type="application/derive-facts" data-fact="checks">{"pass":5}</script>'

  it("names the page whose facts block will be dropped", () => {
    const a = bundleFactsAdvisory({ "index.html": `<h1>Home</h1>${block}`, "b.html": "<h1>B</h1>" })
    expect(a).toContain("index.html")
    expect(a).toContain("single-file")
    expect(a).toContain("carries a derive-facts block") // one page: singular
    // It must NOT tell the author to embed a block — they just did, into a bundle.
    expect(a).not.toContain("embed a derive-facts block to add one")
  })

  it("stays quiet when no page asserts anything", () => {
    expect(bundleFactsAdvisory({ "index.html": "<h1>Home</h1>", "s.md": "# S" })).toBeNull()
  })

  it("speaks up for a MALFORMED block too — a failed assertion is still an assertion", () => {
    const bad = '<script type="application/derive-facts" data-fact="checks">{oops</script>'
    expect(bundleFactsAdvisory({ "index.html": bad })).toContain("index.html")
  })

  it("reads markdown pages in THEIR grammar, and ignores non-page files", () => {
    // Markdown asserts with a ```derive-facts fence, not a script tag — a scan that only
    // knew the HTML form would stay silent on exactly the pages a skill bundle is made of.
    const fenced = '# N\n\n```derive-facts checks\n{"pass":5}\n```\n'
    expect(bundleFactsAdvisory({ "notes.md": fenced })).toContain("notes.md")
    // Two pages agree in number — this shipped reading "index.html, notes.md carries".
    expect(bundleFactsAdvisory({ "a.html": block, "b.html": block })).toContain(
      "carry a derive-facts block",
    )
    expect(bundleFactsAdvisory({ "logo.png": block, "style.css": block })).toBeNull()
  })
})
