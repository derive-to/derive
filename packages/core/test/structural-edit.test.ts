import { describe, expect, it } from "vitest"
import { DECK_TEMPLATE } from "../src/deck-template.gen"
import {
  applyStructuralEdits,
  backfillLegacyDeckStructure,
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
    <article data-derive-node='card-b' data-derive-size='compact' title="x > y">
      <h2>B</h2>
    </article>
  </section>
</main>`

const legacyDeck = `<!doctype html><html><head><style>.slide{display:none}.slide.on{display:block}</style></head><body>
<main>
  <section class="slide on" data-derive-slide="4">
    <h2>First</h2>
    <div class="composition"><p>One atomic composition</p></div>
  </section>
  <section class="slide">
    <span>Context</span>
    <figure><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg></figure>
  </section>
</main>
<script>parent.postMessage({source:'derive-deck',type:'deck',n:2},'*')</script>
</body></html>`

describe("backfillLegacyDeckStructure", () => {
  it("optimistically stamps safe legacy slide children with stable exact-source identities", () => {
    const result = backfillLegacyDeckStructure(legacyDeck)
    expect(result).toMatchObject({ changed: true, regions: 2, nodes: 4, skipped: [] })
    expect(result.html).toContain('data-derive-slide="5"')
    expect(result.html).toContain('data-derive-region="slide-4" data-derive-layout="stack"')
    expect(result.html).toContain('data-derive-node="slide-4-node-1" data-derive-kind="heading"')
    expect(result.html).toContain('data-derive-node="slide-5-node-2" data-derive-kind="visual"')
    expect(result.html).toContain("data-derive-structural-backfill")
    expect(inspectStructuralDocument(result.html)).toEqual([
      {
        id: "slide-4",
        layout: "stack",
        nodes: [
          { id: "slide-4-node-1", kind: "heading", size: null },
          { id: "slide-4-node-2", kind: "group", size: null },
        ],
      },
      {
        id: "slide-5",
        layout: "stack",
        nodes: [
          { id: "slide-5-node-1", kind: "group", size: null },
          { id: "slide-5-node-2", kind: "visual", size: null },
        ],
      },
    ])
    expect(backfillLegacyDeckStructure(result.html).html).toBe(result.html)
  })

  it("uses isolated runtime attributes without activating the canonical contract", () => {
    const html = `<style>
[data-derive-node] { display:none!important }
[data-derive-region] { position:absolute;left:333px }
[data-derive-layout="stack"] { outline:8px solid red }
[data-derive-kind] { opacity:0 }
</style><section class="slide" data-derive-slide="0"><h2>A</h2><p>B</p></section>`
    const result = backfillLegacyDeckStructure(html, { runtime: true })
    expect(result).toMatchObject({ changed: true, regions: 1, nodes: 2, skipped: [] })
    expect(result.html).toContain('data-derive-runtime-region="slide-0"')
    expect(result.html).toContain('data-derive-runtime-node="slide-0-node-1"')
    expect(result.html).toContain("[data-derive-runtime-region]")
    expect(result.html).not.toContain("<h2 data-derive-node=")
    expect(result.html).not.toContain(
      '<section class="slide" data-derive-slide="0" data-derive-region=',
    )
    expect(backfillLegacyDeckStructure(result.html, { runtime: true }).html).toBe(result.html)
  })

  it("keeps legacy slides with source-owned comments out of structural editing", () => {
    const html = `<section class="slide" data-derive-slide="0">
  <!-- leading region comment is fixed -->
  <h2>A</h2>
  <!-- belongs to the preceding source chunk -->
  <p>B</p>
</section>
<section class="slide" data-derive-slide="1"><h2>C</h2><!-- trailing source comment --></section>`
    expect(backfillLegacyDeckStructure(html)).toEqual({
      html,
      changed: false,
      regions: 0,
      nodes: 0,
      skipped: [
        { slide: 1, reason: "comment-gap" },
        { slide: 2, reason: "comment-gap" },
      ],
    })
  })

  it("indexes direct children once while preserving large-deck output", () => {
    const html = Array.from(
      { length: 1000 },
      (_, slide) =>
        `<section class="slide" data-derive-slide="${slide}">${Array.from(
          { length: 8 },
          (_, node) => `<div>Slide ${slide} node ${node}</div>`,
        ).join("")}</section>`,
    ).join("\n")
    const result = backfillLegacyDeckStructure(html)
    expect(result).toMatchObject({ changed: true, regions: 1000, nodes: 8000, skipped: [] })
    expect(inspectStructuralDocument(result.html)).toHaveLength(1000)
    expect(backfillLegacyDeckStructure(result.html).html).toBe(result.html)
  })

  it("makes a legacy deck immediately reorderable, resizable, removable, and reversible", () => {
    const backfilled = backfillLegacyDeckStructure(legacyDeck).html
    const edited = applyStructuralEdits(backfilled, [
      op({
        op: "structural-order",
        region: "slide-4",
        nodes: ["slide-4-node-2", "slide-4-node-1"],
      }),
      op({
        op: "structural-size",
        region: "slide-4",
        node: "slide-4-node-2",
        size: "compact",
      }),
      op({
        op: "structural-remove",
        region: "slide-5",
        node: "slide-5-node-1",
      }),
    ])
    expect(edited.html.indexOf("slide-4-node-2")).toBeLessThan(
      edited.html.indexOf("slide-4-node-1"),
    )
    expect(edited.html).toContain('data-derive-size="compact"')
    expect(edited.html).not.toContain('data-derive-node="slide-5-node-1"')
    expect(applyStructuralEdits(edited.html, edited.receipt.inverses).html).toBe(backfilled)
  })

  it("gives an explicit legacy size preset authority over ordinary authored width rules", () => {
    const html = `<style>#deck .slide > .card { width: 240px }</style>
<main id="deck">
  <section class="slide" data-derive-slide="0"><div class="card" style="width: 240px">A</div></section>
</main>`
    const backfilled = backfillLegacyDeckStructure(html).html
    const edited = applyStructuralEdits(backfilled, [
      op({
        op: "structural-size",
        region: "slide-0",
        node: "slide-0-node-1",
        size: "compact",
      }),
    ])
    expect(edited.html).toContain("width: 50% !important")
    expect(edited.html).toContain('style="width: 240px"')
    expect(edited.html).toContain('data-derive-size="compact"')
    expect(applyStructuralEdits(edited.html, edited.receipt.inverses).html).toBe(backfilled)
  })

  it("ignores parser decoys while keeping wrapped foreign content atomic", () => {
    const html = `<script>const fake = '<section class="slide"><i data-derive-node="fake"></i></section>'</script>
<!-- <section class="slide"><b data-derive-node="also-fake"></b></section> -->
<section class="slide" data-derive-slide="0" title="a > b">
  <h2 title='x > y'>A<!-- <p data-derive-node="comment-fake">no</p> --></h2>
  <div><svg viewBox="0 0 10 10"><title>Chart</title></svg><math><mi>x</mi></math><script>const close = '</section>'</script></div>
</section>
<section class="slide" data-derive-slide="1"><h2>B</h2><p>Body</p></section>`
    const result = backfillLegacyDeckStructure(html)
    expect(result).toMatchObject({ changed: true, regions: 2, nodes: 4, skipped: [] })
    const inspected = inspectStructuralDocument(result.html)
    expect(inspected).toHaveLength(2)
    expect(inspected.flatMap((region) => region.nodes.map((node) => node.id))).toEqual([
      "slide-0-node-1",
      "slide-0-node-2",
      "slide-1-node-1",
      "slide-1-node-2",
    ])
    expect(backfillLegacyDeckStructure(result.html).html).toBe(result.html)

    const edited = applyStructuralEdits(result.html, [
      op({
        op: "structural-order",
        region: "slide-0",
        nodes: ["slide-0-node-2", "slide-0-node-1"],
      }),
      op({
        op: "structural-size",
        region: "slide-0",
        node: "slide-0-node-2",
        size: "full",
      }),
      op({ op: "structural-remove", region: "slide-1", node: "slide-1-node-2" }),
    ])
    expect(applyStructuralEdits(edited.html, edited.receipt.inverses).html).toBe(result.html)
  })

  it("mints safe unique identities after MAX_SAFE_INTEGER without changing authored ids", () => {
    const html = `<section class="slide" data-derive-slide="9007199254740991"><h2>Max</h2></section>
<section class="slide"><h2>Fresh A</h2></section>
<section class="slide" data-derive-slide="-7"><h2>Negative</h2></section>
<section class="slide"><h2>Fresh B</h2></section>`
    const result = backfillLegacyDeckStructure(html)
    expect(result).toMatchObject({ changed: true, regions: 4, nodes: 4, skipped: [] })
    expect(result.html).toContain('data-derive-slide="9007199254740991"')
    expect(result.html).toContain('data-derive-slide="-7"')
    expect(result.html).toContain('data-derive-slide="0"')
    expect(result.html).toContain('data-derive-slide="1"')
    expect(inspectStructuralDocument(result.html).map((region) => region.id)).toEqual([
      "slide-9007199254740991",
      "slide-0",
      "slide--7",
      "slide-1",
    ])
    expect(backfillLegacyDeckStructure(result.html).html).toBe(result.html)
  })

  it("backfills safe slides independently and reports ambiguous ownership", () => {
    const html = `<main>
  <section class="slide" data-derive-slide="0"><h2>Safe</h2><p>Owned</p></section>
  <section class="slide"><h2>Unsafe</h2>loose text<p>Not guessed</p></section>
</main>`
    const result = backfillLegacyDeckStructure(html)
    expect(result).toMatchObject({
      changed: true,
      regions: 1,
      nodes: 2,
      skipped: [{ slide: 2, reason: "unowned-content" }],
    })
    expect(result.html).toContain('data-derive-region="slide-0"')
    expect(result.html).toContain('<section class="slide" data-derive-slide="1">')
    expect(result.html).not.toContain('data-derive-region="slide-1"')
  })

  it.each([
    [
      "a direct runtime child",
      `<section class="slide" data-derive-slide="0"><h2>A</h2><script>boot()</script></section>
       <section class="slide" data-derive-slide="1"><h2>B</h2><style>b{}</style></section>`,
      "runtime-child",
    ],
    [
      "implicitly closed children",
      `<section class="slide" data-derive-slide="0"><p>A<p>B</section>
       <section class="slide" data-derive-slide="1"><p>A<p>B</section>`,
      "implicit-close",
    ],
    [
      "a direct non-HTML child",
      `<section class="slide" data-derive-slide="0"><svg viewBox="0 0 10 10"><circle r="4"/></svg></section>
       <section class="slide" data-derive-slide="1"><math><mi>x</mi></math></section>`,
      "non-html-child",
    ],
    [
      "a browser-context-dependent direct child",
      `<section class="slide" data-derive-slide="0"><tr><td>A</td></tr></section>
       <section class="slide" data-derive-slide="1"><caption>B</caption></section>`,
      "browser-context-child",
    ],
  ])("refuses to guess through %s", (_name, html, reason) => {
    const result = backfillLegacyDeckStructure(html)
    expect(result.changed).toBe(false)
    expect(result.skipped.map((skip) => skip.reason)).toContain(reason)
  })

  it("keeps valid table and select wrappers movable as atomic HTML nodes", () => {
    const html = `<section class="slide" data-derive-slide="0"><table><tbody><tr><td>A</td></tr></tbody></table></section>
<section class="slide" data-derive-slide="1"><select><optgroup label="B"><option>C</option></optgroup></select></section>`
    const result = backfillLegacyDeckStructure(html)
    expect(result).toMatchObject({ changed: true, regions: 2, nodes: 2, skipped: [] })
    expect(inspectStructuralDocument(result.html).map((region) => region.nodes[0]?.kind)).toEqual([
      "group",
      "group",
    ])
  })

  it("never completes a partial authored contract with inferred intent", () => {
    const html = `<section class="slide" data-derive-slide="0" data-derive-region="custom" data-derive-layout="stack"><h2 data-derive-node="title">A</h2></section>
<section class="slide" data-derive-slide="1"><h2>B</h2></section>`
    expect(backfillLegacyDeckStructure(html)).toEqual({
      html,
      changed: false,
      regions: 0,
      nodes: 0,
      skipped: [],
    })
  })

  it.each([
    "data-derive-layout",
    "data-derive-kind",
    "data-derive-size",
  ])("never completes a foreign partial contract containing %s", (attribute) => {
    const html = `<section class="slide" data-derive-slide="0"><h2 ${attribute}="huge">A</h2></section>
<section class="slide" data-derive-slide="1"><h2>B</h2></section>`
    expect(backfillLegacyDeckStructure(html)).toEqual({
      html,
      changed: false,
      regions: 0,
      nodes: 0,
      skipped: [],
    })
  })
})

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
      /must declare data-derive-owner="a"/,
    ],
    [
      "a top-level region with an owner",
      '<div data-derive-region="outer" data-derive-layout="stack" data-derive-owner="a"></div>',
      /cannot declare an owner/,
    ],
    [
      "two child regions owned by one node",
      '<div data-derive-region="outer" data-derive-layout="stack"><div data-derive-node="a"><div data-derive-region="one" data-derive-layout="stack" data-derive-owner="a"></div><div data-derive-region="two" data-derive-layout="stack" data-derive-owner="a"></div></div></div>',
      /cannot own both/,
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
  it("edits explicit child regions and their owning group independently", () => {
    const html = `<section data-derive-region="slide" data-derive-layout="stack">
  <header data-derive-node="title">Title</header>
  <div data-derive-node="board">
    <div data-derive-region="board-cards" data-derive-layout="stack" data-derive-owner="board">
      <article data-derive-node="discover">Discover</article>
      <article data-derive-node="move">Move</article>
      <article data-derive-node="recover">Recover</article>
    </div>
  </div>
</section>`
    expect(inspectStructuralDocument(html).map(({ id }) => id)).toEqual(["slide", "board-cards"])

    const inner = applyStructuralEdits(html, [
      op({
        op: "structural-order",
        region: "board-cards",
        nodes: ["recover", "discover", "move"],
      }),
    ])
    expect(inner.html.indexOf("recover")).toBeLessThan(inner.html.indexOf("discover"))
    expect(applyStructuralEdits(inner.html, inner.receipt.inverses).html).toBe(html)

    const outer = applyStructuralEdits(html, [
      op({ op: "structural-order", region: "slide", nodes: ["board", "title"] }),
    ])
    expect(outer.html.indexOf('data-derive-node="board"')).toBeLessThan(
      outer.html.indexOf('data-derive-node="title"'),
    )
    expect(outer.html).toContain('data-derive-owner="board"')
    expect(applyStructuralEdits(outer.html, outer.receipt.inverses).html).toBe(html)
  })

  it("lets a parent removal supersede its complete child region byte-for-byte", () => {
    const html = `<div data-derive-region="root" data-derive-layout="stack">
  <div data-derive-node="group"><div data-derive-region="children" data-derive-layout="stack" data-derive-owner="group"><p data-derive-node="a">A</p><p data-derive-node="b">B</p></div></div>
  <p data-derive-node="tail">Tail</p>
</div>`
    const result = applyStructuralEdits(html, [
      op({ op: "structural-remove", region: "root", node: "group" }),
    ])
    expect(result.html).not.toContain('data-derive-region="children"')
    expect(applyStructuralEdits(result.html, result.receipt.inverses).html).toBe(html)
  })

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
    expect(applyStructuralEdits(result.html, result.receipt.inverses).html).toBe(document)
  })

  it("rejects comments owned by movable source chunks", () => {
    const html = `<div data-derive-region="r" data-derive-layout="stack">
  <p data-derive-node="a">A</p>
  <!-- marker -->
  <p data-derive-node="b">B</p>
</div>`
    expect(() => inspectStructuralDocument(html)).toThrow(
      "contains a comment between structural nodes",
    )
  })

  it.each(["a", "b", "c"])("removes and exactly restores the %s node", (node) => {
    const html = `<div data-derive-region="r" data-derive-layout="stack">
  <p data-derive-node="a">A</p>
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
