import { describe, expect, it } from "vitest"
import {
  type ElementSelector,
  elementLabel,
  fingerprintOf,
  roleOf,
  scanElements,
} from "../src/element-anchor"
import { applyElementEdits, type ElementResizeEdit } from "../src/element-edit"

const selectorFor = (html: string, tag: string, ordinal = 0): ElementSelector => {
  const descriptors = scanElements(html)
  const d = descriptors.find((candidate) => candidate.tag === tag && candidate.ordinal === ordinal)
  if (!d) throw new Error(`No ${tag} at ordinal ${ordinal}`)
  const role = roleOf(d)
  return {
    type: "ElementSelector",
    tag,
    role,
    id: d.id,
    fingerprint: fingerprintOf(d),
    ordinal,
    docFraction: d.srcFraction,
    snapshot: { tag, label: elementLabel({ ...d, role }) },
  }
}

const resize = (
  html: string,
  tag: string,
  width: number,
  height: number | "auto",
  ordinal = 0,
): ElementResizeEdit => ({
  op: "resize",
  target: selectorFor(html, tag, ordinal),
  width,
  height,
})

describe("applyElementEdits — resize", () => {
  it("adds a size to one image without serializing the rest of the document", () => {
    const html = '<main>\n  <img id="hero" src="hero.png" alt="Hero">\n  <p>Keep me.</p>\n</main>'
    expect(applyElementEdits(html, [resize(html, "img", 480, "auto")])).toBe(
      '<main>\n  <img id="hero" src="hero.png" alt="Hero" style="width: 480px; height: auto">\n  <p>Keep me.</p>\n</main>',
    )
  })

  it("replaces width/height while preserving unrelated declarations and quote style", () => {
    const html =
      "<img src='chart.png' style='display: block; width: 50%; object-fit: cover; height: 90px'>"
    const out = applyElementEdits(html, [resize(html, "img", 320, "auto")])
    expect(out).toBe(
      "<img src='chart.png' style='display: block; object-fit: cover; width: 320px; height: auto'>",
    )
  })

  it("does not split semicolons inside CSS functions or strings", () => {
    const html = `<div id="box" style="background-image: url('data:image/svg+xml;utf8,x'); --note: 'a;b'; width: 10px; height: 10px"></div>`
    const out = applyElementEdits(html, [resize(html, "div", 240, 140)])
    expect(out).toContain("background-image: url('data:image/svg+xml;utf8,x')")
    expect(out).toContain("--note: 'a;b'")
    expect(out).toContain("width: 240px; height: 140px")
  })

  it("uses the same-tag ordinal to resize the intended repeated image", () => {
    const image = '<img src="same.png" alt="Logo">'
    const html = `<p>One</p>${image}<p>Two</p>${image}<p>Three</p>`
    const out = applyElementEdits(html, [resize(html, "img", 144, "auto", 1)])
    expect(out.match(/style=/g)).toHaveLength(1)
    expect(out.indexOf("style=")).toBeGreaterThan(out.indexOf("<p>Two</p>"))
  })

  it("refuses a selector that no longer identifies a source element", () => {
    const html = '<img id="hero" src="hero.png" alt="Hero">'
    const op = resize(html, "img", 480, "auto")
    expect(() => applyElementEdits('<img id="other" src="other.png" alt="Other">', [op])).toThrow(
      /couldn't be matched confidently/,
    )
  })
})
