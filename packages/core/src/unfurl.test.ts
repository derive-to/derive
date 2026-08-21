import { describe, expect, it } from "vitest"
import {
  embedIframe,
  oembedResponse,
  ogCardSvg,
  ogProfileCardSvg,
  profileMetaTags,
  setRobotsMeta,
  setTitle,
  type UnfurlInfo,
  unfurlMetaTags,
} from "./unfurl"

const info: UnfurlInfo = {
  title: "My <Report> & Notes",
  kindLabel: "Markdown",
  versionCount: 3,
  commentCount: 1,
  pageUrl: "http://derive.test/artifacts/my-report-abc12345",
  imageUrl: "http://derive.test/v1/og/abc12345",
  oembedUrl: "http://derive.test/v1/oembed?url=http%3A%2F%2Fderive.test%2Fa%2Fabc12345",
  embedUrl: "http://derive.test/v1/embed/abc12345",
  markdownUrl: "http://derive.test/artifacts/my-report-abc12345.md",
}

describe("unfurlMetaTags", () => {
  it("emits escaped OG + Twitter + oembed-discovery tags", () => {
    const html = unfurlMetaTags(info)
    expect(html).toContain('property="og:title" content="My &lt;Report&gt; &amp; Notes"')
    expect(html).toContain('property="og:image" content="http://derive.test/v1/og/abc12345"')
    expect(html).toContain('name="twitter:card" content="summary_large_image"')
    expect(html).toContain(
      '<link rel="canonical" href="http://derive.test/artifacts/my-report-abc12345">',
    )
    expect(html).toContain('type="application/json+oembed"')
    expect(html).toContain(
      '<link rel="alternate" type="text/markdown" href="http://derive.test/artifacts/my-report-abc12345.md">',
    )
    // No unescaped angle brackets from the title leak into the markup.
    expect(html).not.toContain("My <Report>")
  })
})

describe("setTitle", () => {
  it("replaces the shell title with the page's own, escaped", () => {
    expect(setTitle("<head><title>Derive</title></head>", 'A "B" <c>')).toBe(
      "<head><title>A &quot;B&quot; &lt;c&gt;</title></head>",
    )
  })
})

describe("setRobotsMeta", () => {
  it("replaces a shell policy with one authoritative crawler directive", () => {
    const html = setRobotsMeta(
      '<head><meta name="robots" content="noindex,nofollow"><title>x</title></head>',
      "index,follow",
    )
    expect(html.match(/name="robots"/g)).toHaveLength(1)
    expect(html).toContain('content="index,follow"')
    expect(html).not.toContain("noindex")
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
    expect(svg).toContain("DERIVE")
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
})

describe("oembedResponse / embedIframe", () => {
  it("builds a rich oembed with a sandboxed iframe", () => {
    const r = oembedResponse(info, "http://derive.test")
    expect(r).toMatchObject({ version: "1.0", type: "rich", provider_name: "Derive" })
    expect(r.html).toContain("<iframe")
    expect(r.html).toContain(info.embedUrl)
  })
  it("escapes the iframe src and title", () => {
    expect(embedIframe('http://x/"onload="', { title: '"<x>' })).toContain("&quot;onload=&quot;")
  })
})

describe("profileMetaTags", () => {
  it("emits profile OG/Twitter tags with the name + handle, all escaped", () => {
    const html = profileMetaTags({
      username: "maya",
      name: "Maya <Chen>",
      description: "Engineering · 4 works · on Derive",
      pageUrl: "http://derive.test/users/maya",
      imageUrl: "http://derive.test/v1/og/users/maya",
    })
    expect(html).toContain('property="og:type" content="profile"')
    expect(html).toContain('property="profile:username" content="maya"')
    expect(html).toContain("Maya &lt;Chen&gt; (@maya)") // name + handle, angle brackets escaped
    expect(html).toContain('name="twitter:card" content="summary_large_image"')
    expect(html).toContain('<link rel="canonical" href="http://derive.test/users/maya">')
    expect(html).toContain('content="http://derive.test/v1/og/users/maya"')
    expect(html).not.toContain("Maya <Chen>") // no unescaped markup leaks
  })
})

describe("ogProfileCardSvg", () => {
  it("escapes the name in the card markup", () => {
    const svg = ogProfileCardSvg({
      username: "co",
      name: "Ada & Co",
      profession: null,
      works: 0,
      followers: 0,
    })
    expect(svg).toContain("Ada &amp; Co")
    expect(svg).not.toContain("Ada & Co") // raw ampersand never leaks into the SVG
  })
})
