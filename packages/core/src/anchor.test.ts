import { describe, expect, it } from "vitest"
import {
  type AnchorThread,
  anchorContentFor,
  isAnchored,
  pageText,
  planAnchorSweep,
  type QuoteSelector,
  quoteSelector,
  reanchor,
} from "./anchor"

const json = (s: QuoteSelector) => JSON.stringify(s)

describe("quoteSelector", () => {
  it("captures the exact span plus up to 24 chars of context on each side", () => {
    const text = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP"
    const start = 30
    const sel = quoteSelector(text, start, 3)
    expect(sel.exact).toBe(text.slice(30, 33))
    expect(sel.prefix).toBe(text.slice(6, 30)) // exactly 24 chars
    expect(sel.prefix).toHaveLength(24)
    expect(sel.suffix).toBe(text.slice(33, 57)) // clamped to end of string
  })

  it("clamps the prefix at the start of the text", () => {
    const sel = quoteSelector("hello world", 0, 5)
    expect(sel.exact).toBe("hello")
    expect(sel.prefix).toBe("")
    expect(sel.suffix).toBe(" world")
  })

  it("round-trips: a freshly built selector reanchors at its own position", () => {
    const text = "the quick brown fox jumps over the lazy dog"
    const at = text.indexOf("brown")
    const r = reanchor(quoteSelector(text, at, 5), text)
    expect(r).toEqual({ found: true, index: at })
  })
})

describe("reanchor — deterministic resolution order", () => {
  it("returns the index of the exact span itself, not the context", () => {
    const text = "alpha beta gamma"
    const sel = quoteSelector(text, text.indexOf("beta"), 4)
    const r = reanchor(sel, text)
    expect(r.found).toBe(true)
    expect(text.slice(r.index, r.index + sel.exact.length)).toBe("beta")
  })

  it("prefers the context match, disambiguating a phrase that repeats", () => {
    // "cat" appears twice; the selector's context belongs to the SECOND one.
    const text = "the cat sat. the cat ran."
    const second = text.lastIndexOf("cat")
    const sel = quoteSelector(text, second, 3)
    const r = reanchor(sel, text)
    // Exact-anywhere alone would return the FIRST cat (index 4); context wins.
    expect(r.index).toBe(second)
    expect(r.index).not.toBe(text.indexOf("cat"))
  })

  it("falls back to exact-anywhere when the surrounding context has changed", () => {
    const sel: QuoteSelector = {
      type: "TextQuoteSelector",
      exact: "needle",
      prefix: "this prefix is long gone ",
      suffix: " and so is this suffix",
    }
    const text = "a haystack with a needle hidden inside"
    const r = reanchor(sel, text)
    expect(r).toEqual({ found: true, index: text.indexOf("needle") })
  })

  it("reports not-found (orphaned) when the exact text is gone", () => {
    const sel = quoteSelector("keep this phrase around", 5, 4)
    expect(reanchor(sel, "a totally different document")).toEqual({ found: false, index: -1 })
  })

  it("treats an empty exact as unresolvable", () => {
    expect(reanchor({ type: "TextQuoteSelector", exact: "" }, "anything")).toEqual({
      found: false,
      index: -1,
    })
  })

  it("works with no context fields (exact-only selector)", () => {
    const r = reanchor({ type: "TextQuoteSelector", exact: "two" }, "one two three")
    expect(r).toEqual({ found: true, index: 4 })
  })
})

describe("reanchor — whitespace-flexible (multi-element quotes)", () => {
  // The bug this fixes: a quote spanning a heading + a paragraph is captured by the
  // browser Selection with a single "\n" between the blocks, but the DOM text (and the
  // tag-stripped page text) carry the SOURCE indentation ("\n    "). A strict indexOf
  // never matched → every multi-element comment orphaned as "text changed".
  it("matches across a differing whitespace gap (the multi-element case)", () => {
    const sel: QuoteSelector = {
      type: "TextQuoteSelector",
      exact: "Derive 👋\nA self-contained test", // single \n, as the Selection captured
    }
    const domText = "Hello, Derive 👋\n    A self-contained test artifact." // source indent
    const r = reanchor(sel, domText)
    expect(r.found).toBe(true)
    expect(domText.slice(r.index)).toMatch(/^Derive 👋/)
  })

  it("collapses any whitespace run — tabs, multiple spaces, newlines all match", () => {
    const sel = quoteSelector("alpha beta gamma", 0, 16) // "alpha beta gamma"
    expect(reanchor(sel, "alpha\t\tbeta\n  gamma").found).toBe(true)
  })

  it("still disambiguates a repeat by context even when the exact recurs in the prefix", () => {
    // "cat" is in both the prefix and the target; the capture-group match must land on
    // the SECOND cat, not the one inside the prefix.
    const text = "the cat sat. the cat ran."
    const sel = quoteSelector(text, text.lastIndexOf("cat"), 3)
    // Re-grep against the same text but with the whitespace flexed (tabs for spaces).
    const flexed = text.replace(/ /g, "\t")
    const r = reanchor(sel, flexed)
    expect(r.found).toBe(true)
    expect(flexed.slice(r.index, r.index + 3)).toBe("cat")
    expect(r.index).toBe(flexed.lastIndexOf("cat"))
  })
})

describe("pageText — visible text for HTML quote matching", () => {
  it("turns tags into whitespace so a quote spanning elements is contiguous", () => {
    const html = `<h1 id="h">Hello, Derive 👋</h1>\n    <p class="lede">A self-contained test</p>`
    const sel: QuoteSelector = {
      type: "TextQuoteSelector",
      exact: "Derive 👋\nA self-contained test",
    }
    // Against the raw HTML the tags break the match; against pageText it resolves.
    expect(reanchor(sel, html).found).toBe(false)
    expect(reanchor(sel, pageText(html)).found).toBe(true)
  })

  it("drops script/style/comment content and decodes entities", () => {
    const html = `<style>.x{color:red}</style><p>A &amp; B</p><script>var q="ignore me"</script><!--c-->`
    const t = pageText(html)
    expect(t).toContain("A & B")
    expect(t).not.toContain("color:red")
    expect(t).not.toContain("ignore me")
  })
})

describe("anchorContentFor — HTML strips, markdown/plain stays raw", () => {
  const sel: QuoteSelector = {
    type: "TextQuoteSelector",
    exact: "Derive 👋\nA self-contained test",
  }
  const html = `<h1>Hello, Derive 👋</h1>\n<p>A self-contained test artifact.</p>`

  it("resolves a multi-element quote for HTML (text is tag-stripped)", () => {
    expect(isAnchored(json(sel), anchorContentFor(html, "text/html"))).toBe(true)
    // A deck is HTML-like too.
    expect(isAnchored(json(sel), anchorContentFor(html, "text/x-derive-deck"))).toBe(true)
  })

  it("leaves markdown/plain source unstripped (its source is the visible text)", () => {
    const md = "# Title\n\nA self-contained test."
    expect(
      isAnchored(
        json(quoteSelector(md, md.indexOf("self"), 4)),
        anchorContentFor(md, "text/markdown"),
      ),
    ).toBe(true)
    // isAnchored also accepts a bare string (markdown callers pass it directly).
    expect(isAnchored(json(quoteSelector(md, md.indexOf("self"), 4)), md)).toBe(true)
  })
})

describe("isAnchored", () => {
  const text = "the report covers Q3 revenue"

  it("treats a whole-document (null) anchor as always anchored", () => {
    expect(isAnchored(null, text)).toBe(true)
  })

  it("is true when the quote still resolves, false when it is gone", () => {
    expect(isAnchored(json(quoteSelector(text, text.indexOf("Q3"), 2)), text)).toBe(true)
    expect(isAnchored(json(quoteSelector(text, text.indexOf("Q3"), 2)), "rewritten copy")).toBe(
      false,
    )
  })

  it("fails open (anchored=true) on malformed or non-quote anchors", () => {
    expect(isAnchored("not json at all", text)).toBe(true)
    expect(isAnchored(JSON.stringify({ type: "RangeSelector" }), text)).toBe(true)
    expect(isAnchored(JSON.stringify({ type: "TextQuoteSelector", exact: "" }), text)).toBe(true)
  })
})

describe("planAnchorSweep — the open <-> outdated state machine", () => {
  const v1 = "intro about alpha, then a section on beta, ending on gamma"
  const anchorTo = (word: string) => json(quoteSelector(v1, v1.indexOf(word), word.length))

  it("flips an open thread to outdated when its quoted text disappears", () => {
    const threads: AnchorThread[] = [{ thread_id: "t1", anchor: anchorTo("beta"), state: "open" }]
    const v2 = "intro about alpha, then a section on BETA-RENAMED, ending on gamma"
    expect(planAnchorSweep(threads, v2)).toEqual([{ thread_id: "t1", state: "outdated" }])
  })

  it("reopens an outdated thread when its text comes back", () => {
    const threads: AnchorThread[] = [
      { thread_id: "t1", anchor: anchorTo("beta"), state: "outdated" },
    ]
    expect(planAnchorSweep(threads, v1)).toEqual([{ thread_id: "t1", state: "open" }])
  })

  it("leaves a still-resolving open thread and a still-missing outdated thread untouched", () => {
    const threads: AnchorThread[] = [
      { thread_id: "stable", anchor: anchorTo("alpha"), state: "open" },
      { thread_id: "stillgone", anchor: anchorTo("beta"), state: "outdated" },
    ]
    const v2 = "intro about alpha, then a section on (removed), ending on gamma"
    expect(planAnchorSweep(threads, v2)).toEqual([])
  })

  it("never touches resolved threads or whole-document (un-anchored) threads", () => {
    const threads: AnchorThread[] = [
      { thread_id: "resolved", anchor: anchorTo("beta"), state: "resolved" },
      { thread_id: "wholedoc", anchor: null, state: "open" },
    ]
    // "beta" is gone and the whole-doc thread is open, yet neither flips.
    expect(planAnchorSweep(threads, "nothing matches here")).toEqual([])
  })

  it("returns one transition per affected thread, only for the threads that changed", () => {
    const threads: AnchorThread[] = [
      { thread_id: "gone", anchor: anchorTo("beta"), state: "open" }, // -> outdated
      { thread_id: "back", anchor: anchorTo("gamma"), state: "outdated" }, // -> open
      { thread_id: "fine", anchor: anchorTo("alpha"), state: "open" }, // unchanged
    ]
    const v2 = "intro about alpha, then a section on (gone), ending on gamma"
    expect(planAnchorSweep(threads, v2)).toEqual([
      { thread_id: "gone", state: "outdated" },
      { thread_id: "back", state: "open" },
    ])
  })
})
