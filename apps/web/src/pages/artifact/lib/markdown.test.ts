import { describe, expect, it } from "vitest"
import type { Mention } from "@/api"
import { mdToHtml } from "./markdown"

const m = (...names: string[]): Mention[] =>
  names.map((name, i) => ({ id: `u${i}`, name }) as Mention)

describe("mdToHtml — XSS safety (escape first, then transform)", () => {
  it("escapes raw HTML so it can never render as markup", () => {
    const out = mdToHtml("<script>alert(1)</script>")
    expect(out).toContain("&lt;script&gt;")
    expect(out).not.toContain("<script>")
  })

  it("escapes HTML even inside inline code", () => {
    expect(mdToHtml("`<img src=x onerror=alert(1)>`")).toBe(
      "<code>&lt;img src=x onerror=alert(1)&gt;</code>",
    )
  })

  it("escapes ampersands and quotes", () => {
    expect(mdToHtml('a & "b"')).toBe("a &amp; &quot;b&quot;")
  })

  it("only linkifies http(s) URLs — a javascript: link stays inert text", () => {
    const out = mdToHtml("[click](javascript:alert(1))")
    expect(out).not.toContain("<a")
    expect(out).not.toContain('href="javascript')
  })
})

describe("mdToHtml — inline markdown", () => {
  it("renders a markdown link with a safe target and rel", () => {
    expect(mdToHtml("[site](https://example.com/x)")).toBe(
      '<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">site</a>',
    )
  })
})

describe("mdToHtml — @mentions", () => {
  it("highlights only names from the known mention set", () => {
    expect(mdToHtml("hi @Alice", m("Alice"))).toBe('hi <span class="mention">@Alice</span>')
    // @Bob is not in the set, so it stays plain text.
    expect(mdToHtml("hi @Bob", m("Alice"))).toBe("hi @Bob")
  })

  it("treats mention names literally (regex metachars are escaped)", () => {
    // "a.b" must match literally, not as "a<any>b".
    expect(mdToHtml("@a.b", m("a.b"))).toBe('<span class="mention">@a.b</span>')
    expect(mdToHtml("@axb", m("a.b"))).toBe("@axb")
  })
})

describe("mdToHtml — root-relative links (agent citations)", () => {
  it("links a document cited by path", () => {
    expect(mdToHtml("see [Q3 Roadmap](/artifacts/ab12cd34)")).toBe(
      'see <a href="/artifacts/ab12cd34">Q3 Roadmap</a>',
    )
  })

  it("keeps them in the app: no target=_blank, unlike an external link", () => {
    expect(mdToHtml("[x](/artifacts/a1)")).not.toContain("target=")
    expect(mdToHtml("[x](https://example.com)")).toContain('target="_blank"')
  })

  it("refuses a protocol-relative URL — the classic bypass of a leading-slash check", () => {
    // `//evil.com` would be a link to ANOTHER ORIGIN that looks root-relative. The second
    // character must be alphanumeric, so it stays inert text.
    expect(mdToHtml("[x](//evil.com)")).toBe("[x](//evil.com)")
  })
})
