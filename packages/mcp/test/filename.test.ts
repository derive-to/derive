import { describe, expect, it } from "vitest"
import { fallbackFilename, looksLikeHtmlDocument } from "../src/filename"

describe("fallbackFilename — inline publish with no filename never re-types markdown", () => {
  it("markdown content lands as .md (the retype-incident fix)", () => {
    expect(fallbackFilename("# Title\n\nSome **markdown** with a <short_id> token.")).toBe(
      "index.md",
    )
    expect(fallbackFilename("- a list\n- of items")).toBe("index.md")
    expect(fallbackFilename("plain prose")).toBe("index.md")
    expect(fallbackFilename("")).toBe("index.md")
    expect(fallbackFilename(undefined)).toBe("index.md")
  })

  it("a full HTML document lands as .html", () => {
    expect(fallbackFilename("<!DOCTYPE html><html><body><h1>Hi</h1></body></html>")).toBe(
      "index.html",
    )
    expect(fallbackFilename("<!doctype html>\n<html>")).toBe("index.html")
    expect(fallbackFilename('  <html lang="en">…')).toBe("index.html")
  })

  it("an HTML fragment is NOT a document, so it defaults to .md (caveat: pass a filename)", () => {
    // A styled page whose source starts with <div>/<style> rather than a doctype isn't
    // detected as a document — the caller must pass filename:"x.html" to keep it HTML.
    expect(fallbackFilename('<div class="card">hi</div>')).toBe("index.md")
    expect(fallbackFilename("<style>body{color:red}</style><p>x</p>")).toBe("index.md")
  })

  it("looksLikeHtmlDocument only matches a leading doctype/html tag", () => {
    expect(looksLikeHtmlDocument("<!DOCTYPE html>")).toBe(true)
    expect(looksLikeHtmlDocument("<html>")).toBe(true)
    expect(looksLikeHtmlDocument("# md then <html> later")).toBe(false)
    expect(looksLikeHtmlDocument("<htmlish>")).toBe(false) // needs a tag boundary
  })
})
