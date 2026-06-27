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

  it("is false for an HTML fragment (not a whole document)", () => {
    // A snippet is not a document; rendering it as markdown is correct.
    expect(looksLikeHtmlDocument("<div>fragment</div>")).toBe(false)
    expect(looksLikeHtmlDocument("<p>a paragraph</p>")).toBe(false)
    expect(looksLikeHtmlDocument("<h1>title</h1>")).toBe(false)
  })

  it("only inspects the very start: a leading comment or XML prolog hides the doc", () => {
    // Documented limitation — detection keys on the first non-space token.
    expect(looksLikeHtmlDocument("<!-- note --><!doctype html><html></html>")).toBe(false)
    expect(looksLikeHtmlDocument('<?xml version="1.0"?><svg></svg>')).toBe(false)
  })
})
