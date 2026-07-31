import { describe, expect, it } from "vitest"
import { DERIVED_FACT_GEN, deriveFacts } from "./derived-facts"

const byName = (source: string, ct: string) =>
  Object.fromEntries(deriveFacts(source, ct).map((f) => [f.slot, JSON.parse(f.json)]))

describe("deriveFacts", () => {
  it("derives outline, links and stats from a real HTML page", () => {
    const page = `<!doctype html><html><body>
      <h1>Nightly</h1><p>see <a href="/artifacts/facts-mcqx8w9l">the how-to</a> and
      <a href="https://derive.to/artifacts/derived-facts-wl1tu7zk@v3">the design</a></p>
      <h2>Results</h2><table><tr><td>1</td></tr></table>
      <h2>Notes</h2><pre>code</pre>
    </body></html>`
    const d = byName(page, "text/html")
    expect(d.$outline.sections.map((s: { label: string }) => s.label)).toEqual([
      "Nightly",
      "Results",
      "Notes",
    ])
    // Ref forms both resolve to the trailing short id; the @vN suffix is not an edge to
    // a different artifact.
    expect(d.$links.refs).toEqual(["mcqx8w9l", "wl1tu7zk"])
    expect(d.$stats.tables).toBe(1)
    expect(d.$stats.code_blocks).toBe(1)
    expect(d.$stats.sections).toBe(3)
    expect(d.$stats.words).toBeGreaterThan(0)
  })

  it("derives from markdown, where links are []() targets", () => {
    const md = "# One\n\nsee [that](/artifacts/my-title-abc12345)\n\n## Two\n\n```js\nx\n```\n"
    const d = byName(md, "text/markdown")
    expect(d.$outline.sections.map((s: { label: string }) => s.label)).toEqual(["One", "Two"])
    expect(d.$links.refs).toEqual(["abc12345"])
    expect(d.$stats.code_blocks).toBe(1)
  })

  it("absence is absence, for the host's own output too", () => {
    // One heading = no navigable structure; no artifact hrefs = no edges. Neither emits a
    // row, because a fabricated empty row is the same sin as a fabricated zero.
    const d = byName("<h1>Alone</h1><p>plain</p>", "text/html")
    expect(d.$outline).toBeUndefined()
    expect(d.$links).toBeUndefined()
    expect(d.$stats).toBeDefined()
  })

  it("counts VISIBLE words for HTML, so markup weight is not prose", () => {
    const heavy = `<div class="a b c d e f g h i j k l m n o p"><p>two words</p></div>`
    const d = byName(heavy, "text/html")
    expect(d.$stats.words).toBe(2)
    expect(d.$stats.chars).toBe(heavy.length)
  })

  it("records that a reference exists, never why: footers and citations look identical", () => {
    // The transcription line, pinned: dedup yes, judgment no.
    const page =
      '<a href="/artifacts/x-aaaa1111">cite</a>' +
      '<footer><a href="/artifacts/x-aaaa1111">footer</a><a href="/artifacts/y-bbbb2222">f2</a></footer>'
    const d = byName(page, "text/html")
    expect(d.$links.refs).toEqual(["aaaa1111", "bbbb2222"])
  })

  it("ignores non-artifact hrefs and id-shaped prose", () => {
    const page =
      '<a href="https://example.com/artifacts/../etc">x</a>' +
      '<a href="mailto:x@y.z">m</a><p>the id abc12345 in prose is a string, not an edge</p>'
    const d = byName(page, "text/html")
    expect(d.$links).toBeUndefined()
  })

  it("bounds a monster outline and says so", () => {
    const md = Array.from({ length: 250 }, (_, i) => `# H${i}\n\nbody\n`).join("\n")
    const d = byName(md, "text/markdown")
    expect(d.$outline.sections).toHaveLength(200)
    expect(d.$outline.truncated).toBe(true)
    expect(d.$outline.total).toBe(250)
  })

  it("is deterministic — or gen-bumping is meaningless", () => {
    const page = "<h1>A</h1><h2>B</h2><p>text</p>"
    const a = deriveFacts(page, "text/html")
    const b = deriveFacts(page, "text/html")
    expect(a).toEqual(b)
    expect(DERIVED_FACT_GEN).toBe(1)
  })

  it("stays linear on adversarial input", () => {
    // The CodeQL round's attack shapes, aimed at the new regexes.
    const hrefAttack = `<a href="${'"'.repeat(1)}${" ".repeat(30_000)}`
    const mdAttack = `](${"a".repeat(30_000)}`
    const bigPage = `<h1>t</h1>${'<a href="/artifacts/x-aaaa1111">l</a>'.repeat(5_000)}`
    const started = Date.now()
    deriveFacts(hrefAttack, "text/html")
    deriveFacts(mdAttack, "text/markdown")
    deriveFacts(bigPage, "text/html")
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe("hostile hrefs", () => {
  it("reads an UNQUOTED href — legal HTML, and a missing edge is the worse failure", () => {
    // Found by dogfooding: a page published with href=/artifacts/… lost its edge silently.
    const page = "<a href=/artifacts/plain-abc12345>bare</a><a href='/artifacts/q-bbbb2222'>q</a>"
    const d = Object.fromEntries(
      deriveFacts(page, "text/html").map((f) => [f.slot, JSON.parse(f.json)]),
    )
    expect(d.$links.refs).toEqual(["abc12345", "bbbb2222"])
  })

  it("one malformed percent-encoding costs that edge, never the whole row", () => {
    const page =
      '<a href="/artifacts/bad-%zz">broken</a><a href="/artifacts/good-abc12345">fine</a>'
    const d = Object.fromEntries(
      deriveFacts(page, "text/html").map((f) => [f.slot, JSON.parse(f.json)]),
    )
    expect(d.$links.refs).toEqual(["abc12345"])
  })
})
