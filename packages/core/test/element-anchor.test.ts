import { describe, expect, it } from "vitest"
import {
  type ElementSelector,
  elementLabel,
  elementResolvesIn,
  fingerprintOf,
  isElementAnchor,
  parseElementSelector,
  planElementForwardWalk,
  resolveElement,
  roleOf,
  scanElements,
} from "../src/element-anchor"

const PAGE = `<!doctype html>
<html><head><title>Report</title><style>.x{color:red}</style></head>
<body>
  <h1>Quarterly report</h1>
  <p>Revenue climbed across every region this quarter.</p>
  <img id="rev-chart" src="/charts/revenue.png" alt="Revenue by region">
  <p>The table below breaks it down.</p>
  <table><tr><th>Region</th><th>Rev</th></tr><tr><td>EU</td><td>9</td></tr></table>
  <p>Embedded walkthrough:</p>
  <iframe src="https://youtube.com/embed/abc"></iframe>
  <script>var a = 1 < 2; console.log(a)</script>
</body></html>`

const find = (html: string, tag: string, ordinal = 0) => {
  const d = scanElements(html).find((x) => x.tag === tag && x.ordinal === ordinal)
  if (!d) throw new Error(`no ${tag}#${ordinal}`)
  return d
}

/** Build a selector the way the client would, from a scanned descriptor. */
const selFor = (html: string, tag: string, ordinal = 0): ElementSelector => {
  const ds = scanElements(html)
  const d = ds.find((x) => x.tag === tag && x.ordinal === ordinal)
  if (!d) throw new Error(`no ${tag}#${ordinal}`)
  const before = ds[d.index - 1]?.text
  const after = ds[d.index + 1]?.text
  const role = roleOf(d)
  return {
    type: "ElementSelector",
    tag: d.tag,
    role,
    id: d.id,
    fingerprint: fingerprintOf(d),
    ordinal: d.ordinal,
    docFraction: d.srcFraction,
    before,
    after,
    snapshot: { tag: d.tag, label: elementLabel({ ...d, role }) },
  }
}

describe("scanElements", () => {
  it("indexes elements in document order with same-tag ordinals", () => {
    const ds = scanElements(PAGE)
    const ps = ds.filter((d) => d.tag === "p")
    expect(ps.map((p) => p.ordinal)).toEqual([0, 1, 2])
    expect(ps[0]?.text).toContain("Revenue climbed")
  })

  it("captures id, classes, and kept attrs", () => {
    const img = find(PAGE, "img")
    expect(img.id).toBe("rev-chart")
    expect(img.attrs.src).toBe("/charts/revenue.png")
    expect(img.attrs.alt).toBe("Revenue by region")
  })

  it("skips script/style content (and their stray < characters)", () => {
    const ds = scanElements(PAGE)
    expect(ds.some((d) => d.tag === "script" || d.tag === "style")).toBe(false)
    // The `1 < 2` inside the script must not derail tokenizing the iframe before it.
    expect(ds.some((d) => d.tag === "iframe")).toBe(true)
  })

  it("treats void elements as childless and decodes entities", () => {
    const ds = scanElements(`<p>a &amp; b &lt;ok&gt;</p><img src="x.png"><p>after</p>`)
    expect(ds.find((d) => d.tag === "p")?.text).toBe("a & b <ok>")
    expect(ds.filter((d) => d.tag === "p")).toHaveLength(2)
  })
})

describe("roleOf + elementLabel", () => {
  it("classifies common elements", () => {
    expect(roleOf(find(PAGE, "img"))).toBe("image")
    expect(roleOf(find(PAGE, "table"))).toBe("table")
    expect(roleOf(find(PAGE, "iframe"))).toBe("embed")
  })
  it("reads chart hints from class/id", () => {
    const d = find(`<div class="bar-chart" id="x"></div>`, "div")
    expect(roleOf(d)).toBe("chart")
  })
  it("labels with alt / host", () => {
    const img = find(PAGE, "img")
    expect(elementLabel({ ...img, role: "image" })).toBe("Image — Revenue by region")
    const ifr = find(PAGE, "iframe")
    expect(elementLabel({ ...ifr, role: "embed" })).toBe("Embedded — youtube.com")
  })
})

describe("resolveElement — the cascade", () => {
  it("resolves an unchanged element with high confidence", () => {
    const sel = selFor(PAGE, "img")
    const m = elementResolvesIn(sel, PAGE)
    expect(m?.confidence).toBeGreaterThan(0.6)
    expect(m?.band).toBe("high")
    expect(m?.signals).toContain("id")
    expect(m?.signals).toContain("content")
  })

  it("relocates by content fingerprint when the id is dropped", () => {
    const sel = selFor(PAGE, "img")
    const v2 = PAGE.replace(' id="rev-chart"', "")
    const m = elementResolvesIn(sel, v2)
    expect(m).not.toBeNull()
    expect(m?.signals).toContain("content")
    expect(m?.band).toBe("high")
  })

  it("relocates by id + neighbors when the image src changes (fingerprint breaks)", () => {
    const sel = selFor(PAGE, "img")
    const v2 = PAGE.replace("/charts/revenue.png", "/charts/revenue-v2.png").replace(
      'alt="Revenue by region"',
      'alt="Revenue, restated"',
    )
    const m = elementResolvesIn(sel, v2)
    expect(m).not.toBeNull()
    expect(m?.signals).toContain("id")
  })

  it("survives content landing above it (ordinal + neighbors shift, id holds)", () => {
    const sel = selFor(PAGE, "img")
    const v2 = PAGE.replace("<h1>", '<p>New intro paragraph.</p><img src="top.png"><h1>')
    const m = elementResolvesIn(sel, v2)
    expect(m).not.toBeNull()
    const ds = scanElements(v2)
    expect(ds[m?.index ?? -1]?.id).toBe("rev-chart")
  })

  it("does not resolve a genuinely removed element", () => {
    const sel = selFor(PAGE, "iframe")
    const v2 = PAGE.replace(/<iframe[^>]*><\/iframe>/, "")
    expect(elementResolvesIn(sel, v2)).toBeNull()
  })

  it("disambiguates duplicate tags by ordinal + neighbors", () => {
    const html = `<p>alpha</p><img src="a.png" alt="A"><p>between</p><img src="a.png" alt="A"><p>omega</p>`
    const sel = selFor(html, "img", 1) // the second image
    const m = elementResolvesIn(sel, html)
    const ds = scanElements(html)
    expect(ds[m?.index ?? -1]?.ordinal).toBe(1)
    expect(m?.signals).toContain("position")
  })
})

describe("planElementForwardWalk — version recovery", () => {
  it("recovers an element renamed then moved across versions", () => {
    const v0 = PAGE
    const sel = selFor(v0, "img")
    // v1: id renamed. v2: also moved up. v3: alt reworded too.
    const v1 = v0.replace('id="rev-chart"', 'id="chart-revenue"')
    const v2 = v1.replace("<h1>", "<p>Preface.</p><h1>")
    const v3 = v2.replace('alt="Revenue by region"', 'alt="Revenue by region (FY)"')
    // First-to-last is unrecognizable by id; per-hop it stays resolvable.
    const walk = planElementForwardWalk(sel, [v1, v2, v3])
    expect(walk.resolved).toBe(true)
    expect(walk.survived).toBe(3)
    // The carried-forward selector picked up the new id along the way.
    expect(walk.selector.id).toBe("chart-revenue")
  })

  it("reports where the trail goes cold", () => {
    const sel = selFor(PAGE, "iframe")
    const gone = PAGE.replace(/<iframe[^>]*><\/iframe>/, "<p>removed</p>")
    const walk = planElementForwardWalk(sel, [PAGE, gone, PAGE])
    expect(walk.resolved).toBe(false)
    expect(walk.survived).toBe(1)
  })
})

describe("parse helpers", () => {
  it("recognizes element anchors and rejects text quotes", () => {
    const el = JSON.stringify(selFor(PAGE, "img"))
    expect(isElementAnchor(el)).toBe(true)
    expect(parseElementSelector(el)?.tag).toBe("img")
    expect(isElementAnchor(JSON.stringify({ type: "TextQuoteSelector", exact: "hi" }))).toBe(false)
    expect(isElementAnchor(null)).toBe(false)
    expect(isElementAnchor("not json")).toBe(false)
  })
})

describe("resolveElement edge cases", () => {
  it("returns null on an empty document", () => {
    expect(resolveElement(selFor(PAGE, "img"), [])).toBeNull()
  })
  it("fingerprint is stable + order-independent of the page it came from", () => {
    const a = fingerprintOf(find(PAGE, "img"))
    const b = fingerprintOf(
      find(`<img id="rev-chart" src="/charts/revenue.png" alt="Revenue by region">`, "img"),
    )
    expect(a).toBe(b)
  })
})
