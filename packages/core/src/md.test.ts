import { describe, expect, it } from "vitest"
import { escapeHtml, renderMarkdown } from "./md"

// The body content (between <main>…</main>) is the user-controlled markdown after
// sanitization — assert against this so the page's own (trusted) script tag and
// chrome don't muddy the checks.
const bodyOf = (html: string) => html.split("<main>")[1]?.split("</main>")[0] ?? ""

describe("renderMarkdown — renders ordinary markdown", () => {
  it("turns common markdown into the expected HTML", async () => {
    const body = bodyOf(
      await renderMarkdown("# Title\n\n**bold** and `code` and [x](https://a.com)", null),
    )
    expect(body).toContain("<h1")
    expect(body).toContain("Title</h1>")
    expect(body).toContain("<strong>bold</strong>")
    expect(body).toContain("<code>code</code>")
    expect(body).toContain('href="https://a.com"')
  })

  it("renders GFM tables", async () => {
    const body = bodyOf(await renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |", null))
    expect(body).toContain("<table")
    expect(body).toContain("<td>1</td>")
  })
})

describe("renderMarkdown — XSS sanitization (the security guard)", () => {
  it("escapes a raw <script> tag instead of emitting it", async () => {
    const html = await renderMarkdown("<script>alert(1)</script>", null)
    expect(bodyOf(html)).toContain("&lt;script&gt;")
    // No executable script wrapping the payload made it through.
    expect(html).not.toMatch(/<script>[^<]*alert\(1\)/i)
  })

  it("strips event-handler attributes from inline HTML", async () => {
    const body = bodyOf(await renderMarkdown('<img src="x.png" onerror="alert(2)">', null))
    expect(body).toContain("<img")
    expect(body).not.toMatch(/onerror\s*=/i)
    expect(body).not.toContain("alert(2)")
  })

  it("keeps the source on an ordinary markdown image", async () => {
    const body = bodyOf(await renderMarkdown("![pic](https://cdn.test/p.png)", null))
    expect(body).toMatch(/<img[^>]+src="https:\/\/cdn\.test\/p\.png"/)
  })

  it("neutralizes javascript: URLs in links", async () => {
    const html = await renderMarkdown('<a href="javascript:alert(3)">click</a>', null)
    expect(html).not.toMatch(/javascript:/i)
  })

  it("escapes a disallowed tag (iframe) rather than rendering it", async () => {
    const body = bodyOf(await renderMarkdown('<iframe src="evil"></iframe>', null))
    expect(body).not.toMatch(/<iframe/i)
    expect(body).toContain("&lt;iframe")
  })
})

describe("renderMarkdown — document shell", () => {
  it("wraps the body in a full HTML document with the anchor client", async () => {
    const html = await renderMarkdown("hello", "My Doc")
    expect(html.startsWith("<!doctype html>")).toBe(true)
    expect(html).toContain("<main>")
    expect(html).toContain("<title>My Doc</title>")
    expect(html).toContain("/raw/derive-client.js") // SELECTION_SCRIPT
  })

  it("defaults a null title to Document", async () => {
    expect(await renderMarkdown("hi", null)).toContain("<title>Document</title>")
  })

  it("escapes the title so it can't break out of <title> or inject script", async () => {
    const html = await renderMarkdown("body", "</title><script>alert(1)</script>")
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).not.toContain("</title><script>alert(1)")
  })
})

describe("escapeHtml", () => {
  it("escapes &, <, >, and double quotes", () => {
    expect(escapeHtml('&<>"')).toBe("&amp;&lt;&gt;&quot;")
  })

  it("escapes the ampersand first so entities are not double-escaped", () => {
    expect(escapeHtml("<")).toBe("&lt;")
    expect(escapeHtml("a & b")).toBe("a &amp; b")
  })

  it("leaves plain text and single quotes untouched", () => {
    expect(escapeHtml("hello world")).toBe("hello world")
    expect(escapeHtml("it's fine")).toBe("it's fine")
  })
})
