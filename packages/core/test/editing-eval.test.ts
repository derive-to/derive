import { describe, expect, it } from "vitest"
import { decodeEntities, pageTextParts } from "../src/anchor"
import {
  applySlideOps,
  countSlideElements,
  isDeckDocument,
  isUnannouncedDeck,
  sliceSlides,
  speaksDeckProtocol,
} from "../src/decks"
import {
  type ElementSelector,
  elementLabel,
  fingerprintOf,
  roleOf,
  scanElements,
} from "../src/element-anchor"
import { applyElementEdits, type ElementResizeEdit } from "../src/element-edit"
import { attrValues, tags } from "../src/html-tags"
import { applyQuoteEdits, type QuoteEdit } from "../src/quote-edit"
import { applySceneEdits, sliceScenes } from "../src/videos"

const MD = "text/markdown"
const HTML = "text/html"
const DECK = "text/x-derive-deck"

const qe = (
  exact: string,
  newText: string,
  context: { prefix?: string; suffix?: string } = {},
): QuoteEdit => ({ quote: { exact, ...context }, new_text: newText })

const markup = (exact: string, newHtml: string): QuoteEdit => ({
  quote: { exact },
  new_html: newHtml,
})

const selectorFor = (html: string, tag: string, ordinal = 0): ElementSelector => {
  const descriptor = scanElements(html).find((d) => d.tag === tag && d.ordinal === ordinal)
  if (!descriptor) throw new Error(`missing ${tag}[${ordinal}]`)
  const role = roleOf(descriptor)
  return {
    type: "ElementSelector",
    tag,
    role,
    id: descriptor.id,
    fingerprint: fingerprintOf(descriptor),
    ordinal,
    docFraction: descriptor.srcFraction,
    snapshot: { tag, label: elementLabel({ ...descriptor, role }) },
  }
}

const resize = (
  html: string,
  tag: string,
  width: number,
  height: number | "auto",
  ordinal = 0,
): ElementResizeEdit => ({
  op: "resize",
  target: selectorFor(html, tag, ordinal),
  width,
  height,
})

const deck = (slides: string[], ids = true): string =>
  `<!doctype html><style>.keep{color:red}</style><!--keep--><main>${slides
    .map(
      (body, i) =>
        `<section class="slide"${ids ? ` data-derive-slide="${i + 10}"` : ""}>${body}</section>`,
    )
    .join("\n")}</main><script>window.source='derive-deck'</script>`

const video = (): string =>
  '<main data-derive-video><section data-derive-scene="opening" data-duration-ms="5000"><h1>Opening</h1></section>\n' +
  '<section data-derive-scene="proof" data-duration-ms="6000" data-transition="fade"><h2>Proof</h2></section>\n' +
  '<section data-derive-scene="close" data-duration-ms="4000"><h2>Close</h2></section></main>'

describe("editing eval — Markdown source preservation", () => {
  it("[MD-001] removes the Zero Prime continuation across two bold subtitle runs", () => {
    const source =
      "# Chief of Staff\n\n**San Francisco · Full-time · In person**  \n" +
      "**$150,000–$180,000 base + discretionary bonus + carry eligibility**\n\n## Role\n"
    expect(
      applyQuoteEdits(source, MD, [
        qe("person\n$150,000–$180,000 base + discretionary bonus + carry eligibility", "person"),
      ]),
    ).toBe("# Chief of Staff\n\n**San Francisco · Full-time · In person**\n\n## Role\n")
  })

  it("[MD-002] uses rendered formatted context to pin the intended accented word", () => {
    const source = "Matched résumé matters.\n\n## Apply\n\nSend a **résumé** or LinkedIn profile.\n"
    const out = applyQuoteEdits(source, MD, [
      qe("résumé", "resume", { prefix: "Apply\nSend a ", suffix: " or LinkedIn" }),
    ])
    expect(out).toBe(
      "Matched résumé matters.\n\n## Apply\n\nSend a **resume** or LinkedIn profile.\n",
    )
  })

  it("[MD-003] repairs nested strong/emphasis boundaries without shedding the tail", () => {
    expect(applyQuoteEdits("Lead **bold _and italic_** tail", MD, [qe("bold and", "clear")])).toBe(
      "Lead **clear _italic_** tail",
    )
  })

  it("[MD-004] preserves a link destination when the selection exits the link", () => {
    expect(
      applyQuoteEdits("[keep selected](https://derive.to?a=1&b=2) plain tail", MD, [
        qe("selected plain", "changed"),
      ]),
    ).toBe("[keep](https://derive.to?a=1&b=2) changed tail")
  })

  it("[MD-005] replaces whole escapes/entities and refuses a partial code span", () => {
    expect(applyQuoteEdits("Use \\* and &amp; safely", MD, [qe("*", "+"), qe("&", "and")])).toBe(
      "Use + and and safely",
    )
    expect(() => applyQuoteEdits("Use `code` now", MD, [qe("cod", "x")])).toThrow(/whole character/)
  })

  it("[MD-006] preserves Unicode outside an exact CJK replacement", () => {
    const source = "مرحبا 🌍 café — 中文错误 — 👩🏽‍💻 done"
    expect(applyQuoteEdits(source, MD, [qe("中文错误", "中文正确")])).toBe(
      "مرحبا 🌍 café — 中文正确 — 👩🏽‍💻 done",
    )
  })

  it("[MD-007] maps rendered GFM selections without normalizing their structural bytes", () => {
    const source =
      "> quoted **text**\n\n- raw **list**\n- [x] task **done**\n\n| col |\n| --- |\n| table **value** |\n"
    const out = applyQuoteEdits(source, MD, [
      qe("quoted\ntext", "quoted words"),
      qe("raw\nlist", "raw item"),
      qe("task\ndone", "task complete"),
      qe("table\nvalue", "table result"),
    ])
    expect(out).toBe(
      "> quoted words\n\n- raw item\n- [x] task complete\n\n| col |\n| --- |\n| table result |\n",
    )
  })

  it("[MD-008] refuses a rendered selection across paragraph structure", () => {
    expect(() =>
      applyQuoteEdits("First paragraph here.\n\nSecond paragraph there.", MD, [
        qe("paragraph here. Second paragraph", "merged"),
      ]),
    ).toThrow(/Markdown block boundary/)
  })

  it("[MD-009] edits raw-HTML text but refuses a selection crossing its seam", () => {
    expect(applyQuoteEdits("before <em>inside</em> after", MD, [qe("inside", "within")])).toBe(
      "before <em>within</em> after",
    )
    expect(() =>
      applyQuoteEdits("before <em>inside</em> after", MD, [qe("before inside", "merged")]),
    ).toThrow(/raw HTML/)
  })

  it("[MD-010] leaves the original source unchanged when the last batch edit fails", () => {
    const source = "one two three four"
    expect(() =>
      applyQuoteEdits(source, MD, [qe("one", "1"), qe("two", "2"), qe("missing", "x")]),
    ).toThrow(/wasn't found/)
    expect(source).toBe("one two three four")
  })

  it("[MD-011] refuses overlapping quote spans", () => {
    expect(() =>
      applyQuoteEdits("one two three", MD, [qe("one two", "a"), qe("two three", "b")]),
    ).toThrow(/overlaps/)
  })

  it("[MD-012] maps thousands of inline runs within a bounded runtime", () => {
    const source = `${"**same** _word_ [link](https://derive.to) ".repeat(2500)}unique tail`
    const start = performance.now()
    expect(applyQuoteEdits(source, MD, [qe("unique", "final")])).toContain("final tail")
    expect(performance.now() - start).toBeLessThan(1500)
  })

  it("[MD-013] refuses a selection crossing an image seam", () => {
    expect(() =>
      applyQuoteEdits("before ![critical alt](critical.png) after", MD, [
        qe("before after", "merged"),
      ]),
    ).toThrow(/structural Markdown boundary such as an image/)
  })

  it("[MD-014] keeps mixed emphasis delimiter families structurally valid", () => {
    const out = applyQuoteEdits("__first run__ **second run**", MD, [qe("run second", "bridge")])
    expect(out).toBe("__first__ bridge **run**")
  })

  it("[MD-015] treats MIME parameters as Markdown", () => {
    expect(
      applyQuoteEdits("This is **bold** text.", "text/markdown; charset=utf-8", [
        qe("is bold text", "is changed text"),
      ]),
    ).toBe("This is changed text.")
  })

  it("[MD-016] uses punctuation-adjacent context to pin repeated text", () => {
    const source = "First résumé. (résumé), chosen."
    expect(
      applyQuoteEdits(source, MD, [qe("résumé", "resume", { prefix: "(", suffix: "), chosen" })]),
    ).toBe("First résumé. (resume), chosen.")
  })

  it("[MD-017] maps nested list and blockquote-list text without dropping formatting", () => {
    expect(
      applyQuoteEdits("- outer\n  - inner **todo**\n", MD, [qe("inner todo", "inner done")]),
    ).toBe("- outer\n  - inner done\n")
    expect(applyQuoteEdits("- outer\n  - inner **todo**\n", MD, [qe("todo", "done")])).toBe(
      "- outer\n  - inner **done**\n",
    )
    expect(applyQuoteEdits("> - quoted **todo**\n", MD, [qe("quoted todo", "quoted done")])).toBe(
      "> - quoted done\n",
    )
  })

  it("[MD-018] edits inline-code content without removing its fence", () => {
    expect(applyQuoteEdits("Text `code` here", MD, [qe("code", "value")])).toBe("Text `value` here")
  })

  it("[MD-019] refuses edits inside a Unicode grapheme cluster", () => {
    for (const exact of ["👩", "\u200d", "🏽", "\u0301"])
      expect(() => applyQuoteEdits("👩🏽‍💻 café", MD, [qe(exact, "X")])).toThrow(
        /split a character/,
      )
  })

  it("[MD-020] treats inline formatting delimiters as zero-width text seams", () => {
    expect(applyQuoteEdits("(**bold**), tail", MD, [qe("(bold),", "X")])).toBe("X tail")
    expect(applyQuoteEdits("a**bold**b", MD, [qe("aboldb", "X")])).toBe("X")
  })

  it("[MD-021] maps fenced-code bodies nested under block structure", () => {
    expect(applyQuoteEdits("> ```ts\n> value\n> ```", MD, [qe("value", "changed")])).toBe(
      "> ```ts\n> changed\n> ```",
    )
    expect(applyQuoteEdits("- item\n  ```ts\n  value\n  ```", MD, [qe("value", "changed")])).toBe(
      "- item\n  ```ts\n  changed\n  ```",
    )
  })

  it("[MD-022] edits the full significant-whitespace payload of an inline code span", () => {
    expect(applyQuoteEdits("Text ``  a  ``", MD, [qe(" a ", "X")])).toBe("Text ``X``")
  })

  it("[MD-023] maps fenced code body text after an identical info string", () => {
    expect(applyQuoteEdits("```value\nvalue\n```", MD, [qe("value", "changed")])).toBe(
      "```value\nchanged\n```",
    )
  })

  it("[MD-024] maps rendered newlines inside prefixed fenced code", () => {
    expect(applyQuoteEdits("> ```ts\n> one\n> two\n> ```", MD, [qe("one\ntwo", "changed")])).toBe(
      "> ```ts\n> changed\n> ```",
    )
  })

  it("[MD-025] maps inline text through blockquote-list-blockquote nesting", () => {
    expect(applyQuoteEdits("> - outer\n>   > quoted **value**", MD, [qe("value", "changed")])).toBe(
      "> - outer\n>   > quoted **changed**",
    )
  })

  it("[MD-026] recursively maps arbitrary supported list and blockquote nesting", () => {
    for (const [source, expected] of [
      ["> - a\n>   - b\n>     text", "> - a\n>   - b\n>     changed"],
      ["- a\n  > - b\n    > **text**", "- a\n  > - b\n    > **changed**"],
      ["> - a\n>   > - b\n>     > text", "> - a\n>   > - b\n>     > changed"],
    ] as const)
      expect(applyQuoteEdits(source, MD, [qe("text", "changed")])).toBe(expected)
  })

  it("[MD-027] maps every list sibling inside a blockquote", () => {
    expect(applyQuoteEdits("> - a\n> - b\n>   target", MD, [qe("target", "changed")])).toBe(
      "> - a\n> - b\n>   changed",
    )
  })

  it("[MD-028] maps later fenced-code siblings inside a blockquote", () => {
    const source = "> ```ts\n> one\n> ```\n>\n> ```ts\n> two\n> ```"
    expect(applyQuoteEdits(source, MD, [qe("two", "changed")])).toBe(
      "> ```ts\n> one\n> ```\n>\n> ```ts\n> changed\n> ```",
    )
  })

  it("[MD-029] maps formatted leaves through four alternating container levels", () => {
    const source = "> - a\n>   > - b\n>     > - c\n>       **target**"
    expect(applyQuoteEdits(source, MD, [qe("target", "changed")])).toBe(
      "> - a\n>   > - b\n>     > - c\n>       **changed**",
    )
  })

  it("[MD-030] maps ten thousand prefixed list siblings within a bounded runtime", () => {
    const source = Array.from(
      { length: 10_000 },
      (_, i) => `> - item${i}\n>   ${i === 9_999 ? "target" : `body${i}`}`,
    ).join("\n")
    const start = performance.now()
    expect(applyQuoteEdits(source, MD, [qe("target", "changed")])).toMatch(/changed$/)
    expect(performance.now() - start).toBeLessThan(1500)
  })
})

describe("editing eval — HTML projection, topology, and injection", () => {
  it("[HTML-001] repairs nested wrappers at both selection edges", () => {
    const source = "<p>Lead <strong>bold <em>and italic</em></strong> tail</p>"
    expect(applyQuoteEdits(source, HTML, [qe("bold and", "clear")])).toBe(
      "<p>Lead <strong>clear<em> italic</em></strong> tail</p>",
    )
  })

  it("[HTML-002] refuses a selection across structural elements", () => {
    expect(() =>
      applyQuoteEdits("<section><p>first part</p><p>second part</p></section>", HTML, [
        qe("part second", "merged"),
      ]),
    ).toThrow(/element boundary/)
  })

  it("[HTML-003] decodes valid entities, replaces invalid scalar values, and keeps entities indivisible", () => {
    expect(decodeEntities("A &#65; &#x1F440; &#x110000; &#xD800;")).toBe("A A 👀 � �")
    expect(applyQuoteEdits("<p>A &#x110000; B</p>", HTML, [qe("�", "safe")])).toBe(
      "<p>A safe B</p>",
    )
    expect(() => applyQuoteEdits("<p>look &#x1F440; now</p>", HTML, [qe("\udc40", "x")])).toThrow(
      /split a character/,
    )
  })

  it("[HTML-004] never resolves text that only occurs in invisible or commented source", () => {
    const source =
      "<style>.secret{}</style><script>secretScript</script><noscript>secretNo</noscript><!--secretComment--><p>visible</p>"
    for (const hidden of ["secretScript", "secretNo", "secretComment"])
      expect(() => applyQuoteEdits(source, HTML, [qe(hidden, "x")])).toThrow(/wasn't found/)
    for (const malformed of ["<script>hidden forever", "<style>hidden forever", "<!-- hidden"])
      expect(() =>
        applyQuoteEdits(`<p>visible</p>${malformed}`, HTML, [qe("hidden", "x")]),
      ).toThrow(/wasn't found/)
  })

  it("[HTML-005] escapes typed text so it cannot become markup", () => {
    expect(
      applyQuoteEdits("<p>safe text here</p>", HTML, [
        qe("safe text", '<img src=x onerror="pwn()"> &'),
      ]),
    ).toBe("<p>&lt;img src=x onerror=&quot;pwn()&quot;&gt; &amp; here</p>")
  })

  it("[HTML-006] sanitizes rich inline markup to the supported inert allowlist", () => {
    const out = applyQuoteEdits("<p>format me now</p>", HTML, [
      markup(
        "format me",
        '<strong onclick="pwn()">format</strong> <a href="javascript:alert(1)" style="x">me</a><script>x</script>',
      ),
    ])
    expect(out).not.toMatch(/onclick|javascript:|style=|<script/i)
    expect(out).toContain("<strong>format</strong>")
  })

  it("[HTML-007] uses context across tags to pin one repeated card", () => {
    const source =
      "<article><h2>Alpha</h2><p>Learn more</p></article><article><h2>Beta</h2><p>Learn more</p></article>"
    const out = applyQuoteEdits(source, HTML, [
      qe("Learn more", "Discover", { prefix: "Beta\n", suffix: "" }),
    ])
    expect(out).toContain("<h2>Alpha</h2><p>Learn more</p>")
    expect(out).toContain("<h2>Beta</h2><p>Discover</p>")
  })

  it("[HTML-008] preserves RTL, emoji clusters, and adjacent inline tags", () => {
    const source = "<p>مرحبا <b>🌍</b><i>世界</i> 👩🏽‍💻</p>"
    expect(applyQuoteEdits(source, HTML, [qe("世界", "العالم")])).toBe(
      "<p>مرحبا <b>🌍</b><i>العالم</i> 👩🏽‍💻</p>",
    )
  })

  it("[HTML-009] refuses malformed/non-text boundaries instead of guessing", () => {
    expect(() =>
      applyQuoteEdits("<p>before <!-- boundary --> after</p>", HTML, [
        qe("before after", "merged"),
      ]),
    ).toThrow(/non-text HTML boundary/)
    expect(() =>
      applyQuoteEdits("<p><b>left <i>middle</b> right</i> tail</p>", HTML, [
        qe("left middle right", "changed"),
      ]),
    ).toThrow(/malformed HTML nesting/)
  })

  it("[HTML-010] keeps hostile unclosed markup projection bounded", () => {
    const source = `${"<!-- ".repeat(5000)}tail unique`
    const start = performance.now()
    expect(pageTextParts(source).text).toBe(" ")
    expect(performance.now() - start).toBeLessThan(500)
  })

  it("[HTML-011] matches the browser's full character-reference decoding", () => {
    for (const [entity, visible] of [
      ["&NotEqualTilde;", "≂̸"],
      ["&CounterClockwiseContourIntegral;", "∳"],
      ["&copy", "©"],
      ["&#x80;", "€"],
      ["&#128;", "€"],
    ] as const) {
      const source = `<p>A${entity}B</p>`
      expect(applyQuoteEdits(source, HTML, [qe(`A${visible}B`, "X")])).toBe("<p>X</p>")
    }
  })

  it("[HTML-012] hides inert document containers and recognizes spaced raw-text closers", () => {
    const hidden =
      "<head><title>secret-title</title></head><template><p>secret-template</p></template>" +
      '<iframe srcdoc="<p>secret-frame</p>"></iframe><p>visible</p>'
    for (const exact of ["secret-title", "secret-template", "secret-frame"])
      expect(() => applyQuoteEdits(hidden, HTML, [qe(exact, "X")])).toThrow(/wasn't found/)
    expect(
      applyQuoteEdits("<script>hidden</script >VISIBLETAIL", HTML, [qe("VISIBLETAIL", "X")]),
    ).toBe("<script>hidden</script >X")
  })

  it("[HTML-013] blocks normalized script URLs and refuses formatting over authored markup", () => {
    for (const href of ["java&#9;script:alert(1)", "java\nscript:alert(1)"]) {
      const out = applyQuoteEdits("<p>target</p>", HTML, [
        markup("target", `<a href="${href}">target</a>`),
      ])
      expect(out).toBe("<p><a>target</a></p>")
    }
    const authored =
      '<p><mark data-note="keep">Acme</mark> <a href="/jobs">platform</a> <em>team</em></p>'
    expect(() =>
      applyQuoteEdits(authored, HTML, [markup("Acme platform team", "<b>Acme platform team</b>")]),
    ).toThrow(/could remove links or attributes/)
  })

  it("[HTML-014] refuses surrogate, combining-mark, modifier, and ZWJ splits", () => {
    for (const exact of ["\udc69", "\u0301", "🏽", "\u200d"])
      expect(() => applyQuoteEdits("<p>👩🏽‍💻 café</p>", HTML, [qe(exact, "X")])).toThrow(
        /split a character/,
      )
  })

  it("[HTML-015] refuses plain-text replacement that would delete authored metadata", () => {
    const source = '<p><a href="/x">foo</a> <mark data-k="v">bar</mark></p>'
    expect(() => applyQuoteEdits(source, HTML, [qe("foo bar", "X")])).toThrow(
      /could remove links or attributes/,
    )
  })

  it("[HTML-016] keeps nested templates, hidden elements, and legacy comments invisible", () => {
    for (const [source, exact] of [
      [
        "<template><template>inner-hidden</template>outer-hidden</template><p>visible</p>",
        "outer-hidden",
      ],
      ["<div hidden>hidden-attribute</div><p>visible</p>", "hidden-attribute"],
    ] as const)
      expect(() => applyQuoteEdits(source, HTML, [qe(exact, "X")])).toThrow(/wasn't found/)
    expect(
      applyQuoteEdits("<!-- hidden --!><p>visible-tail</p>", HTML, [qe("visible-tail", "X")]),
    ).toBe("<!-- hidden --!><p>X</p>")
  })

  it("[HTML-017] preserves URL query entities through inline sanitization", () => {
    expect(
      applyQuoteEdits("<p>target</p>", HTML, [
        markup("target", '<a href="https://derive.to?x=1&amp;y=2">link</a>'),
      ]),
    ).toBe('<p><a href="https://derive.to?x=1&amp;y=2">link</a></p>')
  })

  it("[HTML-018] never projects bytes from an unterminated quoted attribute", () => {
    const source = '<div title=" > secret</div><p>visible</p>'
    expect(pageTextParts(source).text).not.toContain("secret")
    expect(pageTextParts(source).text).not.toContain("visible")
    expect(() => applyQuoteEdits(source, HTML, [qe("secret", "X")])).toThrow(/wasn't found/)
  })

  it("[HTML-019] ends a boolean-hidden void element at its opening tag", () => {
    const source = "<input hidden><p>visible</p>"
    expect(pageTextParts(source).text).toMatch(/visible/)
    expect(applyQuoteEdits(source, HTML, [qe("visible", "X")])).toBe("<input hidden><p>X</p>")
  })

  it("[HTML-020] strips protocol-relative external links from inline formatting", () => {
    expect(
      applyQuoteEdits("<p>target</p>", HTML, [
        markup("target", '<a href="//evil.test/x">target</a>'),
      ]),
    ).toBe("<p><a>target</a></p>")
    expect(
      applyQuoteEdits("<p>target</p>", HTML, [markup("target", '<a href="/safe/path">target</a>')]),
    ).toBe('<p><a href="/safe/path">target</a></p>')
  })

  it("[HTML-021] respects the head element's implied end before body content", () => {
    const source = '<head><meta charset="utf-8"><p>visible</p>'
    expect(pageTextParts(source).text).toMatch(/visible/)
    expect(applyQuoteEdits(source, HTML, [qe("visible", "X")])).toBe(
      '<head><meta charset="utf-8"><p>X</p>',
    )
  })

  it("[HTML-022] respects an omitted list-item end tag after a hidden item", () => {
    const source = "<ul><li hidden>hidden<li>visible</ul><p>tail</p>"
    expect(pageTextParts(source).text).toMatch(/visible.*tail/)
    expect(applyQuoteEdits(source, HTML, [qe("visible", "X")])).toBe(
      "<ul><li hidden>hidden<li>X</ul><p>tail</p>",
    )
  })

  it("[HTML-023] respects an omitted table-row end tag after a hidden row", () => {
    const source = "<table><tr hidden><td>hidden</td><tr><td>visible</td></tr></table><p>tail</p>"
    expect(pageTextParts(source).text).toMatch(/visible.*tail/)
    expect(applyQuoteEdits(source, HTML, [qe("visible", "X")])).toBe(
      "<table><tr hidden><td>hidden</td><tr><td>X</td></tr></table><p>tail</p>",
    )
  })

  it("[HTML-024] respects an omitted hidden colgroup end before the table body", () => {
    const source =
      "<table><colgroup hidden><col><tbody><tr><td>visible</td></tr></tbody></table><p>tail</p>"
    expect(pageTextParts(source).text).toMatch(/visible.*tail/)
    expect(applyQuoteEdits(source, HTML, [qe("visible", "X")])).toBe(
      "<table><colgroup hidden><col><tbody><tr><td>X</td></tr></tbody></table><p>tail</p>",
    )
  })

  it("[HTML-025] closes a hidden thead at the table end", () => {
    const source = "<table><thead hidden><tr><td>hidden</tr></table><p>tail</p>"
    expect(pageTextParts(source).text).toMatch(/tail/)
    expect(applyQuoteEdits(source, HTML, [qe("tail", "X")])).toBe(
      "<table><thead hidden><tr><td>hidden</tr></table><p>X</p>",
    )
  })

  it("[HTML-026] treats SVG and MathML integration-point descendants as HTML", () => {
    for (const source of [
      "<svg><foreignObject><div hidden/><p>visible</p></foreignObject></svg>",
      "<math><mtext><div hidden/><p>visible</p></mtext></math>",
    ]) {
      expect(pageTextParts(source).text).not.toContain("visible")
      expect(() => applyQuoteEdits(source, HTML, [qe("visible", "X")])).toThrow(/wasn't found/)
    }
  })
})

describe("editing eval — deck identity and structural operations", () => {
  it("[DECK-001] context pins repeated text to one slide", () => {
    const source = deck(["<h2>Alpha</h2><p>Shared line</p>", "<h2>Beta</h2><p>Shared line</p>"])
    const out = applyQuoteEdits(source, DECK, [
      qe("Shared line", "Changed line", { prefix: "Beta\n" }),
    ])
    expect(out).toContain("<h2>Alpha</h2><p>Shared line</p>")
    expect(out).toContain("<h2>Beta</h2><p>Changed line</p>")
  })

  it("[DECK-002] refuses text edits that would merge two slides", () => {
    const source = deck(["<p>Alpha ending</p>", "<p>Beta opening</p>"])
    expect(() => applyQuoteEdits(source, DECK, [qe("ending Beta", "bridge")])).toThrow(
      /element boundary/,
    )
  })

  it("[DECK-003] applies sequential move, duplicate, and delete with unique identity", () => {
    const source = deck(["A", "B", "C"])
    const out = applySlideOps(source, [
      { op: "move", from: 3, to: 1 },
      { op: "duplicate", at: 2 },
      { op: "delete", at: 4 },
    ])
    const spans = sliceSlides(out)
    expect(spans).toHaveLength(3)
    expect(new Set(spans.map((s) => s.id)).size).toBe(3)
    expect(spans.map((s) => pageTextParts(out.slice(s.start, s.end)).text.trim())).toEqual([
      "C",
      "A",
      "A",
    ])
  })

  it("[DECK-004] stamps class-only slides before duplication without colliding ids", () => {
    const out = applySlideOps(deck(["A", "B"], false), [{ op: "duplicate", at: 1 }])
    const ids = sliceSlides(out).map((s) => s.id)
    expect(ids).toEqual([0, 2, 1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("[DECK-005] refuses orphan content between slides", () => {
    const source = deck(["A", "B"]).replace("</section>\n<section", "</section>orphan<section")
    expect(() => applySlideOps(source, [{ op: "move", from: 1, to: 2 }])).toThrow(
      /content between slides/,
    )
  })

  it("[DECK-006] refuses duplicate authored slide identities", () => {
    const source = deck(["A", "B"]).replace('data-derive-slide="11"', 'data-derive-slide="10"')
    expect(() => applySlideOps(source, [{ op: "move", from: 1, to: 2 }])).toThrow(/share the same/)
  })

  it("[DECK-007] keeps the shell byte-identical around a slide-only change", () => {
    const source = deck(["A", "B", "C"])
    const out = applySlideOps(source, [{ op: "move", from: 3, to: 1 }])
    expect(out.slice(0, out.indexOf("<section"))).toBe(source.slice(0, source.indexOf("<section")))
    expect(out.slice(out.lastIndexOf("</section>") + 10)).toBe(
      source.slice(source.lastIndexOf("</section>") + 10),
    )
  })

  it("[DECK-008] refuses malformed authored slide identities before duplicating", () => {
    const source =
      '<section class="slide" data-derive-slide="1.5">A</section>\n' +
      '<section class="slide" data-derive-slide="4">B</section>'
    expect(() => applySlideOps(source, [{ op: "duplicate", at: 1 }])).toThrow(
      /whole, safely representable integer/,
    )
  })

  it("[DECK-009] refuses duplicate identity attributes on one slide", () => {
    const source =
      '<section class="slide" data-derive-slide="1" data-derive-slide="2">A</section>\n' +
      '<section class="slide" data-derive-slide="3">B</section>'
    expect(() => applySlideOps(source, [{ op: "move", from: 1, to: 2 }])).toThrow(
      /more than one data-derive-slide/,
    )
  })

  it("[DECK-010] classifies quote-aware slide tags exactly as the structural slicer", () => {
    const source =
      '<main><section data-title=">" class="slide">A</section>' +
      '<section class="slide">B</section><script>window.x="derive-deck"</script></main>'
    expect(countSlideElements(source)).toBe(2)
    expect(sliceSlides(source)).toHaveLength(2)
    expect(isDeckDocument(source)).toBe(true)
  })

  it("[DECK-011] does not classify a deck with ambiguous slide identity", () => {
    const source =
      '<main><section class="slide" data-derive-slide="1" data-derive-slide="2">A</section>' +
      '<section class="slide" data-derive-slide="3">B</section>' +
      '<script>window.source="derive-deck"</script></main>'
    expect(countSlideElements(source)).toBe(2)
    expect(() => sliceSlides(source)).toThrow(/more than one data-derive-slide/)
    expect(isDeckDocument(source)).toBe(false)
  })

  it("[DECK-012] keeps comment-like JavaScript from hiding the deck protocol", () => {
    const source =
      '<main><section class="slide">A</section><section class="slide">B</section>' +
      '<script>const x="<!--"; window.source="derive-deck";</script></main>'
    expect(sliceSlides(source)).toHaveLength(2)
    expect(isDeckDocument(source)).toBe(true)
  })

  it("[DECK-013] does not advise protocol for a structurally ambiguous deck", () => {
    const source =
      '<main><section class="slide" data-derive-slide="1" data-derive-slide="2">A</section>' +
      '<section class="slide" data-derive-slide="3">B</section>' +
      '<section class="slide" data-derive-slide="4">C</section></main>'
    expect(() => sliceSlides(source)).toThrow(/more than one data-derive-slide/)
    expect(isUnannouncedDeck(source)).toBe(false)
  })

  it("[DECK-014] keeps comment-like quoted attributes from hiding the protocol", () => {
    const source =
      '<main><section class="slide" data-note="<!-- fake">A</section>' +
      '<section class="slide">B</section>"derive-deck"</main>'
    expect(sliceSlides(source)).toHaveLength(2)
    expect(speaksDeckProtocol(source)).toBe(true)
    expect(isDeckDocument(source)).toBe(true)
  })

  it("[DECK-015] rejects self-closing syntax on non-void slide elements", () => {
    const source =
      '<main><section class="slide" data-derive-slide="1"/>' +
      '<section class="slide" data-derive-slide="2"/>' +
      '<script>window.source="derive-deck"</script></main>'
    expect(() => sliceSlides(source)).toThrow(/never closed/)
    expect(isDeckDocument(source)).toBe(false)
  })

  it("[DECK-016] rewrites nested DOM ids and references in duplicated slides", () => {
    const source = deck([
      '<h2 id="title-a">A</h2><p id="desc-a">Description</p>' +
        '<div aria-labelledby="title-a" aria-describedby="desc-a">' +
        '<svg><symbol id="icon-a"></symbol><use href="#icon-a"></use></svg></div>',
      "B",
    ])
    const out = applySlideOps(source, [{ op: "duplicate", at: 1 }])
    expect(tags(out).flatMap((tag) => attrValues(tag.attrs, "id"))).toEqual([
      "title-a",
      "desc-a",
      "icon-a",
      "title-a--derive-copy-12",
      "desc-a--derive-copy-12",
      "icon-a--derive-copy-12",
    ])
    expect(out).toContain(
      'aria-labelledby="title-a--derive-copy-12" aria-describedby="desc-a--derive-copy-12"',
    )
    expect(out).toContain('href="#icon-a--derive-copy-12"')
  })

  it("[DECK-017] rejects self-closing slide syntax at an SVG HTML integration point", () => {
    const source =
      '<main><svg><foreignObject><section class="slide" data-derive-slide="1"/>A</foreignObject>' +
      '<foreignObject><section class="slide" data-derive-slide="2"/>B</foreignObject></svg>' +
      '<script>window.source="derive-deck"</script></main>'
    expect(() => sliceSlides(source)).toThrow(/nested|never closed/)
    expect(isDeckDocument(source)).toBe(false)
  })

  it("[DECK-018] rewrites copied HTML IDREFs and quoted CSS fragment URLs", () => {
    const source = deck([
      '<div id="foo" itemref="foo map" contextmenu="menu" usemap="#map"></div>' +
        '<map id="map"></map><menu id="menu"></menu>' +
        '<svg><linearGradient id="grad"></linearGradient>' +
        "<rect style=\"fill:url('#grad');stroke:url(&quot;#grad&quot;)\"></rect></svg>",
      "B",
    ])
    const out = applySlideOps(source, [{ op: "duplicate", at: 1 }])
    expect(out).toContain('itemref="foo--derive-copy-12 map--derive-copy-12"')
    expect(out).toContain('contextmenu="menu--derive-copy-12"')
    expect(out).toContain('usemap="#map--derive-copy-12"')
    expect(out).toContain("url('#grad--derive-copy-12')")
    expect(out).toContain("url(&quot;#grad--derive-copy-12&quot;)")
  })
})

describe("editing eval — video scene operations", () => {
  it("[VIDEO-001] updates, duplicates, moves, and deletes scenes with unique ids", () => {
    const out = applySceneEdits(video(), [
      { op: "scene-update", id: "opening", duration_ms: 2500, transition: "dissolve" },
      { op: "scene-duplicate", id: "proof" },
      { op: "scene-move", id: "close", direction: "previous" },
      { op: "scene-delete", id: "proof" },
    ])
    const scenes = sliceScenes(out)
    expect(scenes.map((s) => s.id)).toEqual(["opening", "close", "scene-4"])
    expect(scenes[0]).toMatchObject({ durationMs: 2500, transition: "dissolve" })
  })

  it("[VIDEO-002] enforces bounds and escapes caption attribute content", () => {
    expect(() =>
      applySceneEdits(video(), [{ op: "scene-update", id: "opening", duration_ms: 999 }]),
    ).toThrow(/between 1000 and 30000/)
    const payload = '"><img src=x onerror="pwn()"> &'
    const out = applySceneEdits(video(), [{ op: "scene-update", id: "opening", caption: payload }])
    expect(out).not.toContain('data-derive-caption=""><img')
    expect(out).toContain("&quot;&gt;&lt;img")
  })

  it("[VIDEO-003] refuses nested, duplicate, and orphan scene structures", () => {
    const nested =
      '<main data-derive-video><section data-derive-scene="one"><section data-derive-scene="two"></section></section></main>'
    expect(() => sliceScenes(nested)).toThrow(/nested/)
    const duplicate =
      '<main data-derive-video><section data-derive-scene="one"></section><section data-derive-scene="one"></section></main>'
    expect(() => sliceScenes(duplicate)).toThrow(/unique/)
    const orphan = video().replace("</section>\n<section", "</section>orphan<section")
    expect(() =>
      applySceneEdits(orphan, [{ op: "scene-move", id: "proof", direction: "previous" }]),
    ).toThrow(/Content between scenes/)
  })

  it("[VIDEO-004] refuses invalid directions, unknown operations, and no-op batches", () => {
    expect(() =>
      applySceneEdits(video(), [{ op: "scene-move", id: "proof", direction: "sideways" } as never]),
    ).toThrow(/direction.*invalid/)
    expect(() =>
      applySceneEdits(video(), [{ op: "scene-surprise", id: "proof" } as never]),
    ).toThrow(/Unknown scene operation/)
    expect(() => applySceneEdits(video(), [{ op: "scene-update", id: "opening" }])).toThrow(
      /nothing to publish/,
    )
  })

  it("[VIDEO-005] refuses duplicate identity attributes on one scene", () => {
    const source =
      '<main data-derive-video><section data-derive-scene="one" ' +
      'data-derive-scene="shadow"></section></main>'
    expect(() => sliceScenes(source)).toThrow(/more than one data-derive-scene/)
  })
})

describe("editing eval — element selectors and CSS preservation", () => {
  it("[ELEMENT-001] resizes only the intended repeated element", () => {
    const image = '<img src="same.png" alt="Logo">'
    const source = `<p>One</p>${image}<p>Two</p>${image}<p>Three</p>`
    const out = applyElementEdits(source, [resize(source, "img", 144, "auto", 1)])
    expect(out.match(/style=/g)).toHaveLength(1)
    expect(out.indexOf("style=")).toBeGreaterThan(out.indexOf("<p>Two</p>"))
  })

  it("[ELEMENT-002] preserves CSS strings, functions, data URLs, and custom properties", () => {
    const source =
      `<div id="box" style="background: url('data:image/svg+xml;utf8,x'); ` +
      `transform: translate(calc(10px + var(--x)), 2px); --note: 'a;b'; width: 10px; height: 10px"></div>`
    const out = applyElementEdits(source, [resize(source, "div", 240, 140)])
    expect(out).toContain("url('data:image/svg+xml;utf8,x')")
    expect(out).toContain("translate(calc(10px + var(--x)), 2px)")
    expect(out).toContain("--note: 'a;b'")
    expect(out).toContain("width: 240px; height: 140px")
  })

  it("[ELEMENT-003] refuses stale selectors, bounds, malformed payloads, and no-ops", () => {
    const source = '<img id="hero" src="hero.png" style="width: 100px; height: auto">'
    const op = resize(source, "img", 100, "auto")
    expect(() => applyElementEdits(source, [op])).toThrow(/existing size/)
    expect(() =>
      applyElementEdits('<img id="other" src="other.png">', [resize(source, "img", 200, "auto")]),
    ).toThrow(/matched confidently/)
    expect(() => applyElementEdits(source, [resize(source, "img", 9, "auto")])).toThrow(
      /between 24 and 8192/,
    )
  })
})
