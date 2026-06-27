import { describe, expect, it } from "vitest"
import { isAnchored, planAnchorSweep } from "../src/anchor"
import { parseElementSelector, resolveElement, scanElements } from "../src/element-anchor"

const HTML = `<body><p>intro</p><img id="x" src="/a.png" alt="A chart"><p>outro</p></body>`
const bad = [
  JSON.stringify({
    type: "ElementSelector",
    tag: "img",
    fingerprint: "abc",
    ordinal: -5,
    docFraction: NaN,
  }),
  JSON.stringify({
    type: "ElementSelector",
    tag: "img",
    fingerprint: "abc",
    ordinal: 1e9,
    docFraction: Infinity,
  }),
  JSON.stringify({
    type: "ElementSelector",
    tag: "img",
    fingerprint: "x".repeat(100000),
    ordinal: 0,
    docFraction: -3,
  }),
  JSON.stringify({
    type: "ElementSelector",
    tag: 123,
    fingerprint: "abc",
    ordinal: 0,
    docFraction: 0,
  }),
  JSON.stringify({
    type: "ElementSelector",
    tag: "img",
    fingerprint: null,
    ordinal: 0,
    docFraction: 0,
  }),
  JSON.stringify({
    type: "ElementSelector",
    tag: "img",
    fingerprint: "abc",
    ordinal: 0,
    docFraction: 0,
    before: { x: 1 },
  }),
  JSON.stringify({
    type: "ElementSelector",
    tag: "img",
    fingerprint: "abc",
    ordinal: 0,
    docFraction: 0,
    before: "y".repeat(500000),
  }),
  JSON.stringify({
    type: "ElementSelector",
    tag: "",
    fingerprint: "abc",
    ordinal: 0,
    docFraction: 0,
  }),
  JSON.stringify({ type: "ElementSelector", tag: "img", fingerprint: "abc" }),
  JSON.stringify({ type: "ElementSelector" }),
  JSON.stringify({ type: "TextQuoteSelector", exact: "intro" }),
  JSON.stringify({
    type: "ElementSelector",
    tag: "img",
    fingerprint: "abc",
    ordinal: 0,
    docFraction: 0,
    snapshot: null,
  }),
  "{malformed json",
  "null",
  "true",
  "123",
  "[]",
  '"just a string"',
  JSON.stringify({
    type: "ElementSelector",
    tag: "img",
    fingerprint: "abc",
    ordinal: 0,
    docFraction: 0,
    css: { nested: true },
  }),
]
const htmls = [
  HTML,
  "",
  "<html></html>",
  "<img>".repeat(1000),
  "not html",
  "<img src=",
  "<<<>>>",
  "&#xZZ; &amp",
  "<svg".repeat(500),
]

describe("server resolution survives hostile stored anchors", () => {
  it("isAnchored never throws + always returns boolean", () => {
    for (const a of bad)
      for (const h of htmls) {
        const r = isAnchored(a as string, h)
        expect(typeof r).toBe("boolean")
      }
  })
  it("planAnchorSweep never throws + returns an array", () => {
    for (const a of bad) {
      const t = planAnchorSweep([{ thread_id: "t1", anchor: a as string, state: "open" }], HTML)
      expect(Array.isArray(t)).toBe(true)
    }
  })
  it("resolveElement never throws on hostile selector x hostile html", () => {
    for (const a of bad) {
      const sel = parseElementSelector(a as string)
      if (!sel) continue
      for (const h of htmls) expect(() => resolveElement(sel, scanElements(h))).not.toThrow()
    }
  })
})
