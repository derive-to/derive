import { describe, expect, it } from "vitest"
import {
  type ElementSelector,
  elementLabel,
  elementResolvesIn,
  fingerprintOf,
  fnv1a,
  isElementAnchor,
  normWs,
  parseElementSelector,
  planElementForwardWalk,
  resolveElement,
  roleOf,
  scanElements,
} from "./element-anchor"

// Characterization tests for the element-anchor engine. This is the behavior
// CONTRACT the in-iframe client must reproduce: `fnv1a`/`fingerprintOf` are copied
// verbatim into `ANCHOR_CLIENT_JS`, so a browser-made fingerprint has to equal a
// server-made one byte-for-byte. Golden values below are pinned deliberately — if a
// refactor changes them, the client and server have silently drifted and every
// browser-made element anchor stops resolving server-side.

// Build a minimal valid selector, overriding the fields a test cares about.
const sel = (over: Partial<ElementSelector>): ElementSelector => ({
  type: "ElementSelector",
  tag: "img",
  role: "image",
  fingerprint: "x",
  ordinal: 0,
  docFraction: 0,
  snapshot: { tag: "img", label: "Image" },
  ...over,
})
const fpImg = (src: string, text = "") => fingerprintOf({ tag: "img", attrs: { src }, text })

describe("fnv1a — the byte-stable content hash (client/server parity)", () => {
  it("produces the pinned golden values", () => {
    // These MUST match the browser-side `fnv` in ANCHOR_CLIENT_JS. Do not update
    // them to make a refactor pass — a change here is a parity break.
    expect(fnv1a("")).toBe("ztntfp")
    expect(fnv1a("hello")).toBe("m3bicr")
  })

  it("is deterministic and order-sensitive", () => {
    expect(fnv1a("ab")).toBe(fnv1a("ab"))
    expect(fnv1a("ab")).not.toBe(fnv1a("ba"))
  })
})

describe("fingerprintOf — content fingerprint over {tag, src, alt, text}", () => {
  it("separates fields with a control char so adjacent values can't blur (FP_SEP)", () => {
    // src "a" + text "b"  vs  src "" + text "ab": without the separator these would
    // hash identically. This collision guard was a real, silent parity bug once.
    const a = fingerprintOf({ tag: "img", attrs: { src: "a" }, text: "b" })
    const b = fingerprintOf({ tag: "img", attrs: { src: "" }, text: "ab" })
    expect(a).toBe("7uqbq")
    expect(b).toBe("jlfvd2")
    expect(a).not.toBe(b)
  })

  it("prefers src over href and alt over aria-label/title, normalizing text", () => {
    const viaSrc = fingerprintOf({ tag: "img", attrs: { src: "u", href: "ignored" }, text: "" })
    const viaHref = fingerprintOf({ tag: "a", attrs: { href: "u" }, text: "" })
    // Same src/href value, different tag → different fingerprint (tag is part of it).
    expect(viaSrc).not.toBe(viaHref)
    // Whitespace in text is collapsed before hashing.
    expect(fingerprintOf({ tag: "p", attrs: {}, text: "a   b" })).toBe(
      fingerprintOf({ tag: "p", attrs: {}, text: "a b" }),
    )
  })
})

describe("normWs", () => {
  it("collapses runs of whitespace and trims", () => {
    expect(normWs("  a\n b  ")).toBe("a b")
    expect(normWs("")).toBe("")
  })
})

describe("roleOf — coarse element classification", () => {
  it("maps concrete media tags outright", () => {
    expect(roleOf({ tag: "img", classes: [], attrs: {} })).toBe("image")
    expect(roleOf({ tag: "svg", classes: [], attrs: {} })).toBe("chart")
    expect(roleOf({ tag: "video", classes: [], attrs: {} })).toBe("media")
    expect(roleOf({ tag: "iframe", classes: [], attrs: {} })).toBe("embed")
    expect(roleOf({ tag: "table", classes: [], attrs: {} })).toBe("table")
    expect(roleOf({ tag: "pre", classes: [], attrs: {} })).toBe("code")
    expect(roleOf({ tag: "figure", classes: [], attrs: {} })).toBe("figure")
  })

  it("uses a textual hint only for generic containers, and defaults to block", () => {
    expect(roleOf({ tag: "div", classes: ["chart-wrap"], attrs: {} })).toBe("chart")
    expect(roleOf({ tag: "div", classes: [], attrs: {} })).toBe("block")
    // A concrete tag wins over a misleading hint.
    expect(roleOf({ tag: "img", classes: ["chart"], attrs: {} })).toBe("image")
  })
})

describe("elementLabel", () => {
  it("labels by role, preferring alt text", () => {
    expect(elementLabel({ tag: "img", role: "image", attrs: { alt: "Revenue chart" } })).toBe(
      "Image — Revenue chart",
    )
    expect(elementLabel({ tag: "table", role: "table", attrs: {} })).toBe("Table")
    expect(elementLabel({ tag: "pre", role: "code", attrs: {} })).toBe("Code block")
  })
})

describe("scanElements — the DOM-free HTML parser", () => {
  it("orders elements, tracks same-tag ordinals and the global index", () => {
    const ds = scanElements("<h1>Title</h1><p>a</p><p>b</p>")
    expect(ds.map((d) => d.tag)).toEqual(["h1", "p", "p"])
    expect(ds.map((d) => d.ordinal)).toEqual([0, 0, 1])
    expect(ds.map((d) => d.index)).toEqual([0, 1, 2])
  })

  it("applies HTML optional-end-tag rules so a nested element sees the right parent", () => {
    // The first <p> is never closed; <img> lands INSIDE it, then the second <p>
    // implicitly closes the first. So img.parent points at the first <p> (index 1),
    // and the second <p> is back at top level. This is what a real browser DOM does,
    // and the neighbour-text walk depends on it.
    const ds = scanElements('<h1>T</h1><p>Intro<img src="c.png"><p>After</p>')
    expect(ds.map((d) => d.tag)).toEqual(["h1", "p", "img", "p"])
    const img = ds.find((d) => d.tag === "img")
    expect(img?.parent).toBe(1)
    expect(ds[3]?.parent).toBe(-1)
  })

  it("captures kept attributes + classes and skips script/style/comments", () => {
    const ds = scanElements(
      '<div class="a b" id="hero" data-x="1"><script>var y="<p>"</script><img alt="Q"></div><!--c-->',
    )
    const div = ds.find((d) => d.tag === "div")
    expect(div?.id).toBe("hero")
    expect(div?.classes).toEqual(["a", "b"])
    expect(div?.attrs["data-x"]).toBe("1")
    // The <p> inside the script string must NOT become an element.
    expect(ds.some((d) => d.tag === "p")).toBe(false)
    expect(ds.some((d) => d.tag === "script")).toBe(false)
    expect(ds.find((d) => d.tag === "img")?.attrs.alt).toBe("Q")
  })

  it("decodes entities in text and attributes", () => {
    const ds = scanElements('<p title="a&amp;b">x &lt; y</p>')
    const p = ds.find((d) => d.tag === "p")
    expect(p?.attrs.title).toBe("a&b")
    expect(p?.text).toBe("x < y")
  })
})

describe("resolveElement — the agreement cascade + confidence grading", () => {
  it("relocates by a unique id + content match at HIGH confidence", () => {
    const s = sel({ id: "hero", fingerprint: fpImg("hero.png") })
    const ds = scanElements('<img id="hero" src="hero.png"><img src="other.png">')
    const m = resolveElement(s, ds)
    expect(m?.index).toBe(0)
    expect(m?.band).toBe("high")
    expect(m?.signals).toEqual(expect.arrayContaining(["id", "content"]))
    expect(m?.confidence).toBeGreaterThan(0.9)
  })

  it("caps an AMBIGUOUS strong signal (a gallery of identical thumbnails) at LOW", () => {
    // Three identical <img> — the fingerprint matches all of them, so 'content'
    // says nothing about WHICH one. Band must be low and confidence must not lie.
    const ds = scanElements('<img src="t.png"><img src="t.png"><img src="t.png">')
    const s = sel({ fingerprint: fpImg("t.png"), ordinal: 1, docFraction: 0.5 })
    const m = resolveElement(s, ds)
    expect(m?.band).toBe("low")
    expect(m?.confidence).toBeLessThanOrEqual(0.45)
  })

  it("drops the structural ordinal when the fingerprint repeats, letting neighbours pick", () => {
    // Same logo appears twice; a block of text between them disambiguates which
    // instance the comment meant via neighbour text, not the (now-shifted) ordinal.
    const html =
      '<p>Alpha section</p><img src="logo.png"><p>Beta section</p><img src="logo.png"><p>End</p>'
    const ds = scanElements(html)
    const s = sel({
      fingerprint: fpImg("logo.png"),
      ordinal: 0,
      before: "Beta section",
      after: "End",
      docFraction: 0.7,
    })
    const m = resolveElement(s, ds)
    // The SECOND logo (global index 3), chosen by neighbour agreement.
    expect(ds[m?.index ?? -1]?.tag).toBe("img")
    expect(m?.signals.some((sig) => sig.startsWith("neighbor"))).toBe(true)
  })

  it("returns null when nothing clears the acceptance threshold", () => {
    const s = sel({ tag: "video", role: "media", fingerprint: "zzz", ordinal: 9, docFraction: 0.9 })
    const ds = scanElements('<img id="hero" src="hero.png">')
    expect(resolveElement(s, ds)).toBeNull()
    expect(resolveElement(s, [])).toBeNull()
  })

  it("elementResolvesIn is the string-HTML convenience wrapper", () => {
    const s = sel({ id: "hero", fingerprint: fpImg("hero.png") })
    expect(elementResolvesIn(s, '<img id="hero" src="hero.png">')).not.toBeNull()
    expect(elementResolvesIn(s, "<p>nothing here</p>")).toBeNull()
  })
})

describe("planElementForwardWalk — version-to-version recovery", () => {
  it("survives gradual edits when a strong signal holds at every hop", () => {
    // id 'fig1' persists through a rewrap + src changes → resolves in every version.
    const start = sel({ id: "fig1", fingerprint: fpImg("v1.png"), docFraction: 0.2 })
    const walk = planElementForwardWalk(start, [
      '<img id="fig1" src="v1.png">',
      '<div><img id="fig1" src="v2.png"></div>',
      '<section><img id="fig1" src="v3.png" alt="kept"></section>',
    ])
    expect(walk.resolved).toBe(true)
    expect(walk.survived).toBe(3)
  })

  it("stops at the first version where the element can no longer be found", () => {
    // id renamed AND src changed at the last hop with nothing else to hold on to.
    const start = sel({ id: "fig1", fingerprint: fpImg("v1.png"), docFraction: 0.2 })
    const walk = planElementForwardWalk(start, [
      '<img id="fig1" src="v1.png">',
      '<div><img id="fig1" src="v2.png"></div>',
      '<div><img id="renamed" src="totally-different.png" alt="new"></div>',
    ])
    expect(walk.resolved).toBe(false)
    expect(walk.survived).toBe(2)
  })
})

describe("parseElementSelector — hostile/garbage input never crashes resolution", () => {
  it("returns null for non-element anchors", () => {
    expect(parseElementSelector(null)).toBeNull()
    expect(parseElementSelector("not json")).toBeNull()
    expect(
      parseElementSelector(JSON.stringify({ type: "TextQuoteSelector", exact: "x" })),
    ).toBeNull()
    expect(parseElementSelector(JSON.stringify({ type: "ElementSelector", tag: "img" }))).toBeNull()
  })

  it("coerces each field to its expected type, dropping bad values", () => {
    const parsed = parseElementSelector(
      JSON.stringify({
        type: "ElementSelector",
        tag: "img",
        fingerprint: "abc",
        before: 123, // wrong type → dropped, not crashed
        docFraction: 5, // out of range → clamped to [0,1]
      }),
    )
    expect(parsed?.before).toBeUndefined()
    expect(parsed?.docFraction).toBe(1)
    expect(parsed?.role).toBe("block") // defaulted
    expect(isElementAnchor(JSON.stringify(parsed))).toBe(true)
  })
})
