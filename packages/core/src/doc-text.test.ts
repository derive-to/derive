import { describe, expect, it } from "vitest"
import { decodeEntities, pageText } from "./anchor"
import {
  applyEdits,
  docOutline,
  EditError,
  headingSlug,
  htmlToMarkdown,
  outlineOf,
  sectionOf,
  sectionSlice,
  toMarkdown,
} from "./doc-text"

const doc = (body: string) =>
  `<!DOCTYPE html><html><head><title>T</title><style>body{color:red}</style></head><body>${body}</body></html>`

describe("htmlToMarkdown", () => {
  it("converts headings h1–h6", () => {
    const md = htmlToMarkdown(doc("<h1>One</h1><h2>Two</h2><h3>Three</h3><h6>Six</h6>"))
    expect(md).toBe("# One\n\n## Two\n\n### Three\n\n###### Six")
  })

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

  it("renders nested and ordered lists with counters", () => {
    const md = htmlToMarkdown(
      doc("<ul><li>a</li><li>b<ol><li>b1</li><li>b2<ul><li>deep</li></ul></li></ol></li></ul>"),
    )
    expect(md).toBe("- a\n\n- b\n\n  1. b1\n\n  2. b2\n\n    - deep")
  })

  it("renders fenced code with language, decoded entities, preserved newlines", () => {
    const md = htmlToMarkdown(
      doc(
        '<pre><code class="language-ts">const a = 1\nif (a &lt; 2) run(&quot;x&quot;)</code></pre>',
      ),
    )
    expect(md).toBe('```ts\nconst a = 1\nif (a < 2) run("x")\n```')
  })

  it("escalates the fence when code contains backtick runs", () => {
    const md = htmlToMarkdown(doc("<pre><code>```\ninner\n```</code></pre>"))
    expect(md.startsWith("````\n")).toBe(true)
    expect(md.endsWith("\n````")).toBe(true)
  })

  it("strips highlight spans inside pre but keeps their text", () => {
    const md = htmlToMarkdown(
      doc('<pre><code><span class="cm">// note</span>\n<span>x()</span></code></pre>'),
    )
    expect(md).toBe("```\n// note\nx()\n```")
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

  it("collapses whitespace outside pre", () => {
    expect(htmlToMarkdown(doc("<p>a\n   b\t\tc</p>"))).toBe("a b c")
  })

  it("turns minified one-line HTML into multi-line markdown", () => {
    const min = doc(
      "<h1>Title</h1><p>Intro text.</p><h2>Part</h2><ul><li>one</li><li>two</li></ul>",
    )
    expect(min.includes("\n")).toBe(false)
    expect(htmlToMarkdown(min)).toBe("# Title\n\nIntro text.\n\n## Part\n\n- one\n\n- two")
  })

  it("treats unknown tags as transparent", () => {
    expect(htmlToMarkdown(doc('<p><span class="x">kept</span> <mark>also</mark></p>'))).toBe(
      "kept also",
    )
  })
})

describe("headingSlug + slugger", () => {
  it("slugifies GitHub-style", () => {
    expect(headingSlug("PR-6: The Registry Fix!")).toBe("pr-6-the-registry-fix")
    expect(headingSlug("Café après ski")).toBe("cafe-apres-ski")
    expect(headingSlug("???")).toBe("")
  })

  it("dedups repeated headings across a document", () => {
    const out = docOutline(doc("<h2>Goals</h2><h2>Goals</h2><h2>Goals</h2>"))
    expect(out.map((s) => s.slug)).toEqual(["goals", "goals-1", "goals-2"])
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

  it("handles a large many-heading document", () => {
    const parts = Array.from({ length: 36 }, (_, i) => `<h2>Sect ${i}</h2><p>text ${i}</p>`).join(
      "",
    )
    expect(docOutline(doc(parts))).toHaveLength(36)
  })
})

describe("markdown twins (outlineOf / sectionOf / toMarkdown)", () => {
  const md =
    "# Top\n\nintro\n\n```\n# not a heading\n```\n\n## Alpha\n\nalpha text\n\n## Beta\n\nbeta text\n"

  it("passes markdown through toMarkdown untouched", () => {
    expect(toMarkdown(md, "text/markdown")).toBe(md)
  })

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

  it("treats new_str with replacement patterns literally", () => {
    expect(applyEdits("cost", [{ old_str: "cost", new_str: "$& and $1" }])).toBe("$& and $1")
  })
})

describe("decodeEntities extraction keeps pageText behavior", () => {
  it("decodes the same entity forms pageText always did", () => {
    expect(decodeEntities("&amp;&#65;&#x42;&nosuch;")).toBe("&AB&nosuch;")
    expect(pageText("<p>a &lt; b</p><script>x</script>")).toContain("a < b")
    expect(pageText("<p>x</p><script>secret()</script>")).not.toContain("secret")
  })
})
