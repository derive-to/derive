import { describe, expect, it } from "vitest"
import { decodeEntities, pageText, pageTextParts } from "../src/anchor"
import { EditError } from "../src/doc-text"
import { applyQuoteEdits, isQuoteEdit, type QuoteEdit } from "../src/quote-edit"

const qe = (
  exact: string,
  new_text: string,
  ctx: { prefix?: string; suffix?: string } = {},
): QuoteEdit => ({ quote: { exact, ...ctx }, new_text })

const MD = "text/markdown"
const HTML = "text/html"

// The ORIGINAL regex-based projection, kept here as an independent oracle for the
// linear scanner that replaced it (the lazy quantifiers backtracked polynomially —
// CodeQL js/polynomial-redos — so production runs the scanner only).
const legacyPageText = (html: string): string =>
  decodeEntities(
    html
      .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )

// ---------------------------------------------------------------------------------
// pageTextParts: the one projection, checked against the legacy regex oracle.

describe("pageTextParts", () => {
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
  it("matches the legacy regex projection on every fixture", () => {
    for (const html of FIXTURES) {
      expect(pageTextParts(html).text).toBe(legacyPageText(html))
    }
  })

  it("pageText IS the scanner's text (one implementation, no drift possible)", () => {
    for (const html of FIXTURES) {
      expect(pageText(html)).toBe(pageTextParts(html).text)
    }
  })

  it("stays linear on a document built to make lazy regexes backtrack", () => {
    // Thousands of unclosed "<!--" — the js/polynomial-redos shape.
    const hostile = `${"<!-- ".repeat(4000)}tail text`
    const start = performance.now()
    const mapped = pageTextParts(hostile)
    expect(performance.now() - start).toBeLessThan(200)
    expect(mapped.text).toBe(legacyPageText(hostile))
  })

  it("documents the one known divergence from the legacy regexes: a comment wrapping a script opener", () => {
    // Legacy ran the INVISIBLE pass over the whole string first, so a stray later
    // </script> could pair with a <script> mentioned INSIDE an unclosed comment.
    // The scanner resolves alternatives per position (comment first at "<!--"),
    // which is the saner reading; this fixture pins the scanner's semantics.
    const doc = "A<!-- <script> -->B</script>C"
    expect(pageTextParts(doc).text).toBe("A B C")
    // …and edits on such a document still work (no equality guard to trip).
    const out = applyQuoteEdits(doc.replace("C", "C typo end"), HTML, [
      qe("typo", "fixed", { prefix: "C ", suffix: " end" }),
    ])
    expect(out).toContain("fixed")
  })

  it("maps a plain text span to identical raw offsets when there is no markup", () => {
    const { text, segments } = pageTextParts("just words")
    expect(text).toBe("just words")
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ kind: "text", rStart: 0, rEnd: 10 })
  })

  it("gives entities their own segments covering the raw span", () => {
    const { text, segments } = pageTextParts("a &amp; b")
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

  it("refuses when even the CONTEXT repeats — identical cards must not edit the first one", () => {
    // Two byte-identical cards: context matches both. A lenient matcher would
    // silently edit the first card when the user touched the second.
    const cards =
      "Widget Alpha Learn more Buy now today MIDDLE Widget Alpha Learn more Buy now today"
    expect(() =>
      applyQuoteEdits(cards, MD, [
        qe("Learn more", "Discover", { prefix: "Widget Alpha ", suffix: " Buy now today" }),
      ]),
    ).toThrow(/identical contexts/)
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

  it("a context window carrying node-seam newlines (the client's separator) still matches", () => {
    // The frame joins its snapshot with "\n" at text-node seams; flexPattern turns
    // that into \s+, which must match the source's real whitespace.
    const md = "First line here.\nSecond line typo there."
    const out = applyQuoteEdits(md, MD, [
      qe("typo", "word", { prefix: "here.\nSecond line ", suffix: " there." }),
    ])
    expect(out).toContain("Second line word there.")
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
    expect(out).toBe("<p>&lt;img src=x onerror=&quot;pwn()&quot;&gt; &amp; here</p>")
  })

  it("a context crossing a NO-WHITESPACE tag boundary still pins the right spot", () => {
    // "high.Set" in the DOM concat vs "high. Set" in the projection — the client
    // sends seam whitespace ("\n"), and the flexible matcher spans the gap.
    const doc = "<p>The value is high.</p><p>Set the value now.</p>"
    const out = applyQuoteEdits(doc, HTML, [
      qe("value", "number", { prefix: "high.\nSet the ", suffix: " now." }),
    ])
    expect(out).toBe("<p>The value is high.</p><p>Set the number now.</p>")
  })

  it("replaces across balanced inline formatting", () => {
    const doc = "<p>first part <b>bold bit</b> tail</p>"
    expect(applyQuoteEdits(doc, HTML, [qe("part bold bit tail", "replacement")])).toBe(
      "<p>first replacement</p>",
    )
  })

  it("repairs formatting that is active at only one edge of the selection", () => {
    const startsInside = "<h1><span>Agentic Content</span> Analysis</h1>"
    expect(applyQuoteEdits(startsInside, HTML, [qe("Agentic Content Analysis", "New title")])).toBe(
      "<h1>New title</h1>",
    )

    const endsInside = "<p>before <b>bold after</b></p>"
    expect(applyQuoteEdits(endsInside, HTML, [qe("before bold", "changed")])).toBe(
      "<p>changed<b> after</b></p>",
    )
  })

  it("cleans nested and adjacent inline wrappers without touching outside formatting", () => {
    const nested = "<h1><span><strong>Agentic</strong> Content</span> Analysis</h1>"
    expect(applyQuoteEdits(nested, HTML, [qe("Agentic Content Analysis", "New title")])).toBe(
      "<h1>New title</h1>",
    )

    const partial = "<p><b>keep selected</b> plain tail</p>"
    expect(applyQuoteEdits(partial, HTML, [qe("selected plain", "changed")])).toBe(
      "<p><b>keep </b>changed tail</p>",
    )
  })

  it("preserves links and handles international text across formatting seams", () => {
    const whole = '<p><a href="/docs">مرحبا 🌍</a> world</p>'
    expect(applyQuoteEdits(whole, HTML, [qe("مرحبا 🌍 world", "hello world")])).toBe(
      "<p>hello world</p>",
    )

    const partial = '<p><a href="/docs">keep مرحبا</a> world</p>'
    expect(applyQuoteEdits(partial, HTML, [qe("مرحبا world", "hello")])).toBe(
      '<p><a href="/docs">keep </a>hello</p>',
    )
  })

  it("keeps mixed inline and plain-text batches atomic", () => {
    const doc = "<h1><span>Old title</span> here</h1><p>A typoo remains.</p>"
    const out = applyQuoteEdits(doc, HTML, [
      qe("Old title here", "New title"),
      qe("typoo", "typo", { prefix: "A ", suffix: " remains" }),
    ])
    expect(out).toBe("<h1>New title</h1><p>A typo remains.</p>")

    expect(() =>
      applyQuoteEdits(doc, HTML, [
        qe("typoo", "typo"),
        qe("title here A", "unsafe structural edit"),
      ]),
    ).toThrow(/element boundary/)
    expect(doc).toContain("typoo")
  })

  it("still rejects a span across structural elements", () => {
    const doc = "<p>first part</p><p>second part</p>"
    expect(() => applyQuoteEdits(doc, HTML, [qe("part second", "x")])).toThrow(
      /crosses an element boundary/,
    )
  })

  it("replaces a whole entity when the span covers it", () => {
    const doc = "<p>Tom &amp; Jerry</p>"
    const out = applyQuoteEdits(doc, HTML, [qe("Tom & Jerry", "Tom and Jerry")])
    expect(out).toBe("<p>Tom and Jerry</p>")
  })

  it("refuses to split a decoded surrogate-pair entity", () => {
    const doc = "<p>look &#x1F440; here</p>"
    const { text } = pageTextParts(doc)
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

  it("rejects malformed context fields (a numeric prefix must not become a 500)", () => {
    expect(isQuoteEdit({ quote: { exact: "a", prefix: 123 }, new_text: "x" })).toBe(false)
    expect(isQuoteEdit({ quote: { exact: "a", suffix: {} }, new_text: "x" })).toBe(false)
    expect(isQuoteEdit({ quote: { exact: "a", prefix: "ok" }, new_text: "x" })).toBe(true)
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

// `new_html`: the one path where a manual edit carries markup into the source (the
// editor's bold / italic / link). Every other guard still applies to it — these pin
// the allowlist, the scheme check, and the markdown refusal.
describe("applyQuoteEdits — new_html", () => {
  const htmlEdit = (
    exact: string,
    new_html: string,
    ctx: { prefix?: string; suffix?: string } = {},
  ) => ({
    quote: { exact, ...ctx },
    new_html,
  })

  it("splices allowlisted inline markup", () => {
    const out = applyQuoteEdits("<p>we shipped it late</p>", HTML, [
      htmlEdit("late", "<b>late</b>"),
    ])
    expect(out).toBe("<p>we shipped it <b>late</b></p>")
  })

  it("keeps a link, with its href", () => {
    const out = applyQuoteEdits("<p>read the report today</p>", HTML, [
      htmlEdit("the report", '<a href="https://example.com/r">the report</a>'),
    ])
    expect(out).toBe('<p>read <a href="https://example.com/r">the report</a> today</p>')
  })

  it("strips everything outside the allowlist", () => {
    const out = applyQuoteEdits("<p>plain words here</p>", HTML, [
      htmlEdit("words", '<div class="x" style="color:red"><b>words</b></div>'),
    ])
    expect(out).toBe("<p>plain <b>words</b> here</p>")
  })

  it("refuses a script, and the javascript: scheme on a link", () => {
    const script = applyQuoteEdits("<p>one two three</p>", HTML, [
      htmlEdit("two", "<b>two</b><script>alert(1)</script>"),
    ])
    expect(script).not.toContain("alert(1)")
    expect(script).not.toContain("<script")
    // Built from parts so the literal scheme never appears in source (the linter
    // reads it as a real javascript: URL; here it is the thing under test).
    const jsScheme = `java${"script"}:alert(1)`
    const js = applyQuoteEdits("<p>one two three</p>", HTML, [
      htmlEdit("two", `<a href="${jsScheme}">two</a>`),
    ])
    expect(js).not.toContain("javascript:")
    expect(js).toContain(">two</a>")
  })

  it("is refused on a markdown document — formatting there is markdown text", () => {
    expect(() =>
      applyQuoteEdits("we shipped it late", MD, [htmlEdit("late", "<b>late</b>")]),
    ).toThrow(/Markdown/)
  })

  it("allows formatted replacement across inline formatting", () => {
    expect(
      applyQuoteEdits("<p>part <b>bold</b> tail</p>", HTML, [htmlEdit("part bold", "<i>x</i>")]),
    ).toBe("<p><i>x</i> tail</p>")
  })

  it("isQuoteEdit takes exactly one replacement", () => {
    expect(isQuoteEdit({ quote: { exact: "a" }, new_text: "b" })).toBe(true)
    expect(isQuoteEdit({ quote: { exact: "a" }, new_html: "<b>b</b>" })).toBe(true)
    expect(isQuoteEdit({ quote: { exact: "a" }, new_text: "b", new_html: "<b>b</b>" })).toBe(false)
    expect(isQuoteEdit({ quote: { exact: "a" } })).toBe(false)
  })
})

// Enter inside a block: a line break, not a paragraph split. The editor sends it as
// markup like any other formatting; this pins that <br> is in the allowlist and that
// nothing structural sneaks in beside it.
describe("applyQuoteEdits — line breaks", () => {
  it("keeps a <br> from the editor", () => {
    const out = applyQuoteEdits("<p>one two</p>", HTML, [
      { quote: { exact: "one two" }, new_html: "one<br>two" },
    ])
    expect(out).toBe("<p>one<br>two</p>")
  })

  it("still drops block tags — a paragraph split is not an inline edit", () => {
    const out = applyQuoteEdits("<p>one two</p>", HTML, [
      { quote: { exact: "one two" }, new_html: "one</p><p>two" },
    ])
    expect(out).toBe("<p>onetwo</p>")
  })
})
