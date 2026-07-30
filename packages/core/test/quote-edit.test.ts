import { describe, expect, it } from "vitest"
import { pageText } from "../src/anchor"
import { EditError } from "../src/doc-text"
import { applyQuoteEdits, isQuoteEdit, pageTextWithMap, type QuoteEdit } from "../src/quote-edit"

const qe = (
  exact: string,
  new_text: string,
  ctx: { prefix?: string; suffix?: string } = {},
): QuoteEdit => ({ quote: { exact, ...ctx }, new_text })

const MD = "text/markdown"
const HTML = "text/html"

// ---------------------------------------------------------------------------------
// pageTextWithMap: the offset-tracking twin must produce pageText byte-for-byte.

describe("pageTextWithMap", () => {
  const FIXTURES = [
    "plain text with no markup at all",
    "<p>one</p><p>two</p>",
    '<div class="a"><span>in</span>line</div>',
    "before <script>var x = '<p>sneaky</p>'</script> after",
    "keep <style>p { color: red }</style> none",
    "a <!-- comment with <b>tags</b> inside --> b",
    "ent &amp; ities &lt;kept&gt; &hellip; &#65; &#x1F440; end",
    "unknown &nosuchentity; passes through",
    "<noscript><p>fallback</p></noscript>tail",
    '<img src="x.png" alt="alt text">caption',
    "<pre><code>const a = 1 &amp;&amp; 2</code></pre>",
    "nested <!-- <script>x</script> --> comment",
    "<td>cell</td><td>cell</td>",
    "", // empty document
    "<p>", // unclosed tag
    "text &amp", // entity without semicolon: plain text
    "a < b and c > d", // literal angle brackets in prose
    "empty <> brackets stay literal",
    "<!-- unclosed comment falls to the bare-tag rule > tail",
    "<!-- unclosed, and no closing angle at all",
    "<script>never closed but has > inside",
    "<SCRIPT src=x>UPPER</Script> case-insensitive close",
    "<scriptx>not a script tag</scriptx>",
    'att with gt <img alt="a>b"> tail', // attrs stop at the FIRST >
  ]
  it("matches pageText on every fixture", () => {
    for (const html of FIXTURES) {
      expect(pageTextWithMap(html).text).toBe(pageText(html))
    }
  })

  it("stays linear (and equal) on a document built to make lazy regexes backtrack", () => {
    // Thousands of unclosed "<!--" — the js/polynomial-redos shape. The scanner
    // must both agree with pageText and finish promptly.
    const hostile = `${"<!-- ".repeat(4000)}tail text`
    const start = performance.now()
    const mapped = pageTextWithMap(hostile)
    expect(performance.now() - start).toBeLessThan(200)
    expect(mapped.text).toBe(pageText(hostile))
  })

  it("maps a plain text span to identical raw offsets when there is no markup", () => {
    const { text, segments } = pageTextWithMap("just words")
    expect(text).toBe("just words")
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ kind: "text", rStart: 0, rEnd: 10 })
  })

  it("gives entities their own segments covering the raw span", () => {
    const { text, segments } = pageTextWithMap("a &amp; b")
    expect(text).toBe("a & b")
    const entity = segments.find((s) => s.kind === "entity")
    expect(entity).toMatchObject({ tStart: 2, tEnd: 3, rStart: 2, rEnd: 7 })
  })
})

// ---------------------------------------------------------------------------------
// Markdown: the source IS the match text.

describe("applyQuoteEdits — markdown", () => {
  const doc = "# Title\n\nThe quick brown fox jumps over the lazy dog. It was teh best of times.\n"

  it("replaces a typo located by context", () => {
    const out = applyQuoteEdits(doc, MD, [
      qe("teh", "the", { prefix: "It was ", suffix: " best of times" }),
    ])
    expect(out).toContain("It was the best of times")
    expect(out).not.toContain("teh")
  })

  it("accepts a context miss when the exact is globally unique", () => {
    const out = applyQuoteEdits(doc, MD, [
      qe("quick brown fox", "slow brown fox", { prefix: "STALE CONTEXT " }),
    ])
    expect(out).toContain("The slow brown fox jumps")
  })

  it("rejects an ambiguous quote instead of guessing", () => {
    const dup = "alpha beta gamma. alpha beta delta."
    expect(() => applyQuoteEdits(dup, MD, [qe("alpha beta", "ALPHA")])).toThrow(/appears 2 times/)
  })

  it("uses context to pin one of several identical quotes", () => {
    const dup = "alpha beta gamma. alpha beta delta."
    const out = applyQuoteEdits(dup, MD, [qe("alpha beta", "X", { suffix: " delta" })])
    expect(out).toBe("alpha beta gamma. X delta.")
  })

  it("rejects a quote that no longer exists", () => {
    expect(() => applyQuoteEdits(doc, MD, [qe("never was here", "x")])).toThrow(/wasn't found/)
  })

  it("rejects a rendered-text quote that crosses inline markdown syntax", () => {
    const md = "This is **bold** text."
    // The reader sees "is bold text" — the source has ** in the middle, so a strict
    // match must fail rather than mangle the emphasis markers.
    expect(() => applyQuoteEdits(md, MD, [qe("is bold text", "is bald text")])).toThrow(EditError)
  })

  it("applies several non-overlapping edits back-to-front", () => {
    const md = "one two three four"
    const out = applyQuoteEdits(md, MD, [
      qe("three", "3", { prefix: "two ", suffix: " four" }),
      qe("one", "1", { suffix: " two" }),
    ])
    expect(out).toBe("1 two 3 four")
  })

  it("rejects overlapping edits", () => {
    const md = "one two three"
    expect(() =>
      applyQuoteEdits(md, MD, [
        qe("one two", "a", { suffix: " three" }),
        qe("two three", "b", { prefix: "one " }),
      ]),
    ).toThrow(/overlaps/)
  })

  it("empty replacement deletes the span (exact is trimmed, boundary whitespace stays)", () => {
    const out = applyQuoteEdits("keep drop keep", MD, [
      qe(" drop", "", { prefix: "keep", suffix: " keep" }),
    ])
    // The matcher trims `exact`, so the deleted span is "drop" — the space around it
    // survives. Rendered output is unaffected (whitespace collapses in HTML/markdown).
    expect(out).toBe("keep  keep")
  })

  it("keeps the source verbatim outside the span", () => {
    const md = "| a | b |\n|---|---|\n| teh | x |\n"
    const out = applyQuoteEdits(md, MD, [qe("teh", "the", { prefix: "| ", suffix: " | x" })])
    expect(out).toBe("| a | b |\n|---|---|\n| the | x |\n")
  })
})

// ---------------------------------------------------------------------------------
// HTML: quote resolves in the projection, splice lands in raw source.

describe("applyQuoteEdits — html", () => {
  const html =
    "<!doctype html><html><head><style>p{margin:0}</style></head>" +
    "<body><h1>Report</h1><p>The quick brown fox jumps.</p>" +
    '<p class="x">It was teh best of times.</p></body></html>'

  it("replaces a typo inside one text node", () => {
    const out = applyQuoteEdits(html, HTML, [
      qe("teh", "the", { prefix: "It was ", suffix: " best of times" }),
    ])
    expect(out).toContain("It was the best of times.")
    // Markup untouched.
    expect(out).toContain('<p class="x">')
    expect(out).toContain("<style>p{margin:0}</style>")
  })

  it("never matches text inside script/style", () => {
    const doc = "<style>.teh{color:red}</style><p>say teh word</p>"
    const out = applyQuoteEdits(doc, HTML, [qe("teh", "the", { prefix: "say ", suffix: " word" })])
    expect(out).toContain("say the word")
    expect(out).toContain(".teh{color:red}") // style block untouched
  })

  it("escapes the replacement so typed text can't inject markup", () => {
    const out = applyQuoteEdits("<p>safe text here</p>", HTML, [
      qe("safe text", '<img src=x onerror="pwn()"> &', { suffix: " here" }),
    ])
    expect(out).toBe('<p>&lt;img src=x onerror="pwn()"&gt; &amp; here</p>')
  })

  it("rejects a span that crosses an element boundary", () => {
    const doc = "<p>first part <b>bold bit</b> tail</p>"
    // "part bold" spans the <b> open tag — a structural change, not a text edit.
    expect(() => applyQuoteEdits(doc, HTML, [qe("part bold", "x")])).toThrow(
      /crosses formatting or element boundaries/,
    )
  })

  it("replaces a whole entity when the span covers it", () => {
    const doc = "<p>Tom &amp; Jerry</p>"
    const out = applyQuoteEdits(doc, HTML, [qe("Tom & Jerry", "Tom and Jerry")])
    expect(out).toBe("<p>Tom and Jerry</p>")
  })

  it("refuses to split a decoded surrogate-pair entity", () => {
    const doc = "<p>look &#x1F440; here</p>"
    const { text } = pageTextWithMap(doc)
    const eye = text.indexOf("\u{1F440}")
    // A span that starts INSIDE the two UTF-16 units of the decoded entity.
    const exact = text.slice(eye + 1, eye + 2 + 5)
    expect(() => applyQuoteEdits(doc, HTML, [qe(exact, "x")])).toThrow(/split a character/)
  })

  it("edits text adjacent to an entity without touching it", () => {
    const doc = "<p>5 &gt; 4 usualy</p>"
    const out = applyQuoteEdits(doc, HTML, [qe("usualy", "usually", { prefix: "4 " })])
    expect(out).toBe("<p>5 &gt; 4 usually</p>")
  })

  it("treats a deck like html", () => {
    const out = applyQuoteEdits("<section>teh slide</section>", "text/x-derive-deck", [
      qe("teh slide", "the slide"),
    ])
    expect(out).toBe("<section>the slide</section>")
  })

  it("whitespace differences between quote and source still match within one node", () => {
    const doc = "<p>line one\n    line two</p>"
    // The browser-captured quote carries the DOM's own whitespace; matching is flexible.
    const out = applyQuoteEdits(doc, HTML, [qe("one line", "one LINE")])
    expect(out).toBe("<p>line one LINE two</p>")
  })
})

// ---------------------------------------------------------------------------------
// Shapes + batch semantics

describe("quote-edit shapes", () => {
  it("recognizes the quote shape and rejects others", () => {
    expect(isQuoteEdit(qe("a", "b"))).toBe(true)
    expect(isQuoteEdit({ old_str: "a", new_str: "b" })).toBe(false)
    expect(isQuoteEdit(null)).toBe(false)
    expect(isQuoteEdit({ quote: { exact: 1 }, new_text: "x" })).toBe(false)
  })

  it("an empty batch is a no-op", () => {
    expect(applyQuoteEdits("doc", MD, [])).toBe("doc")
  })

  it("an empty exact is rejected", () => {
    expect(() => applyQuoteEdits("doc", MD, [qe("  ", "x")])).toThrow(/empty/)
  })

  it("a failing edit rejects the whole batch atomically", () => {
    const md = "one two three"
    expect(() =>
      applyQuoteEdits(md, MD, [qe("one", "1", { suffix: " two" }), qe("missing", "x")]),
    ).toThrow(/wasn't found/)
  })
})
