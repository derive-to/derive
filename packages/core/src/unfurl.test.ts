import { describe, expect, it } from "vitest"
import { parseRef } from "./ids"
import {
  embedIframe,
  injectHead,
  kindLabel,
  oembedResponse,
  ogCardSvg,
  ogProfileCardSvg,
  profileMetaTags,
  profileSummary,
  type UnfurlInfo,
  unfurlDescription,
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
    expect(kindLabel("text/x-derive-deck", false)).toBe("Deck")
    expect(kindLabel("text/x-derive-linked-bundle", false)).toBe("Bundle")
    expect(kindLabel("text/html; charset=utf-8", false)).toBe("HTML")
    expect(kindLabel("text/html", true)).toBe("Site")
    expect(kindLabel("derive/skill", true)).toBe("Skill") // a skill bundle reads as "Skill"
    expect(kindLabel(null, false)).toBe("Document")
  })
})

describe("unfurlDescription", () => {
  it("pluralizes versions and comments", () => {
    expect(unfurlDescription({ kindLabel: "HTML", versionCount: 1, commentCount: 0 })).toBe(
      "HTML · 1 version · 0 comments · on Derive",
    )
  })
})

describe("unfurlMetaTags", () => {
  it("emits escaped OG + Twitter + oembed-discovery tags", () => {
    const html = unfurlMetaTags(info)
    expect(html).toContain('property="og:title" content="My &lt;Report&gt; &amp; Notes"')
    expect(html).toContain('property="og:image" content="http://derive.test/v1/og/abc12345"')
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
  it("wraps and ellipsizes a very long title", () => {
    const long = "word ".repeat(60)
    const svg = ogCardSvg({ title: long, kindLabel: "HTML", versionCount: 1, commentCount: 0 })
    expect(svg).toContain("…")
    expect((svg.match(/<tspan/g) ?? []).length).toBeLessThanOrEqual(3)
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

describe("profileSummary", () => {
  it("includes the role when set and pluralizes works/followers", () => {
    expect(
      profileSummary({
        username: "maya",
        name: "Maya",
        profession: "Engineering",
        works: 4,
        followers: 1,
      }),
    ).toBe("Engineering · 4 works · 1 follower · on Derive")
  })
  it("omits the role when unset and singularizes a count of one", () => {
    expect(
      profileSummary({ username: "ada", name: null, profession: null, works: 1, followers: 0 }),
    ).toBe("1 work · 0 followers · on Derive")
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
    expect(html).toContain('content="http://derive.test/v1/og/users/maya"')
    expect(html).not.toContain("Maya <Chen>") // no unescaped markup leaks
  })
  it("falls back to just the handle when the name is null", () => {
    const html = profileMetaTags({
      username: "ada",
      name: null,
      description: "on Derive",
      pageUrl: "http://derive.test/users/ada",
      imageUrl: "http://derive.test/v1/og/users/ada",
    })
    expect(html).toContain('content="@ada"')
  })
})

describe("ogProfileCardSvg", () => {
  it("renders the name, handle, summary, and first+last initials", () => {
    const svg = ogProfileCardSvg({
      username: "maya",
      name: "Maya Chen",
      profession: "Engineering",
      works: 12,
      followers: 48,
    })
    expect(svg).toContain("<svg")
    expect(svg).toContain("Maya Chen")
    expect(svg).toContain("@maya")
    expect(svg).toContain(">MC<") // first+last initial in the avatar disc
    expect(svg).toContain("12 works · 48 followers · on Derive")
  })
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
  it("uses the handle (and its initials) when the name is null", () => {
    const svg = ogProfileCardSvg({
      username: "ada",
      name: null,
      profession: null,
      works: 0,
      followers: 0,
    })
    expect(svg).toContain("@ada")
    expect(svg).toContain(">AD<") // initials derived from the username
  })
})
