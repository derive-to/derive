import { describe, expect, it } from "vitest"
import { DECK_TEMPLATE } from "../src/deck-template.gen"
import {
  applyStructuralEdits,
  inspectStructuralDocument,
  isStructuralUserEdit,
  STRUCTURAL_EDIT_SCHEMA,
  type StructuralEdit,
  StructuralEditError,
} from "../src/structural-edit"

const op = <T extends Omit<StructuralEdit, "schema">>(edit: T): StructuralEdit =>
  ({
    schema: STRUCTURAL_EDIT_SCHEMA,
    ...edit,
  }) as StructuralEdit

const document = `<!doctype html>
<main>
  <section class="deck" data-derive-region="story" data-derive-layout="stack">
    <!-- card-a owns this source only -->
    <article data-derive-node="card-a" data-derive-kind="card">
      <h2>A</h2><script>const fake = '<div data-derive-node="nope">'</script>
    </article>
    <!-- follows card-a -->
    <article data-derive-node='card-b' data-derive-size='compact' title="x > y">
      <h2>B</h2>
    </article>
  </section>
</main>`

describe("inspectStructuralDocument", () => {
  it("exposes the canonical deck's top-level slide elements without DOM inference", () => {
    expect(inspectStructuralDocument(DECK_TEMPLATE)).toEqual([
      {
        id: "slide-0",
        layout: "stack",
        nodes: [
          { id: "slide-0-label", kind: "label", size: null },
          { id: "slide-0-title", kind: "heading", size: null },
          { id: "slide-0-summary", kind: "text", size: null },
          { id: "slide-0-visual", kind: "visual", size: null },
        ],
      },
      {
        id: "slide-1",
        layout: "stack",
        nodes: [
          { id: "slide-1-label", kind: "label", size: null },
          { id: "slide-1-title", kind: "heading", size: null },
          { id: "slide-1-composition", kind: "composition", size: null },
        ],
      },
      {
        id: "slide-2",
        layout: "stack",
        nodes: [
          { id: "slide-2-label", kind: "label", size: null },
          { id: "slide-2-title", kind: "heading", size: null },
          { id: "slide-2-composition", kind: "composition", size: null },
        ],
      },
    ])
  })

  it("round-trips canonical deck element arrange, resize, and remove edits", () => {
    const edited = applyStructuralEdits(DECK_TEMPLATE, [
      op({
        op: "structural-order",
        region: "slide-0",
        nodes: ["slide-0-visual", "slide-0-label", "slide-0-title", "slide-0-summary"],
      }),
      op({
        op: "structural-size",
        region: "slide-0",
        node: "slide-0-visual",
        size: "full",
      }),
      op({ op: "structural-remove", region: "slide-0", node: "slide-0-summary" }),
    ])

    expect(edited.html.indexOf('data-derive-node="slide-0-visual"')).toBeLessThan(
      edited.html.indexOf('data-derive-node="slide-0-label"'),
    )
    expect(edited.html).toContain(
      'data-derive-node="slide-0-visual" data-derive-kind="visual" data-derive-size="full"',
    )
    expect(edited.html).not.toContain('data-derive-node="slide-0-summary"')
    expect(applyStructuralEdits(edited.html, edited.receipt.inverses).html).toBe(DECK_TEMPLATE)
  })

  it("discovers only direct authored nodes and ignores fake markup in raw text", () => {
    expect(inspectStructuralDocument(document)).toEqual([
      {
        id: "story",
        layout: "stack",
        nodes: [
          { id: "card-a", kind: "card", size: null },
          { id: "card-b", kind: null, size: "compact" },
        ],
      },
    ])
  })

  it("supports a self-closing direct node", () => {
    const html =
      '<div data-derive-region="r" data-derive-layout="stack"><img data-derive-node="image"></div>'
    expect(inspectStructuralDocument(html)[0]?.nodes).toEqual([
      { id: "image", kind: null, size: null },
    ])
  })

  it.each([
    [
      "duplicate regions",
      '<div data-derive-region="r" data-derive-layout="stack"></div><div data-derive-region="r" data-derive-layout="stack"></div>',
      /authored twice/,
    ],
    [
      "duplicate nodes",
      '<div data-derive-region="r" data-derive-layout="stack"><p data-derive-node="n"></p><p data-derive-node="n"></p></div>',
      /authored twice/,
    ],
    [
      "duplicate identity attributes",
      '<div data-derive-region="r" data-derive-region="s" data-derive-layout="stack"></div>',
      /more than one/,
    ],
    [
      "invalid identity",
      '<div data-derive-region="3 bad" data-derive-layout="stack"></div>',
      /must be 1–128/,
    ],
    ["missing layout", '<div data-derive-region="r"></div>', /layout="stack"/],
    [
      "unknown size",
      '<div data-derive-region="r" data-derive-layout="stack"><p data-derive-node="n" data-derive-size="huge"></p></div>',
      /unsupported size/,
    ],
    [
      "a valueless size attribute",
      '<div data-derive-region="r" data-derive-layout="stack"><p data-derive-node="n" data-derive-size></p></div>',
      /without a value/,
    ],
    [
      "an element that is both a region and node",
      '<div data-derive-region="r" data-derive-layout="stack" data-derive-node="n"></div>',
      /cannot also be/,
    ],
    [
      "nested structural node",
      '<div data-derive-region="r" data-derive-layout="stack"><div data-derive-node="a"><p data-derive-node="b"></p></div></div>',
      /direct child/,
    ],
    [
      "a region nested inside a node",
      '<div data-derive-region="outer" data-derive-layout="stack"><div data-derive-node="a"><div data-derive-region="inner" data-derive-layout="stack"><p data-derive-node="b"></p></div></div></div>',
      /cannot be nested/,
    ],
    [
      "unowned text",
      '<div data-derive-region="r" data-derive-layout="stack">surprise<p data-derive-node="n"></p></div>',
      /content outside/,
    ],
    [
      "comment-shaped unowned text",
      '<div data-derive-region="r" data-derive-layout="stack">\u003c<!-- -->!--><p data-derive-node="n"></p></div>',
      /content outside/,
    ],
    [
      "unowned element",
      '<div data-derive-region="r" data-derive-layout="stack"><p>surprise</p><p data-derive-node="n"></p></div>',
      /content outside/,
    ],
    [
      "implicitly closed region",
      '<div data-derive-region="r" data-derive-layout="stack"><p data-derive-node="n"></p>',
      /explicit matching close/,
    ],
    [
      "malformed node close",
      '<div data-derive-region="r" data-derive-layout="stack"><section data-derive-node="n"></div>',
      /explicit matching close/,
    ],
  ])("refuses %s", (_name, html, message) => {
    expect(() => inspectStructuralDocument(html)).toThrow(message as RegExp)
  })
})

describe("applyStructuralEdits", () => {
  it("keeps byte-carrying inverse operations off public edit surfaces", () => {
    expect(
      isStructuralUserEdit({
        schema: STRUCTURAL_EDIT_SCHEMA,
        op: "structural-restore",
        region: "story",
        node: "card-a",
        html: "<script>alert(1)</script>",
        before: null,
        after: null,
      }),
    ).toBe(false)
  })
  it("adds, replaces, and removes semantic size while preserving unrelated source", () => {
    const add = applyStructuralEdits(document, [
      op({ op: "structural-size", region: "story", node: "card-a", size: "full" }),
    ])
    expect(add.html).toContain(
      'data-derive-node="card-a" data-derive-kind="card" data-derive-size="full"',
    )
    expect(add.html.replace(' data-derive-size="full"', "")).toBe(document)
    expect(applyStructuralEdits(add.html, add.receipt.inverses).html).toBe(document)

    const replace = applyStructuralEdits(document, [
      op({ op: "structural-size", region: "story", node: "card-b", size: "standard" }),
    ])
    expect(replace.html).toContain("data-derive-size='standard'")
    expect(applyStructuralEdits(replace.html, replace.receipt.inverses).html).toBe(document)

    const remove = applyStructuralEdits(document, [
      op({ op: "structural-size", region: "story", node: "card-b", size: null }),
    ])
    expect(remove.html).not.toContain("data-derive-size")
    expect(applyStructuralEdits(remove.html, remove.receipt.inverses).html).toBe(document)
  })

  it("reorders complete node chunks and its inverse is byte-identical", () => {
    const result = applyStructuralEdits(document, [
      op({ op: "structural-order", region: "story", nodes: ["card-b", "card-a"] }),
    ])
    expect(result.html.indexOf("data-derive-node='card-b'")).toBeLessThan(
      result.html.indexOf('data-derive-node="card-a"'),
    )
    expect(result.html.indexOf("follows card-a")).toBeGreaterThan(
      result.html.indexOf('data-derive-node="card-a"'),
    )
    expect(applyStructuralEdits(result.html, result.receipt.inverses).html).toBe(document)
  })

  it.each(["a", "b", "c"])("removes and exactly restores the %s node", (node) => {
    const html = `<div data-derive-region="r" data-derive-layout="stack">
  <p data-derive-node="a">A</p>
  <!-- a -->
  <p data-derive-node="b">B</p>
  <p data-derive-node="c">C</p>
</div>`
    const result = applyStructuralEdits(html, [op({ op: "structural-remove", region: "r", node })])
    expect(inspectStructuralDocument(result.html)[0]?.nodes.map(({ id }) => id)).not.toContain(node)
    expect(applyStructuralEdits(result.html, result.receipt.inverses).html).toBe(html)
  })

  it("removes and restores the only node byte-for-byte", () => {
    const html =
      '<div data-derive-region="r" data-derive-layout="stack">\n  <p data-derive-node="only">Only</p>\n</div>'
    const result = applyStructuralEdits(html, [
      op({ op: "structural-remove", region: "r", node: "only" }),
    ])
    expect(inspectStructuralDocument(result.html)[0]?.nodes).toEqual([])
    expect(applyStructuralEdits(result.html, result.receipt.inverses).html).toBe(html)
  })

  it("returns inverses in undo order for a mixed batch", () => {
    const result = applyStructuralEdits(document, [
      op({ op: "structural-size", region: "story", node: "card-a", size: "full" }),
      op({ op: "structural-order", region: "story", nodes: ["card-b", "card-a"] }),
      op({ op: "structural-remove", region: "story", node: "card-b" }),
    ])
    expect(applyStructuralEdits(result.html, result.receipt.inverses).html).toBe(document)
  })

  it.each([
    [
      "an incomplete order",
      op({ op: "structural-order", region: "story", nodes: ["card-a"] }),
      /every node/,
    ],
    [
      "a duplicate order",
      op({ op: "structural-order", region: "story", nodes: ["card-a", "card-a"] }),
      /every node/,
    ],
    [
      "a foreign node",
      op({ op: "structural-order", region: "story", nodes: ["card-a", "elsewhere"] }),
      /every node/,
    ],
    [
      "an unchanged order",
      op({ op: "structural-order", region: "story", nodes: ["card-a", "card-b"] }),
      /existing order/,
    ],
    [
      "an unchanged size",
      op({ op: "structural-size", region: "story", node: "card-b", size: "compact" }),
      /unchanged/,
    ],
    [
      "a missing node",
      op({ op: "structural-remove", region: "story", node: "missing" }),
      /could not find/,
    ],
  ])("refuses %s", (_name, edit, message) => {
    expect(() => applyStructuralEdits(document, [edit as StructuralEdit])).toThrow(
      message as RegExp,
    )
  })

  it("does not expose a partially applied batch when a later operation fails", () => {
    expect(() =>
      applyStructuralEdits(document, [
        op({ op: "structural-size", region: "story", node: "card-a", size: "full" }),
        op({ op: "structural-remove", region: "story", node: "missing" }),
      ]),
    ).toThrow(StructuralEditError)
    expect(document).not.toContain('data-derive-size="full"')
  })

  it("bounds batch size", () => {
    const edits = Array.from({ length: 201 }, () =>
      op({ op: "structural-remove", region: "story", node: "card-a" }),
    )
    expect(() => applyStructuralEdits(document, edits)).toThrow(/maximum/)
  })
})
