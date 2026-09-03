import { describe, expect, it } from "vitest"
import { DECK_TEMPLATE } from "./deck-template.gen"
import { docMap, MAX_MAP_NODES, mapJson, resolveNode } from "./doc-map"
import { outlineOf, sectionOf } from "./doc-text"

const HTML = "text/html"
const MD = "text/markdown"

const deck = (slides: string[]) =>
  `<!doctype html><html><head><title>d</title><style>.slide{}</style></head><body>\n  ${slides.join(
    "\n  ",
  )}\n<script>parent.postMessage({source:"derive-deck",type:"state",i:0,total:${slides.length}},"*")</script>\n</body></html>`

const sl = (id: number, body: string) =>
  `<section class="slide" data-derive-slide="${id}"><h2>${body}</h2><div class="slide-inner">x</div></section>`

const page = `<!doctype html><html><head><title>p</title></head><body>
<h2 id="intro">Intro</h2><p>one</p>
<h2>Where it stands</h2><p>two</p>
<h3>Nested</h3><p>three</p>
</body></html>`

const md = `# Title

intro text

## Pricing

pricing text

## Risks

risk text
`

const headless = `<!doctype html><html><body><main aria-label="Board"><p>a</p></main><footer id="foot"><p>b</p></footer></body></html>`

/** THE invariant: node spans tile the file, so the parts always reassemble into the whole.
 *  Everything `replace` will ever do rests on this. */
const tiles = (source: string, contentType: string) => {
  const map = docMap(source, contentType)
  let cursor = 0
  for (const n of map.nodes) {
    expect(n.start).toBe(cursor)
    expect(n.end).toBeGreaterThanOrEqual(n.start)
    cursor = n.end
  }
  expect(cursor).toBe(source.length)
  expect(map.nodes.map((n) => source.slice(n.start, n.end)).join("")).toBe(source)
  return map
}

describe("docMap: the tiling invariant", () => {
  it("tiles every document shape byte-for-byte", () => {
    tiles(deck([sl(0, "a"), sl(1, "b")]), HTML)
    tiles(DECK_TEMPLATE, HTML)
    tiles(page, HTML)
    tiles(md, MD)
    tiles(headless, HTML)
    tiles("<html><body><p>no structure at all</p></body></html>", HTML)
    tiles("just some prose, no headings", MD)
    tiles("", MD)
  })

  it("gives whitespace between nodes to the FOLLOWING node", () => {
    // Every node carries the separation that positions it, so a reorder can never strand
    // indentation on the node that used to precede it.
    const src = deck([sl(0, "a"), sl(1, "b")])
    const map = docMap(src, HTML)
    const slides = map.nodes.filter((n) => n.type === "slide")
    expect(slides).toHaveLength(2)
    for (const s of slides) {
      const text = src.slice(s.start, s.end)
      expect(text.trimStart().startsWith("<section")).toBe(true)
      expect(text.trimEnd().endsWith("</section>")).toBe(true)
    }
    // The second slide owns the newline+indent that separates it from the first.
    expect(src.slice((slides[1] as { start: number }).start).startsWith("\n  ")).toBe(true)
  })

  it("represents stray content between slides instead of folding it into a neighbour", () => {
    // Folding would silently relocate it on a reorder.
    const src = deck([sl(0, "a"), '<div class="rail">nav</div>', sl(1, "b")])
    const map = tiles(src, HTML)
    const chrome = map.nodes.filter((n) => n.type === "chrome")
    expect(chrome.some((c) => src.slice(c.start, c.end).includes('class="rail"'))).toBe(true)
  })
})

describe("docMap: what it maps", () => {
  it("maps a deck to slides, with identity and title", () => {
    const map = docMap(deck([sl(3, "The problem"), sl(0, "Who it hits")]), HTML)
    expect(map.kind).toBe("deck")
    const slides = map.nodes.filter((n) => n.type === "slide")
    expect(slides.map((s) => s.ref)).toEqual(["slide:1", "slide:2"])
    expect(slides.map((s) => s.identity)).toEqual([3, 0])
    expect(slides.map((s) => s.title)).toEqual(["The problem", "Who it hits"])
  })

  it("does not turn a deck's inner headings into sections", () => {
    // A slide's heading is its title. Depth 1: a slide has no children in v1.
    const map = docMap(deck([sl(0, "a"), sl(1, "b")]), HTML)
    expect(map.nodes.some((n) => n.type === "section")).toBe(false)
  })

  it("maps a page to sections, keeping heading level and authored id", () => {
    const map = docMap(page, HTML)
    expect(map.kind).toBe("page")
    const secs = map.nodes.filter((n) => n.type === "section")
    // Flat: a nested h3 is its OWN node, not swallowed by the h2 above it.
    expect(secs.map((s) => s.ref)).toEqual(["sec:intro", "sec:where-it-stands", "sec:nested"])
    expect(secs.map((s) => s.level)).toEqual([2, 2, 3])
    expect(secs[0]?.id).toBe("intro")
  })

  it("maps markdown to sections", () => {
    const map = docMap(md, MD)
    expect(map.kind).toBe("markdown")
    expect(map.nodes.filter((n) => n.type === "section").map((s) => s.ref)).toEqual([
      "sec:title",
      "sec:pricing",
      "sec:risks",
    ])
  })

  it("falls back to landmark regions on a page with no headings", () => {
    const map = docMap(headless, HTML)
    const regions = map.nodes.filter((n) => n.type === "region")
    expect(regions.map((r) => r.ref)).toEqual(["@1", "@2"])
    expect(regions[0]?.title).toBe("Board")
  })

  it("gives a structureless document one addressable body node", () => {
    // So `read node:` is universal — no document is unaddressable.
    const map = docMap("<html><body><p>hi</p></body></html>", HTML)
    expect(map.nodes).toHaveLength(1)
    expect(map.nodes[0]?.ref).toBe("doc:body")
  })

  it("does not address a script that lives INSIDE a content node", () => {
    const src = deck([
      '<section class="slide" data-derive-slide="0"><h2>a</h2><script>var x=1</script></section>',
      sl(1, "b"),
    ])
    const map = docMap(src, HTML)
    // Only the deck's own trailing protocol script is top level.
    expect(map.nodes.filter((n) => n.type === "script")).toHaveLength(1)
  })
})

describe("docMap: parity with the lenses it replaces", () => {
  // These two tests ARE the anti-drift guarantee: the map must address exactly what the
  // existing readers already address, or an agent reading with one and writing with the
  // other lands somewhere else.
  it("composes back into exactly what `read section:` returns", () => {
    // The map slices FLAT so it can tile; the reader slices NESTED. They stay honest about
    // each other because a section plus every following deeper node IS the nested span.
    for (const [src, ct] of [
      [page, HTML],
      [md, MD],
    ] as const) {
      const secs = docMap(src, ct).nodes.filter((n) => n.type === "section")
      secs.forEach((node, i) => {
        const slug = node.ref.slice("sec:".length)
        let end = node.end
        for (let j = i + 1; j < secs.length; j++) {
          const next = secs[j] as (typeof secs)[number]
          if ((next.level as number) <= (node.level as number)) break
          end = next.end
        }
        const viaLens = sectionOf(src, ct, slug)
        expect(viaLens).not.toBeNull()
        expect(src.slice(node.start, end).trimEnd()).toBe((viaLens as string).trimEnd())
      })
    }
  })

  it("section titles and count match the outline", () => {
    for (const [src, ct] of [
      [page, HTML],
      [md, MD],
    ] as const) {
      const outline = outlineOf(src, ct)
      const secs = docMap(src, ct).nodes.filter((n) => n.type === "section")
      expect(secs.map((s) => s.title)).toEqual(outline.map((o) => o.text))
      expect(secs.map((s) => s.level)).toEqual(outline.map((o) => o.level))
    }
  })
})

describe("resolveNode", () => {
  it("resolves a ref, and an #id alias", () => {
    const map = docMap(page, HTML)
    expect(resolveNode(map, "sec:where-it-stands")?.type).toBe("section")
    expect(resolveNode(map, "#intro")?.ref).toBe("sec:intro")
    expect(resolveNode(map, "sec:nope")).toBeNull()
    expect(resolveNode(map, "")).toBeNull()
  })

  it("refuses an ambiguous #id rather than picking one", () => {
    const src = `<html><body><h2 id="dup">A</h2><p>x</p><h2 id="dup">B</h2><p>y</p></body></html>`
    expect(resolveNode(docMap(src, HTML), "#dup")).toBeNull()
  })
})

describe("mapJson", () => {
  it("serializes refs and never byte offsets", () => {
    const json = mapJson(docMap(deck([sl(0, "a"), sl(1, "b")]), HTML), 7)
    expect(json.version).toBe(7)
    expect(json.kind).toBe("deck")
    const slide = json.nodes.find((n) => n.ref === "slide:1") as Record<string, unknown>
    expect(slide.bytes).toBeGreaterThan(0)
    expect(slide.identity).toBe(0)
    expect(slide).not.toHaveProperty("start")
    expect(slide).not.toHaveProperty("end")
    expect(JSON.stringify(json)).not.toContain('"start"')
  })

  it("caps the serialized node list but keeps every node resolvable", () => {
    const many = Array.from({ length: MAX_MAP_NODES + 20 }, (_, i) => `## H${i}\n\nbody ${i}\n`)
    const map = docMap(many.join("\n"), MD)
    const json = mapJson(map, 1)
    expect(json.nodes).toHaveLength(MAX_MAP_NODES)
    expect(json.truncated).toBe(true)
    expect(json.total).toBe(map.nodes.length)
    // The cap is a serialization concern; resolution still sees everything.
    expect(resolveNode(map, `sec:h${MAX_MAP_NODES + 10}`)).not.toBeNull()
  })
})

describe("docMap: decks that never announced themselves", () => {
  // Found by mapping a real 165KB published deck: it predates the protocol, so
  // `isDeckDocument` called it a page and the map offered 71 heading sections and no slide
  // refs — while `slide_ops` sliced the same file into 23 slides. Read and write have to
  // agree about what a document is made of.
  const silent = (n: number) =>
    `<!doctype html><html><body>\n  ${Array.from(
      { length: n },
      (_, i) => `<section class="slide"><div class="slide-inner"><h2>s${i}</h2></div></section>`,
    ).join("\n  ")}\n</body></html>`

  it("maps a silent deck's SLIDES, not its headings", () => {
    const map = tiles(silent(4), HTML)
    expect(map.kind).toBe("deck")
    expect(map.nodes.filter((n) => n.type === "slide")).toHaveLength(4)
    expect(map.nodes.some((n) => n.type === "section")).toBe(false)
  })

  it("leaves an ordinary page that merely uses a slide class alone", () => {
    // Two is a carousel, not a deck attempt — the same bar the publish advisory draws.
    const carousel = `<!doctype html><html><body><h2>Gallery</h2>
  <div class="slide">a</div>
  <div class="slide">b</div>
</body></html>`
    const map = docMap(carousel, HTML)
    expect(map.kind).toBe("page")
    expect(map.nodes.some((n) => n.type === "slide")).toBe(false)
  })
})

describe("docMap: LaTeX papers", () => {
  const tex =
    "\\documentclass{article}\n\\begin{document}\n\\maketitle\n\\section{A}\na\n\\subsection{B}\nb\n\\end{document}\n"

  it("maps sections flat, tiled with the preamble and the tail", () => {
    const map = docMap(tex, "text/x-latex")
    expect(map.kind).toBe("latex")
    const secs = map.nodes.filter((n) => n.type === "section")
    expect(secs.map((s) => [s.ref, s.level, s.title])).toEqual([
      ["sec:a", 2, "1 A"],
      ["sec:b", 3, "1.1 B"],
    ])
    expect(map.nodes.map((n) => tex.slice(n.start, n.end)).join("")).toBe(tex)
    expect(sectionOf(tex, "text/x-latex", "a")).toBe("\\section{A}\na\n\\subsection{B}\nb\n")
    expect(outlineOf(tex, "text/x-latex").map((s) => s.slug)).toEqual(["a", "b"])
  })

  it("gives a paper without sections one body node", () => {
    const map = docMap("\\begin{document}just prose\\end{document}", "text/x-latex")
    expect(map.kind).toBe("latex")
    expect(map.nodes.map((n) => n.ref)).toEqual(["doc:body"])
  })
})
