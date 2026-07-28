import { describe, expect, it } from "vitest"
import { looksLikeHtmlDocument } from "./publish"

// looksLikeHtmlDocument is the trigger for serve-content's "never serve a blank
// page" self-heal: a blob mislabeled text/markdown whose bytes are really a full
// HTML document is served verbatim as HTML instead of run through the markdown
// renderer (which would strip <head>/<style>/scripts and show white). So the
// boundary that matters is full-document vs. not — false positives would serve a
// fragment as a document; false negatives bring the blank screen back.

describe("looksLikeHtmlDocument", () => {
  it("detects a full HTML document, case-insensitively", () => {
    expect(looksLikeHtmlDocument("<!doctype html><html></html>")).toBe(true)
    expect(looksLikeHtmlDocument('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">')).toBe(true)
    expect(looksLikeHtmlDocument("<html lang=en><body>hi</body></html>")).toBe(true)
    expect(looksLikeHtmlDocument("<HTML>")).toBe(true)
  })

  it("ignores a leading BOM and surrounding whitespace", () => {
    expect(looksLikeHtmlDocument("﻿<!doctype html>")).toBe(true)
    expect(looksLikeHtmlDocument("\n\n   <!doctype html>")).toBe(true)
    expect(looksLikeHtmlDocument("   <html>")).toBe(true)
  })

  it("is false for markdown and plain text", () => {
    expect(looksLikeHtmlDocument("# Heading\n\nsome **markdown**")).toBe(false)
    expect(looksLikeHtmlDocument("just text")).toBe(false)
    expect(looksLikeHtmlDocument("")).toBe(false)
  })

  it("detects a headless designed page by its head/meta/style openers", () => {
    // The 2026-07 dogfood miss: a styled report opening with <meta>/<style> (no
    // doctype) rendered its CSS as visible text through the markdown path.
    expect(looksLikeHtmlDocument('<meta name="viewport" content="width=device-width" />')).toBe(
      true,
    )
    expect(looksLikeHtmlDocument("<style>body{color:red}</style><p>x</p>")).toBe(true)
    expect(looksLikeHtmlDocument("<head><title>t</title></head>")).toBe(true)
    expect(looksLikeHtmlDocument("<body><h1>hi</h1></body>")).toBe(true)
  })

  it("skips leading HTML comments; the comment alone never decides", () => {
    expect(looksLikeHtmlDocument("<!-- generated --><!doctype html><html></html>")).toBe(true)
    expect(looksLikeHtmlDocument('<!-- a -->\n<!-- b -->\n<meta charset="utf-8" />')).toBe(true)
    // Markdown that merely opens with a comment stays markdown.
    expect(looksLikeHtmlDocument("<!-- prettier-ignore -->\n# Heading\n\nprose")).toBe(false)
    expect(looksLikeHtmlDocument("<!-- unterminated comment")).toBe(false)
  })

  it("is false for ambiguous fragments — how HTML-flavored Markdown opens", () => {
    // A centered README opens with <div align="center">; a snippet with <p>/<h1>.
    // Rendering those as markdown is correct.
    expect(looksLikeHtmlDocument('<div align="center">fragment</div>')).toBe(false)
    expect(looksLikeHtmlDocument("<p>a paragraph</p>")).toBe(false)
    expect(looksLikeHtmlDocument("<h1>title</h1>")).toBe(false)
    expect(looksLikeHtmlDocument('<?xml version="1.0"?><svg></svg>')).toBe(false)
  })
})
