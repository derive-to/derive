import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  type ElementSelector,
  elementLabel,
  elementResolvesIn,
  fingerprintOf,
  fnv1a,
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

  it("auto-closes optional-end-tag elements like a browser (p/li/td neighbour parity)", () => {
    // Unclosed <p>/<li>/<td> must read as SIBLINGS, not nested — otherwise an
    // element's neighbour text diverges from the live DOM and the server's anchored
    // check disagrees with the painted overlay.
    expect(
      scanElements("<p>one<p>two<p>three")
        .filter((d) => d.tag === "p")
        .map((d) => d.text),
    ).toEqual(["one", "two", "three"])
    expect(
      scanElements("<ul><li>a<li>b<li>c</ul>")
        .filter((d) => d.tag === "li")
        .map((d) => d.text),
    ).toEqual(["a", "b", "c"])
    expect(scanElements("<p>intro<div>block</div>tail").find((d) => d.tag === "p")?.text).toBe(
      "intro",
    )
    // An image between two unclosed <p>s sees the right neighbours.
    const ds = scanElements(`<p>before<img src="/x.png" alt="X"><p>after`)
    const i = ds.findIndex((d) => d.tag === "img")
    expect(ds[i - 1]?.text).toBe("before")
    expect(ds[i + 1]?.text).toBe("after")
  })

  it("keeps the FIRST of duplicate attributes (matches the HTML parser + getAttribute)", () => {
    // Invalid HTML, but it happens. Browsers keep the first occurrence and ignore the
    // rest; the scanner must agree or its fingerprint won't match the live one.
    const d = scanElements(`<img src="first.png" src="second.png" alt="A" alt="B">`).find(
      (x) => x.tag === "img",
    )
    expect(d?.attrs.src).toBe("first.png")
    expect(d?.attrs.alt).toBe("A")
  })

  it("decodes numeric + named entities in attributes the way a browser does", () => {
    const d = scanElements(`<img src="x" alt="A &amp; B &#233; &#xe9; &lt;ok&gt;">`).find(
      (x) => x.tag === "img",
    )
    expect(d?.attrs.alt).toBe("A & B é é <ok>")
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

  it("disambiguates duplicate (same-content) tags by neighbors, not ordinal", () => {
    // Two byte-identical images; the only thing telling them apart is the text around
    // them. With ambiguous content, ordinal is untrustworthy (an insertion shifts it),
    // so the neighbors — not position — must pick the right instance.
    const html = `<p>alpha</p><img src="a.png" alt="A"><p>between</p><img src="a.png" alt="A"><p>omega</p>`
    const sel = selFor(html, "img", 1) // the second image (between / omega)
    const m = elementResolvesIn(sel, html)
    const ds = scanElements(html)
    expect(ds[m?.index ?? -1]?.ordinal).toBe(1)
    expect(m?.signals.some((s) => s.startsWith("neighbor"))).toBe(true)
    expect(m?.signals).not.toContain("position") // ordinal dropped for ambiguous content
  })
})

describe("resolveElement — ambiguity must not breed false confidence", () => {
  it("a gallery of identical thumbnails, with one deleted, never resolves HIGH", () => {
    // 12 byte-identical thumbnails; anchor #6; remove it. The cascade can relocate
    // to *a* sibling (better than orphaning) but must NOT claim certainty — content
    // matches all of them, so the pick leans on position, which a deletion scrambles.
    const cell = `<img src="/t.png" alt="thumb">`
    const v1 = `<div>${cell.repeat(12)}</div>`
    const sel = selFor(v1, "img", 6)
    const v2 = `<div>${cell.repeat(11)}</div>`
    const m = elementResolvesIn(sel, v2)
    expect(m?.band).not.toBe("high")
    expect(m?.confidence ?? 1).toBeLessThanOrEqual(0.5)
  })

  it("deleting a distinct element never high-confidence-lands on a different one", () => {
    const v1 = `<p>alpha</p><img id="A" src="/a.png" alt="Apple"><p>mid</p><img id="B" src="/b.png" alt="Banana"><p>omega</p>`
    const sel = selFor(v1, "img", 0) // "Apple"
    const v2 = v1.replace(/<img id="A"[^>]*>/, "") // only the distinct "Banana" remains
    const m = elementResolvesIn(sel, v2)
    // Either orphan or a low/medium relocation — never a confident match on Banana.
    if (m) expect(m.band).not.toBe("high")
  })

  it("many distinct anchors survive a compound shuffle without cross-contaminating", () => {
    // 8 distinct charts, each with a comment. The republish shuffles their order, wraps
    // every block in a <section>, AND rewords every caption — all at once. Each comment
    // must land on its OWN chart (by content), and no two may collapse onto the same one.
    const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"]
    const v1 = names
      .map((n) => `<h3>${n}</h3><img src="/${n}.png" alt="${n} chart"><p>${n} notes.</p>`)
      .join("")
    const sels = names.map((n) => selFor(v1, "img", names.indexOf(n)))
    // Reverse order + wrap in sections + reword the prose (images unchanged).
    const v2 = [...names]
      .reverse()
      .map(
        (n) =>
          `<section><h3>${n} (revised)</h3><img src="/${n}.png" alt="${n} chart"><p>Updated discussion of ${n}.</p></section>`,
      )
      .join("")
    const ds2 = scanElements(v2)
    const landed = new Set<number>()
    sels.forEach((sel, i) => {
      const m = resolveElement(sel, ds2)
      expect(m, `anchor ${names[i]} orphaned`).not.toBeNull()
      expect(ds2[m?.index ?? -1]?.attrs.alt).toBe(`${names[i]} chart`) // its OWN chart
      expect(landed.has(m?.index ?? -1), `collision on ${names[i]}`).toBe(false)
      landed.add(m?.index ?? -1)
    })
  })

  it("a repeated element (logo on every slide) follows neighbors, not a shifted ordinal", () => {
    // The brand logo repeats on every slide. A comment on slide 3's logo must stay on
    // slide 3 when a slide is INSERTED at the front — even though that shifts every
    // logo's ordinal. Before the fix, the stale ordinal dragged it to slide 2's logo.
    const slide = (t: string) =>
      `<section><h2>${t}</h2><img src="/logo.png" alt="Logo"><p>${t} body text unique to this slide.</p></section>`
    const v1 = ["Intro", "Market", "Revenue", "Costs", "Outlook"].map(slide).join("")
    const sel = selFor(v1, "img", 2) // Revenue slide's logo
    const v2 = ["NEW", "Intro", "Market", "Revenue", "Costs", "Outlook"].map(slide).join("")
    const m = elementResolvesIn(sel, v2)
    expect(m).not.toBeNull()
    const ds = scanElements(v2)
    // The landed logo's slide = the nearest preceding <h2>; it must be "Revenue".
    let slideTitle = ""
    for (let i = (m?.index ?? 0) - 1; i >= 0; i--) {
      if (ds[i]?.tag === "h2") {
        slideTitle = ds[i]?.text ?? ""
        break
      }
    }
    expect(slideTitle).toBe("Revenue")
  })

  it("a WRAPPED element disambiguates by its sibling caption, not its container", () => {
    // Gallery of identical thumbnails, each wrapped in a cell with its own caption.
    // The caption is a SIBLING, not the enclosing <div> — neighbour lookup must skip
    // the container (which would otherwise read the same text for every cell) so the
    // server resolves the same instance the browser-side walk does.
    const cell = (cap: string) =>
      `<div class="cell"><img src="/t.png" alt="thumb"><p>${cap}</p></div>`
    const v1 = cell("alpha caption") + cell("bravo caption") + cell("charlie caption")
    const sel = selFor(v1, "img", 1) // the "bravo" thumbnail
    expect(sel.after).toBe("bravo caption") // sibling caption, not the cell div
    // Reorder the cells; it must follow its caption to the right instance.
    const v2 = cell("charlie caption") + cell("bravo caption") + cell("alpha caption")
    const ds = scanElements(v2)
    const m = resolveElement(sel, ds)
    let cap = ""
    for (let i = (m?.index ?? 0) + 1; i < ds.length; i++)
      if (ds[i]?.tag === "p") {
        cap = ds[i]?.text ?? ""
        break
      }
    expect(cap).toBe("bravo caption")
  })

  it("never claims high confidence when id and content disagree (a content swap)", () => {
    // Two charts; comment on the red one. Then the two swap their src+alt but keep
    // their ids — so the comment's id points one way and its content the other. That
    // conflict can't be "high"; it relocates but flags itself (medium).
    const v1 = `<p>a</p><img id="A" src="/red.png" alt="Red chart"><p>b</p><img id="B" src="/blue.png" alt="Blue chart"><p>c</p>`
    const sel = selFor(v1, "img", 0)
    const v2 = `<p>a</p><img id="A" src="/blue.png" alt="Blue chart"><p>b</p><img id="B" src="/red.png" alt="Red chart"><p>c</p>`
    const m = elementResolvesIn(sel, v2)
    expect(m).not.toBeNull()
    expect(m?.band).not.toBe("high")
    expect(m?.confidence ?? 1).toBeLessThanOrEqual(0.6)
  })

  it("stays fast + non-crashing on a huge document", () => {
    const huge = `<div>${`<img src="/x.png" alt="t">`.repeat(2000)}</div>`
    const sel = selFor(huge, "img", 1000)
    const t = Date.now()
    const m = elementResolvesIn(sel, huge)
    expect(Date.now() - t).toBeLessThan(2000)
    expect(m).not.toBeNull()
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

  it("self-heal CONVERGES: the recovered selector then resolves in one jump", () => {
    // A chain where neither id nor content survives v1→v4, but each hop keeps one.
    // The sweep can't one-jump it, recovers via the walk, and the carried-forward
    // selector must then one-jump resolve the current version — so the NEXT sweep is
    // cheap and the state can't thrash open↔outdated.
    const p = (id: string, src: string, alt: string) =>
      `<p>before</p><img id="${id}" src="${src}" alt="${alt}"><p>after</p>`
    const v1 = p("A", "/1.png", "Hero one")
    const chain = [
      p("A", "/2.png", "Hero two"),
      p("B", "/2.png", "Hero two"),
      p("B", "/3.png", "Hero three"),
    ]
    const start = selFor(v1, "img")
    const current = chain[chain.length - 1] as string
    expect(elementResolvesIn(start, current)).toBeNull() // one-jump fails end-to-end
    const walk = planElementForwardWalk(start, chain)
    expect(walk.resolved).toBe(true)
    // The healed selector resolves the current version directly (convergence).
    expect(elementResolvesIn(walk.selector, current)).not.toBeNull()
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

// The iframe client (ANCHOR_CLIENT_JS in anchor.ts) duplicates `fnv` verbatim so a
// fingerprint made in the browser equals one made here. If they drift, element
// anchors created in the browser silently stop resolving server-side. Pin parity by
// extracting the client's fnv and comparing it to fnv1a.
describe("client/server fingerprint parity", () => {
  it("the browser client's fnv() equals fnv1a()", () => {
    const path = fileURLToPath(new URL("../src/anchor.ts", import.meta.url))
    const src = readFileSync(path, "utf8")
    const marker = "export const ANCHOR_CLIENT_JS = `"
    const start = src.indexOf(marker) + marker.length
    let i = start
    let end = -1
    while (i < src.length) {
      if (src[i] === "\\") {
        i += 2
        continue
      }
      if (src[i] === "`") {
        end = i
        break
      }
      i++
    }
    const js = src.slice(start, end).replace(/\\(.)/g, (_, c) => c) // one unescape level
    const body = js.match(/function fnv\(s\)\{[\s\S]*?return h\.toString\(36\)\}/)
    expect(body).not.toBeNull()
    const clientFnv = new Function(`${body?.[0]};return fnv`)() as (s: string) => string
    for (const c of ["", "abc", "img/charts/revenue.pngRevenue by region", "tableweird", "héllo"]) {
      expect(clientFnv(c)).toBe(fnv1a(c))
    }
  })

  // The hash matching isn't enough: the two sides also have to JOIN the fields the
  // same way. They once differed (empty string vs a control-char separator), so every
  // browser-made anchor failed to resolve server-side. This extracts the client's real
  // elFp chain and pins it to fingerprintOf, end to end.
  it("the browser client's elFp() equals fingerprintOf() — fields AND separator", () => {
    const path = fileURLToPath(new URL("../src/anchor.ts", import.meta.url))
    const src = readFileSync(path, "utf8")
    const head = "export const ANCHOR_CLIENT_JS = `"
    const m = src.indexOf(head)
    let i = m + head.length
    let end = -1
    while (i < src.length) {
      if (src[i] === "\\") {
        i += 2
        continue
      }
      if (src[i] === "`") {
        end = i
        break
      }
      i++
    }
    const js = src.slice(m + head.length, end).replace(/\\(.)/g, (_, c) => c)
    const grab = (re: RegExp) => {
      const g = js.match(re)
      if (!g) throw new Error(`client fn not found: ${re}`)
      return g[0]
    }
    const clientElFp = new Function(
      `${grab(/function fnv\(s\)\{[\s\S]*?return h\.toString\(36\)\}/)}
       ${grab(/function nw\(s\)\{[\s\S]*?\}/)}
       ${grab(/function elSrc\(el\)\{[\s\S]*?\}/)}
       ${grab(/function elAlt\(el\)\{[\s\S]*?\}/)}
       ${grab(/function elText\(el\)\{[\s\S]*?\}/)}
       ${grab(/function elFp\(el\)\{[\s\S]*?\}/)}
       return elFp`,
    )() as (el: unknown) => string
    const stub = (tag: string, attrs: Record<string, string>, text = "") => ({
      tagName: tag.toUpperCase(),
      textContent: text,
      getAttribute: (k: string) => attrs[k] ?? null,
    })
    const cases: Array<[string, Record<string, string>, string]> = [
      ["img", { src: "https://x.test/a.png?text=Hero%2BChart", alt: "Unique Hero Chart" }, ""],
      ["iframe", { src: "https://youtube.com/embed/abc" }, ""],
      ["pre", {}, "const x = 1"],
      ["img", { src: "a", alt: "b" }, ""], // boundary the separator defends
    ]
    for (const [tag, attrs, text] of cases) {
      expect(clientElFp(stub(tag, attrs, text))).toBe(fingerprintOf({ tag, attrs, text }))
    }
    // Proof the separator is load-bearing: these collide if fields are joined with "".
    expect(fingerprintOf({ tag: "img", attrs: { src: "a", alt: "b" }, text: "" })).not.toBe(
      fingerprintOf({ tag: "img", attrs: { alt: "ab" }, text: "" }),
    )
  })
})
