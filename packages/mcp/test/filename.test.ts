import { describe, expect, it } from "vitest"
import { fallbackFilename } from "../src/filename"

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
    // A <div> opener is exactly how HTML-flavored Markdown (a centered README)
    // starts, so it stays .md — the caller passes filename:"x.html" to keep it HTML.
    expect(fallbackFilename('<div class="card">hi</div>')).toBe("index.md")
    expect(fallbackFilename("<!-- prettier-ignore -->\n# Heading\n\nprose")).toBe("index.md")
  })

  it("a headless designed page (meta/style/head openers) lands as .html", () => {
    expect(fallbackFilename('<meta name="viewport" content="width=device-width" />')).toBe(
      "index.html",
    )
    expect(fallbackFilename("<style>body{color:red}</style><p>x</p>")).toBe("index.html")
    expect(fallbackFilename("<!-- generated -->\n<meta charset=utf-8><style>a{}</style>")).toBe(
      "index.html",
    )
  })
})

describe("fallbackFilename — a LaTeX document lands as .tex", () => {
  it("recognises \\documentclass and \\begin{document} at a line start only", () => {
    expect(fallbackFilename("\\documentclass[sigconf]{acmart}\n\\begin{document}\n")).toBe(
      "index.tex",
    )
    expect(fallbackFilename("  \\begin{document}\nHi\n\\end{document}")).toBe("index.tex")
    expect(fallbackFilename("Write `\\documentclass{article}` to start a paper.")).toBe("index.md")
  })
})
