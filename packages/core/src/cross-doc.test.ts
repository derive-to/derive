import { describe, expect, it } from "vitest"
import { collectSiblingPaths, resolveSiblingPath, rewriteCrossDocLinks } from "./cross-doc"

const SRC = "docs/plans/competitor-tracking/product.html"

describe("resolveSiblingPath", () => {
  it("resolves a bare sibling filename against the source dir", () => {
    expect(resolveSiblingPath(SRC, "walkthrough.html")).toBe(
      "docs/plans/competitor-tracking/walkthrough.html",
    )
  })

  it("normalizes ./ and ../ segments", () => {
    expect(resolveSiblingPath(SRC, "./competitive.html")).toBe(
      "docs/plans/competitor-tracking/competitive.html",
    )
    expect(resolveSiblingPath(SRC, "../other/x.html")).toBe("docs/plans/other/x.html")
  })

  it("drops a query and hash, keying on the file path", () => {
    expect(resolveSiblingPath(SRC, "walkthrough.html#step-3")).toBe(
      "docs/plans/competitor-tracking/walkthrough.html",
    )
    expect(resolveSiblingPath(SRC, "walkthrough.html?v=2")).toBe(
      "docs/plans/competitor-tracking/walkthrough.html",
    )
  })

  it("treats a root-absolute path as repo-root relative", () => {
    expect(resolveSiblingPath(SRC, "/readme.md")).toBe("readme.md")
  })

  it("ignores in-page anchors, absolute, scheme and protocol-relative URLs", () => {
    expect(resolveSiblingPath(SRC, "#section")).toBeNull()
    expect(resolveSiblingPath(SRC, "https://example.com/x.html")).toBeNull()
    expect(resolveSiblingPath(SRC, "//cdn.example.com/x")).toBeNull()
    expect(resolveSiblingPath(SRC, "mailto:a@b.com")).toBeNull()
    expect(resolveSiblingPath(SRC, "tel:+1555")).toBeNull()
    expect(resolveSiblingPath(SRC, "")).toBeNull()
  })
})

describe("collectSiblingPaths", () => {
  it("collects distinct sibling paths from anchor hrefs only", () => {
    const html = `
      <a href="product.html">Product</a>
      <a href="walkthrough.html">Walkthrough</a>
      <a href="walkthrough.html">again</a>
      <a href="https://fonts.googleapis.com">font</a>
      <link href="theme.css" rel="stylesheet">`
    expect(collectSiblingPaths(html, SRC)).toEqual([
      "docs/plans/competitor-tracking/product.html",
      "docs/plans/competitor-tracking/walkthrough.html",
    ])
  })

  it("returns nothing when there are no relative anchors", () => {
    expect(collectSiblingPaths(`<a href="https://x.com">x</a>`, SRC)).toEqual([])
  })
})

describe("rewriteCrossDocLinks", () => {
  const refByPath = new Map([
    ["docs/plans/competitor-tracking/walkthrough.html", "competitor-tracking-walkthrough-kbthvh7s"],
    ["docs/plans/competitor-tracking/competitive.html", "competitor-tracking-competitive-aaaaaa11"],
  ])

  it("rewrites resolved siblings to /a/<ref> and tags them for interception", () => {
    const out = rewriteCrossDocLinks(`<a href="walkthrough.html">Walkthrough</a>`, SRC, refByPath)
    expect(out).toBe(
      `<a href="/a/competitor-tracking-walkthrough-kbthvh7s" data-derive-nav="competitor-tracking-walkthrough-kbthvh7s">Walkthrough</a>`,
    )
  })

  it("preserves other attributes around the href", () => {
    const out = rewriteCrossDocLinks(
      `<a class="tab" href="competitive.html" data-x="1">Competitive</a>`,
      SRC,
      refByPath,
    )
    expect(out).toContain(`href="/a/competitor-tracking-competitive-aaaaaa11"`)
    expect(out).toContain(`class="tab"`)
    expect(out).toContain(`data-x="1"`)
    expect(out).toContain(`data-derive-nav="competitor-tracking-competitive-aaaaaa11"`)
  })

  it("leaves links with no known sibling, anchors, and external links untouched", () => {
    const html = `<a href="unknown.html">u</a><a href="#x">x</a><a href="https://x.com">e</a>`
    expect(rewriteCrossDocLinks(html, SRC, refByPath)).toBe(html)
  })

  it("is idempotent — a second pass changes nothing", () => {
    const once = rewriteCrossDocLinks(`<a href="walkthrough.html">w</a>`, SRC, refByPath)
    expect(rewriteCrossDocLinks(once, SRC, refByPath)).toBe(once)
  })

  it("no-ops on an empty ref map", () => {
    const html = `<a href="walkthrough.html">w</a>`
    expect(rewriteCrossDocLinks(html, SRC, new Map())).toBe(html)
  })
})
