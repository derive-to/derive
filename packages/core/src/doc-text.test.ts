import { describe, expect, it } from "vitest"
import { pageText } from "./anchor"
import {
  applyEdits,
  docOutline,
  EditError,
  elideDataUris,
  elideDataUrisToLimit,
  htmlToMarkdown,
  LANDMARK_TAGS,
  landmarkMap,
  landmarkSlice,
  outlineOf,
  sectionMarkers,
  sectionOf,
  sectionSlice,
  toMarkdown,
} from "./doc-text"
import { MARKS_SCRIPT } from "./marks-script"

const doc = (body: string) =>
  `<!DOCTYPE html><html><head><title>T</title><style>body{color:red}</style></head><body>${body}</body></html>`

describe("htmlToMarkdown", () => {
  it("drops head, style, script, svg, noscript subtrees whole", () => {
    const md = htmlToMarkdown(
      doc(
        "<script>let x = '<p>fake</p>'</script><svg><text>vector</text></svg>" +
          "<noscript><p>fallback</p></noscript><p>real</p>",
      ),
    )
    expect(md).toBe("real")
  })

  it("renders inline emphasis, code, links, and images", () => {
    const md = htmlToMarkdown(
      doc(
        "<p>Use <strong>bold</strong>, <em>italics</em>, <code>a`b</code>, " +
          '<a href="https://x.test/y">a link</a>, and <img src="pic.png" alt="a pic">.</p>',
      ),
    )
    expect(md).toBe(
      "Use **bold**, *italics*, ``a`b``, [a link](https://x.test/y), and ![a pic](pic.png).",
    )
  })

  it("keeps heading slugs on text content when headings contain inline tags", () => {
    const out = docOutline(doc("<h2>The <code>read</code> tool</h2>"))
    expect(out[0]?.text).toBe("The read tool")
    expect(out[0]?.slug).toBe("the-read-tool")
  })

  it("renders fenced code with language, decoded entities, preserved newlines", () => {
    const md = htmlToMarkdown(
      doc(
        '<pre><code class="language-ts">const a = 1\nif (a &lt; 2) run(&quot;x&quot;)</code></pre>',
      ),
    )
    expect(md).toBe('```ts\nconst a = 1\nif (a < 2) run("x")\n```')
  })

  it("renders pipe tables with escaped pipes and align attrs", () => {
    const md = htmlToMarkdown(
      doc(
        '<table><thead><tr><th>Name</th><th align="right">N</th></tr></thead>' +
          "<tbody><tr><td>a|b</td><td>1</td></tr></tbody></table>",
      ),
    )
    expect(md).toBe("| Name | N |\n| --- | ---: |\n| a\\|b | 1 |")
  })

  it("escapes backslashes before table pipes so a cell cannot break the table", () => {
    const md = htmlToMarkdown(doc("<table><tr><th>A</th></tr><tr><td>x\\|y</td></tr></table>"))
    expect(md).toContain("x\\\\\\|y")
  })

  it("drops active and unknown link schemes while preserving safe and relative links", () => {
    const md = htmlToMarkdown(
      doc(
        '<p><a href="javascript:alert(1)">js</a> <a href="data:text/html,x">data</a> ' +
          '<a href="vbscript:msgbox(1)">vb</a> <a href="/safe">relative</a> ' +
          '<a href="https://example.com/a(b)">https</a></p>',
      ),
    )
    expect(md).not.toContain("javascript:")
    expect(md).not.toContain("data:")
    expect(md).not.toContain("vbscript:")
    expect(md).toContain("[relative](/safe)")
    expect(md).toContain("[https](https://example.com/a%28b%29)")
  })

  it("wraps inline <code> found inside table cells (regression: found via real Sift docs)", () => {
    const md = htmlToMarkdown(
      doc(
        "<table><tr><th>ID</th><th>Loc</th></tr>" +
          '<tr><td>A-1</td><td>passes <code>orgId:""</code> into <code>filter-sql-builders.ts:64</code></td></tr>' +
          "</table>",
      ),
    )
    expect(md).toBe(
      '| ID | Loc |\n| --- | --- |\n| A-1 | passes `orgId:""` into `filter-sql-builders.ts:64` |',
    )
    // No stray backtick fragments leaked after the table (the bug also corrupted
    // trailing output, not just the missing backticks).
    expect(md.trim().endsWith("|")).toBe(true)
  })

  it("keeps table structure intact when a cell contains block tags (regression: <p>/heading in a <td> used to corrupt the table)", () => {
    const md = htmlToMarkdown(
      doc(
        "<h1>Doc</h1><table><tr><th>A</th><th>B</th></tr>" +
          "<tr><td><p>one</p><p>two</p></td><td><h2>heading</h2>text</td></tr>" +
          "<tr><td>x</td><td><hr>y</td></tr></table><h2>After</h2><p>tail</p>",
      ),
    )
    const lines = md.split("\n\n")
    expect(lines[0]).toBe("# Doc")
    // The table renders as exactly one block: header + separator + 2 data rows,
    // all on contiguous lines — no stray out-of-band pushes split it apart.
    const tableBlock = lines.find((l) => l.startsWith("| A | B |"))
    expect(tableBlock?.split("\n")).toHaveLength(4)
    expect(tableBlock).toContain("| heading")
    expect(tableBlock).toContain("| y |")
    expect(lines.at(-2)).toBe("## After")
    expect(lines.at(-1)).toBe("tail")
  })

  it("degrades a <pre><code> block inside a table cell to inline backticks (regression: it used to switch tokenizer modes and inject a fenced block into the top-level output, corrupting the table)", () => {
    const md = htmlToMarkdown(
      doc(
        "<table><tr><th>A</th><th>B</th></tr><tr><td>cmd</td><td><pre><code>run x</code></pre></td></tr></table>",
      ),
    )
    expect(md).toBe("| A | B |\n| --- | --- |\n| cmd | `run x` |")
  })

  it("an unclosed <blockquote> inside a table cell doesn't leak quote-depth state into content after the table (regression)", () => {
    const md = htmlToMarkdown(
      doc(
        "<h1>Doc</h1><table><tr><td><blockquote>note</td><td>b</td></tr></table><h2>After</h2><p>tail</p>",
      ),
    )
    expect(md).toBe("# Doc\n\n| note | b |\n| --- | --- |\n\n## After\n\ntail")
  })

  it("renders nested blockquotes, hr, and br hard breaks", () => {
    expect(
      htmlToMarkdown(
        doc("<blockquote><p>outer</p><blockquote><p>inner</p></blockquote></blockquote>"),
      ),
    ).toBe("> outer\n\n> > inner")
    expect(htmlToMarkdown(doc("<p>a</p><hr><p>b</p>"))).toBe("a\n\n---\n\nb")
    expect(htmlToMarkdown(doc("<p>line one<br>line two</p>"))).toBe("line one\nline two")
  })

  it("decodes named, decimal, and hex entities; unknown ones pass through", () => {
    const md = htmlToMarkdown(doc("<p>&amp; &#65; &#x42; &nosuch; &nbsp;done</p>"))
    expect(md).toBe("& A B &nosuch; done")
  })

  it("decodes common typographic entities (regression: real Sift/Derive docs use these throughout)", () => {
    const md = htmlToMarkdown(
      doc("<p>v2 &mdash; final &middot; wave 1&ndash;3 &hellip; see &rarr; &ldquo;done&rdquo;</p>"),
    )
    expect(md).toBe("v2 — final · wave 1–3 … see → “done”")
  })

  it("turns minified one-line HTML into multi-line markdown", () => {
    const min = doc(
      "<h1>Title</h1><p>Intro text.</p><h2>Part</h2><ul><li>one</li><li>two</li></ul>",
    )
    expect(min.includes("\n")).toBe(false)
    expect(htmlToMarkdown(min)).toBe("# Title\n\nIntro text.\n\n## Part\n\n- one\n\n- two")
  })
})

describe("headingSlug + slugger", () => {
  it("dedups repeated headings across a document", () => {
    const out = docOutline(doc("<h2>Goals</h2><h2>Goals</h2><h2>Goals</h2>"))
    expect(out.map((s) => s.slug)).toEqual(["goals", "goals-1", "goals-2"])
  })
})

describe("elideDataUrisToLimit", () => {
  const matchesFullElision = (source: string, limit: number) =>
    expect(elideDataUrisToLimit(source, limit)).toBe(elideDataUris(source).slice(0, limit))

  it("matches full elision for long plain sources without scanning semantics", () => {
    matchesFullElision("a".repeat(2_000_000), 256 * 1024)
  })

  it("matches full elision when a large URI crosses the output boundary", () => {
    const source = `before data:image/png;base64,${"A".repeat(500_000)} after ${"z".repeat(500_000)}`
    matchesFullElision(source, 80)
    matchesFullElision(source, 256 * 1024)
  })

  it("keeps short URIs and ignores malformed candidates exactly like full elision", () => {
    const source =
      `bad data:not-a-uri then data:image/png;base64,${"A".repeat(40)} ` +
      `and data:image/png;base64,${"B".repeat(240)} tail`
    for (const limit of [0, 4, 20, 80, 180, 400]) matchesFullElision(source, limit)
  })

  it("matches full elision across deterministic mixed-source cases", () => {
    let state = 0x861
    const next = (max: number) => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0
      return state % max
    }
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
    const base64 = (length: number) =>
      Array.from({ length }, () => alphabet[next(alphabet.length)]).join("")

    for (let sample = 0; sample < 500; sample++) {
      const parts: string[] = []
      for (let part = 0; part < 2 + next(8); part++) {
        const kind = next(4)
        if (kind === 0) parts.push("plain-".repeat(next(80)))
        else if (kind === 1) parts.push(`data:image/png;base64,${base64(next(700))}`)
        else if (kind === 2) parts.push(`data:not-valid;base64,${base64(next(120))}`)
        else parts.push("literal data: marker")
      }
      const source = parts.join("|")
      matchesFullElision(source, next(source.length + 200))
    }
  })
})

describe("docOutline + sectionSlice", () => {
  const body =
    "<h1>Top</h1><p>intro</p>" +
    "<h2>Alpha</h2><p>alpha text</p><h3>Alpha sub</h3><p>sub text</p>" +
    "<h2>Beta</h2><p>beta text</p>"
  const html = doc(body)

  it("lists h1–h3 with levels and sizes", () => {
    const out = docOutline(html)
    expect(out.map((s) => [s.level, s.slug])).toEqual([
      [1, "top"],
      [2, "alpha"],
      [3, "alpha-sub"],
      [2, "beta"],
    ])
    for (const s of out) expect(s.chars).toBeGreaterThan(0)
  })

  it("covers the full h1–h6 spine, not just h1–h3", () => {
    const deep = doc(
      "<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6><p>x</p>",
    )
    expect(docOutline(deep).map((s) => [s.level, s.slug])).toEqual([
      [1, "one"],
      [2, "two"],
      [3, "three"],
      [4, "four"],
      [5, "five"],
      [6, "six"],
    ])
    // A deep heading is addressable, and its section runs to the next same-or-higher.
    expect(sectionSlice(deep, "four")).toContain("<h4>Four</h4>")
    expect(outlineOf(deep, "text/html").map((s) => s.level)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it("slices a section up to the next same-or-higher heading", () => {
    const alpha = sectionSlice(html, "alpha")
    expect(alpha).toContain("<h2>Alpha</h2>")
    expect(alpha).toContain("Alpha sub") // its own h3 belongs to it
    expect(alpha).not.toContain("Beta")
  })

  it("runs the last section to </body> and stays a byte-identical substring", () => {
    const beta = sectionSlice(html, "beta")
    expect(beta).toBe("<h2>Beta</h2><p>beta text</p>")
    expect(html.includes(beta as string)).toBe(true)
  })

  it("returns null for an unknown slug and [] for a heading-less doc", () => {
    expect(sectionSlice(html, "nope")).toBeNull()
    expect(docOutline(doc("<p>just prose</p>"))).toEqual([])
  })

  it("ignores headings that live inside dropped subtrees — a <script> template string or a <template> tag must not become a phantom outline entry (regression)", () => {
    const withScript = doc(
      '<script>const s = "<h2>Fake</h2>"</script><template><h2>Also fake</h2></template><h1>Real</h1><p>x</p>',
    )
    const outline = docOutline(withScript)
    expect(outline.map((s) => s.text)).toEqual(["Real"])
    // And the section it DOES find slices and converts cleanly, with no leaked markup.
    expect(sectionSlice(withScript, "real")).toContain("<h1>Real</h1>")
  })
})

describe("landmarkMap (headless-page fallback)", () => {
  it("maps top-level landmarks with role, label, and size", () => {
    const html = doc(
      '<header id="masthead"><p>logo</p></header>' +
        '<nav aria-label="Primary"><a href="/a">A</a></nav>' +
        "<main><p>the dashboard body has real content here</p></main>" +
        "<footer><p>fin</p></footer>",
    )
    const map = landmarkMap(html)
    // Roles are the implicit ARIA landmark roles (banner/navigation/main/contentinfo).
    expect(map.map((r) => [r.role, r.label])).toEqual([
      ["banner", "masthead"],
      ["navigation", "Primary"],
      ["main", null],
      ["contentinfo", null],
    ])
    for (const r of map) expect(r.chars).toBeGreaterThan(0)
    // The unlabelled <main> is still recognizable from its text preview.
    expect(map[2]?.text).toBe("the dashboard body has real content here")
  })

  it("folds a nested landmark into its parent (map stays shallow)", () => {
    const html = doc("<main><section aria-label='inner'><p>x</p></section></main>")
    expect(landmarkMap(html).map((r) => [r.role, r.label])).toEqual([["main", null]])
  })

  it("prefers an explicit role attribute, and masks dropped subtrees", () => {
    const html = doc(
      '<template><nav aria-label="fake"></nav></template><section role="search" aria-label="Stats"><p>y</p></section>',
    )
    const map = landmarkMap(html)
    expect(map).toHaveLength(1) // the <template> nav is masked
    expect(map[0]?.role).toBe("search") // explicit role beats the implicit "region"
    expect(map[0]?.label).toBe("Stats")
  })
})

describe("landmarkSlice (region-addressable reads)", () => {
  const html = doc(
    '<nav aria-label="Nav">n</nav><main><p>the main body</p></main><footer>fin</footer>',
  )
  it("returns the Nth top-level region's raw HTML, matching the map order", () => {
    expect(landmarkSlice(html, 1)).toContain("<nav")
    expect(landmarkSlice(html, 2)).toContain("the main body")
    expect(landmarkSlice(html, 2)?.startsWith("<main>")).toBe(true)
    expect(landmarkSlice(html, 3)).toContain("fin")
    expect(landmarkSlice(html, 4)).toBeNull() // no 4th region
    expect(landmarkSlice(html, 0)).toBeNull()
  })
})

describe("sectionMarkers + enclosingMarker (self-locating search)", () => {
  it("markers = ATX headings for markdown, with 1-based line numbers", () => {
    const md = "# Top\nintro\n\n## Alpha\nbody\n\n## Beta\nmore"
    expect(sectionMarkers(md, "text/markdown")).toEqual([
      { text: "Top", line: 1 },
      { text: "Alpha", line: 4 },
      { text: "Beta", line: 7 },
    ])
  })

  it("markers = headings + NESTED labelled landmarks for HTML (the finest section)", () => {
    // A card inside <main> is the finest enclosing section — top-level-only would miss it.
    const html =
      "<body>\n<h1>Report</h1>\n<main>\n<section aria-label='Revenue'>rev</section>\n<section aria-label='Risks'>risk</section>\n</main>\n</body>"
    const markers = sectionMarkers(html, "text/html")
    expect(markers).toEqual([
      { text: "Report", line: 2 },
      { text: "Revenue", line: 4 },
      { text: "Risks", line: 5 },
    ])
  })
})

describe("markdown twins (outlineOf / sectionOf / toMarkdown)", () => {
  const md =
    "# Top\n\nintro\n\n```\n# not a heading\n```\n\n## Alpha\n\nalpha text\n\n## Beta\n\nbeta text\n"

  it("outlines ATX headings, ignoring code fences", () => {
    expect(outlineOf(md, "text/markdown").map((s) => s.slug)).toEqual(["top", "alpha", "beta"])
  })

  it("slices markdown sections by slug", () => {
    expect(sectionOf(md, "text/markdown", "alpha")).toBe("## Alpha\n\nalpha text\n")
  })

  it("dispatches HTML content types to the HTML side", () => {
    const html = doc("<h2>Only</h2><p>x</p>")
    expect(outlineOf(html, "text/html").map((s) => s.slug)).toEqual(["only"])
    expect(sectionOf(html, "text/html", "only")).toContain("<h2>Only</h2>")
    expect(toMarkdown(html, "text/html")).toBe("## Only\n\nx")
  })
})

describe("applyEdits", () => {
  it("applies edits sequentially, each seeing the prior result", () => {
    expect(
      applyEdits("a b c", [
        { old_str: "b", new_str: "B" },
        { old_str: "a B", new_str: "x" },
      ]),
    ).toBe("x c")
  })

  it("allows an empty new_str (deletion)", () => {
    expect(applyEdits("keep drop keep2", [{ old_str: " drop", new_str: "" }])).toBe("keep keep2")
  })

  it("rejects zero-match and multi-match, naming the edit", () => {
    expect(() => applyEdits("abc", [{ old_str: "zz", new_str: "y" }])).toThrow(
      /Edit 1 of 1 failed.*not found/,
    )
    expect(() => applyEdits("x x", [{ old_str: "x", new_str: "y" }])).toThrow(/matched 2 times/)
    expect(() => applyEdits("abc", [])).toThrow(EditError)
  })

  it("counts a self-overlapping needle as its single non-overlapping match, not ambiguous (regression)", () => {
    // "aa" appears at offsets 0 and 1 in "aaa" — those overlap. A real replace only
    // ever makes the one match String.replace itself would find; the old counter
    // (advancing by 1 char) double-counted the overlap and rejected this as multi-match.
    expect(applyEdits("aaa", [{ old_str: "aa", new_str: "b" }])).toBe("ba")
  })

  it("`occurrence` picks which of several identical matches to replace", () => {
    expect(applyEdits("x x x", [{ old_str: "x", new_str: "y", occurrence: 2 }])).toBe("x y x")
    expect(applyEdits("x x x", [{ old_str: "x", new_str: "y", occurrence: 1 }])).toBe("y x x")
    expect(applyEdits("x x x", [{ old_str: "x", new_str: "y", occurrence: 3 }])).toBe("x x y")
  })

  it("`occurrence` out of range is an actionable error naming the real count", () => {
    expect(() => applyEdits("x x", [{ old_str: "x", new_str: "y", occurrence: 5 }])).toThrow(
      /occurrence 5 is out of range.*matched 2 times \(occurrence 1\.\.2\)/,
    )
  })

  it("`occurrence` on an already-unique match must be 1, or it's rejected", () => {
    expect(applyEdits("abc", [{ old_str: "b", new_str: "B", occurrence: 1 }])).toBe("aBc")
    expect(() => applyEdits("abc", [{ old_str: "b", new_str: "B", occurrence: 2 }])).toThrow(
      /occurrence 2 is out of range.*matched once/,
    )
  })

  it("a multi-match WITHOUT occurrence still asks for more context (default, unambiguous behavior unchanged)", () => {
    expect(() => applyEdits("x x", [{ old_str: "x", new_str: "y" }])).toThrow(
      /matched 2 times.*add more surrounding context.*or pass `occurrence`/,
    )
  })

  it("a zero-match miss explains WHY: whitespace-normalized hit names its real line", () => {
    const src = "line one\nline\ttwo  \nline three"
    expect(() => applyEdits(src, [{ old_str: "line  two", new_str: "x" }])).toThrow(
      /is there at line 2, but whitespace differs/,
    )
  })

  it("a zero-match miss falls back to showing what's actually at a similar line (doc changed since read)", () => {
    const src = "alpha\nbeta original\ngamma"
    expect(() => applyEdits(src, [{ old_str: "beta stale text here", new_str: "x" }])).toThrow(
      /similar line exists at line 2.*beta original/s,
    )
  })

  it("a zero-match miss with nothing similar gives the generic re-read steer", () => {
    expect(() =>
      applyEdits("abc", [{ old_str: "zzz not present anywhere", new_str: "y" }]),
    ).toThrow(/Re-read the artifact.*or use `search`/)
  })

  it("Tier 2's anchor match is whole-word, not a bare substring — 'The' must not spuriously match inside 'Theater' (regression)", () => {
    const src = "Theater tickets are on sale now.\nOther line here.\nThird line."
    let msg = ""
    try {
      applyEdits(src, [{ old_str: "The show starts at 8pm.\nDoors open at 7.", new_str: "x" }])
    } catch (e) {
      msg = e instanceof EditError ? e.message : "wrong error type"
    }
    // Before the fix: `.includes("The")` matched inside "Theater", falsely reporting
    // an unrelated line as "similar". A whole-word match finds nothing here, so this
    // must fall through to the generic re-read steer instead.
    expect(msg).not.toMatch(/Theater/)
    expect(msg).toMatch(/Re-read the artifact.*or use `search`/)
  })

  it("Tier 2's anchor match still fires for a genuine whole-word match (fix doesn't over-correct)", () => {
    const src = "alpha\nThe quick brown fox jumps.\ngamma"
    expect(() =>
      applyEdits(src, [{ old_str: "The quick red fox runs.\nmore text", new_str: "x" }]),
    ).toThrow(/similar line exists at line 2.*The quick brown fox jumps/s)
  })

  it("Tier 2's 'similar line' hint clips an enormous single line — a minified/bundled artifact can legitimately put tens of thousands of chars on one line (regression: found via adversarial testing against a real minified HTML file, where the full line was dumped verbatim into the error message)", () => {
    const hugeLine = `The quick brown fox jumps. ${"x".repeat(20_000)}`
    const src = `alpha\n${hugeLine}\ngamma`
    let msg = ""
    try {
      applyEdits(src, [{ old_str: "The quick red fox runs.\nmore text", new_str: "x" }])
    } catch (e) {
      msg = e instanceof EditError ? e.message : "wrong error type"
    }
    expect(msg).toMatch(/similar line exists at line 2/)
    expect(msg.length).toBeLessThan(2_000) // nowhere near the real 20,000+ char line
    expect(msg).toContain("…") // the clip marker
  })

  it("Tier 1's sliding-window scan is bounded — a large haystack × large needle miss returns fast, not O(haystack×needle) (regression)", () => {
    // Mirrors the shape that measured ~900ms unbounded in adversarial testing: a large
    // document combined with a large (but still failing to match) old_str. The bound
    // must keep this fast regardless of size, not just correct.
    const hLines = Array.from({ length: 20_000 }, (_, i) => `haystack line ${i} unrelated content`)
    const nLines = Array.from(
      { length: 3_000 },
      (_, i) => `needle line ${i} totally different text`,
    )
    const src = hLines.join("\n")
    const needle = nLines.join("\n")
    const start = performance.now()
    expect(() => applyEdits(src, [{ old_str: needle, new_str: "x" }])).toThrow(EditError)
    expect(performance.now() - start).toBeLessThan(500)
  })
})

describe("linear-time tokenizing (the second CodeQL round)", () => {
  // The four polynomial-redos alerts the scanner raised on this file's old regexes, each
  // reproduced as the attack string CodeQL named. The bound is generous wall-clock — the
  // point is O(n), and the old patterns took seconds-to-minutes on these inputs.
  it("survives the attack shapes the alerts named", () => {
    const attacks: [string, string][] = [
      [`<A${"-".repeat(60_000)}`, "text/html"], // parseTag's ambiguous name/attrs split
      ["<".repeat(60_000), "text/html"], // heading tag-strip scanning for a '>'
      ["<!--".repeat(20_000), "text/html"], // comment alternative re-scanning false starts
      ["<!".repeat(30_000), "text/html"], // declaration alternative, same shape
      [`<h1>t</h1><h2>${"<".repeat(50_000)}</h2>`, "text/html"],
      [`# title${" ".repeat(60_000)}x`, "text/markdown"], // three overlapping \s loops
      [`# ${"#".repeat(60_000)}`, "text/markdown"],
    ]
    const started = Date.now()
    for (const [src, ct] of attacks) {
      sectionMarkers(src, ct)
      if (ct === "text/html") pageText(src)
    }
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("tokenizes real structures identically after the rewrite", () => {
    // The rewrite must not change what well-formed documents mean: comments containing
    // tags, self-closing tags, closing hashes on ATX headings.
    const html =
      "<body><!-- a <div> comment --><h1>Top</h1><main aria-label='Core'>x</main><br/></body>"
    expect(sectionMarkers(html, "text/html")).toEqual([
      { text: "Top", line: 1 },
      { text: "Core", line: 1 },
    ])
    expect(sectionMarkers("# Closed ##\n\n## Open", "text/markdown")).toEqual([
      { text: "Closed", line: 1 },
      { text: "Open", line: 3 },
    ])
  })
})

describe("MARKS_SCRIPT", () => {
  it("embeds the SAME tag set doc-text.ts's landmarkMap uses — cannot drift apart", () => {
    for (const tag of LANDMARK_TAGS) expect(MARKS_SCRIPT).toContain(tag.toUpperCase())
    // Exactly LANDMARK_TAGS.length quoted tags in the embedded JSON array, no more.
    const start = MARKS_SCRIPT.indexOf("var TAGS = ")
    const end = MARKS_SCRIPT.indexOf(";", start)
    const arrayLiteral = start >= 0 && end > start ? MARKS_SCRIPT.slice(start + 11, end) : null
    expect(arrayLiteral).toBeTruthy()
    const tags = JSON.parse(arrayLiteral as string) as string[]
    expect(tags.sort()).toEqual(LANDMARK_TAGS.map((t) => t.toUpperCase()).sort())
  })
})
