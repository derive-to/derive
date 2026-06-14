import { describe, expect, it } from "vitest"
import { parseRef } from "./ids"
import {
  embedIframe,
  injectHead,
  kindLabel,
  oembedResponse,
  ogCardSvg,
  type UnfurlInfo,
  unfurlDescription,
  unfurlMetaTags,
} from "./unfurl"

const info: UnfurlInfo = {
  title: "My <Report> & Notes",
  kindLabel: "Markdown",
  versionCount: 3,
  commentCount: 1,
  pageUrl: "http://dock.test/a/my-report-abc12345",
  imageUrl: "http://dock.test/v1/og/abc12345",
  oembedUrl: "http://dock.test/v1/oembed?url=http%3A%2F%2Fdock.test%2Fa%2Fabc12345",
  embedUrl: "http://dock.test/v1/embed/abc12345",
}

describe("parseRef", () => {
  it("reads a bare short id, a name-first slug, a version suffix, and legacy order", () => {
    expect(parseRef("abc12345")).toEqual({ shortId: "abc12345", version: undefined })
    expect(parseRef("my-title-abc12345")).toEqual({ shortId: "abc12345", version: undefined })
    expect(parseRef("my-title-abc12345@v4")).toEqual({ shortId: "abc12345", version: 4 })
    // Legacy short-id-first links still resolve.
    expect(parseRef("abc12345-my-title")).toEqual({ shortId: "abc12345", version: undefined })
  })
})

describe("kindLabel", () => {
  it("labels by content type and bundle flag", () => {
    expect(kindLabel("text/markdown", false)).toBe("Markdown")
    expect(kindLabel("text/html; charset=utf-8", false)).toBe("HTML")
    expect(kindLabel("text/html", true)).toBe("Site")
    expect(kindLabel(null, false)).toBe("Document")
  })
})

describe("unfurlDescription", () => {
  it("pluralizes versions and comments", () => {
    expect(unfurlDescription({ kindLabel: "HTML", versionCount: 1, commentCount: 0 })).toBe(
      "HTML · 1 version · 0 comments · on Dock",
    )
  })
})

describe("unfurlMetaTags", () => {
  it("emits escaped OG + Twitter + oembed-discovery tags", () => {
    const html = unfurlMetaTags(info)
    expect(html).toContain('property="og:title" content="My &lt;Report&gt; &amp; Notes"')
    expect(html).toContain('property="og:image" content="http://dock.test/v1/og/abc12345"')
    expect(html).toContain('name="twitter:card" content="summary_large_image"')
    expect(html).toContain('type="application/json+oembed"')
    // No unescaped angle brackets from the title leak into the markup.
    expect(html).not.toContain("My <Report>")
  })
})

describe("injectHead", () => {
  it("inserts before </head> case-insensitively", () => {
    expect(injectHead("<head><title>x</title></HEAD><body>", "<meta>")).toBe(
      "<head><title>x</title><meta>\n</HEAD><body>",
    )
  })
  it("prepends when there is no head", () => {
    expect(injectHead("<body>x</body>", "<meta>")).toBe("<meta>\n<body>x</body>")
  })
})

describe("ogCardSvg", () => {
  it("renders a titled card and escapes the title", () => {
    const svg = ogCardSvg({
      title: "A & B <c>",
      kindLabel: "HTML",
      versionCount: 2,
      commentCount: 0,
    })
    expect(svg.startsWith("<svg")).toBe(true)
    expect(svg).toContain("1200")
    expect(svg).toContain("A &amp; B &lt;c&gt;")
    expect(svg).toContain("DOCK")
  })
  it("hides the title and shows a locked message when reveal is false", () => {
    const svg = ogCardSvg({
      title: "Secret",
      kindLabel: "HTML",
      versionCount: 1,
      commentCount: 0,
      reveal: false,
    })
    expect(svg).not.toContain("Secret")
    expect(svg).toContain("A private artifact")
  })
  it("wraps and ellipsizes a very long title", () => {
    const long = "word ".repeat(60)
    const svg = ogCardSvg({ title: long, kindLabel: "HTML", versionCount: 1, commentCount: 0 })
    expect(svg).toContain("…")
    expect((svg.match(/<tspan/g) ?? []).length).toBeLessThanOrEqual(3)
  })
})

describe("oembedResponse / embedIframe", () => {
  it("builds a rich oembed with a sandboxed iframe", () => {
    const r = oembedResponse(info, "http://dock.test")
    expect(r).toMatchObject({ version: "1.0", type: "rich", provider_name: "Dock" })
    expect(r.html).toContain("<iframe")
    expect(r.html).toContain(info.embedUrl)
  })
  it("escapes the iframe src and title", () => {
    expect(embedIframe('http://x/"onload="', { title: '"<x>' })).toContain("&quot;onload=&quot;")
  })
})
