import { describe, expect, it } from "vitest"
import CVPR from "../test/fixtures/latex/cvpr-sample.tex?raw"
import REFS from "../test/fixtures/latex/refs.bib?raw"
import ACMTOG from "../test/fixtures/latex/sample-acmtog.tex?raw"
import SIGCONF from "../test/fixtures/latex/sample-sigconf.tex?raw"
import { BLOCK_TEXT_ELEMENTS as ANCHOR_BLOCK_ELEMENTS, pageText } from "./anchor"
import {
  isLatexBundle,
  isLatexDocument,
  KATEX_ASSET_BASE,
  KATEX_VERSION,
  latexAdvisories,
  latexTextParts,
  renderLatex,
} from "./latex"
import { latexDynamicBindings } from "./latex-dynamic"
import { BLOCK_TEXT_ELEMENTS as EMIT_BLOCK_ELEMENTS } from "./latex-emit"

const resolve = (path: string) => (path === "refs.bib" ? REFS : null)
const imageUrl = (path: string) => (path === "figures/teaser.png" ? "/blob/teaser.png" : null)

const normWs = (s: string) => s.replace(/\s+/g, " ").trim()
const bodyOf = (html: string) => html.match(/<main(?:\s[^>]*)?>([\s\S]*?)<\/main>/)?.[1] ?? ""

describe("LaTeX type detection", () => {
  it("recognises a document by \\documentclass or \\begin{document} at a line start", () => {
    expect(isLatexDocument("\\documentclass[sigconf]{acmart}\n")).toBe(true)
    expect(isLatexDocument("  \\begin{document}\nHi\n\\end{document}")).toBe(true)
    expect(isLatexDocument("Use `\\documentclass{article}` to start a paper.")).toBe(false)
    expect(isLatexDocument("# Title\n\nprose")).toBe(false)
  })
  it("a bundle is a paper when its entry is a .tex file", () => {
    expect(isLatexBundle({ entry: "/main.tex" })).toBe(true)
    expect(isLatexBundle({ entry: "/sec/Intro.TEX" })).toBe(true)
    expect(isLatexBundle({ entry: "/index.html" })).toBe(false)
  })
})

describe("renderLatex: the acmart sigconf sample", () => {
  const r = renderLatex(SIGCONF, null, { resolve, imageUrl })
  const body = r.body

  it("reads the class profile and the front matter", () => {
    expect(r.profile).toMatchObject({ kind: "acm", format: "sigconf", citeStyle: "authoryear" })
    expect(r.title).toBe("LumenField: Radiance Fields from a Single Photograph")
    expect(body).toContain('<h1 class="derive-title">LumenField: Radiance Fields')
    expect(body).toContain('<span class="derive-author-name">Ada Example</span>')
    expect(body).toContain('href="https://orcid.org/0000-0002-1825-0097"')
    expect(body).toContain('href="mailto:ada@example.edu"')
    // Accents in names resolve to characters.
    expect(body).toContain("François Müller")
    expect(body).toContain("Zürich")
    expect(body).toContain("Both authors contributed equally")
    expect(body).toContain(
      "SIGGRAPH &#39;26, July 2026, Vancouver, BC, Canada".replace("&#39;", "'"),
    )
    expect(body).toContain("https://doi.org/10.1145/0000000.0000000")
  })

  it("hoists the abstract, CCS concepts, keywords and teaser to \\maketitle, in that order", () => {
    const abstract = body.indexOf('<section class="derive-abstract">')
    const ccs = body.indexOf('<section class="derive-ccs">')
    const keywords = body.indexOf('<section class="derive-keywords">')
    const teaser = body.indexOf("derive-teaser")
    const intro = body.indexOf('<h2 id="introduction">')
    expect(abstract).toBeGreaterThan(body.indexOf("</header>"))
    expect(ccs).toBeGreaterThan(abstract)
    expect(keywords).toBeGreaterThan(ccs)
    expect(teaser).toBeGreaterThan(keywords)
    expect(intro).toBeGreaterThan(teaser)
  })

  it("builds CCS Concepts from \\ccsdesc only and drops the CCSXML block", () => {
    expect(body).toContain("• Computing methodologies → <strong>Rendering</strong>;")
    expect(body).toContain("• Computing methodologies → <em>Neural networks</em>;")
    expect(body).not.toContain("concept_id")
    expect(body).not.toContain("ccs2012")
  })

  it("numbers sections and appendices, with slugs the outline shares", () => {
    expect(body).toContain(
      '<h2 id="introduction"><span class="derive-secnum">1</span> Introduction</h2>',
    )
    expect(body).toContain(
      '<h3 id="predictor"><span class="derive-secnum">2.1</span> Predictor</h3>',
    )
    expect(body).toContain('<span class="derive-secnum">A</span> Implementation Details')
    expect(r.headings.map((h) => [h.level, h.slug, h.text])).toEqual([
      [2, "introduction", "1 Introduction"],
      [2, "method", "2 Method"],
      [3, "predictor", "2.1 Predictor"],
      [2, "results", "3 Results"],
      [2, "implementation-details", "A Implementation Details"],
    ])
    // Heading lines point at the sectioning macro in the source.
    expect(SIGCONF.split("\n")[(r.headings[0]?.line ?? 1) - 1]).toBe("\\section{Introduction}")
  })

  it("expands \\newcommand in prose and hands the definitions to the typesetter", () => {
    expect(body).toContain("LumenField removes both costs")
    expect(r.html).toContain('id="derive-latex-macros"')
    expect(r.html).toContain('"\\\\vect":"\\\\mathbf{#1}"')
  })

  it("keeps math as placeholders the client typesets, with equation numbers", () => {
    expect(body).toContain(
      '<span class="derive-math" data-derive-math="inline" data-tex="I"></span>',
    )
    expect(body).toContain('data-tex="\\sigma(\\vect{x})"')
    expect(body).toMatch(
      /<div class="derive-math-display" id="eq-1">.*<span class="derive-eqnum">\(1\)<\/span><\/div>/,
    )
    // align gets one number per line and the \label inside it is stripped from the TeX.
    expect(body).toContain('<span class="derive-eqnum">(2)–(3)</span>')
    expect(body).toContain("\\begin{aligned}")
    expect(body).not.toContain("\\label{eq:layer}")
    expect(r.hasMath).toBe(true)
    expect(r.html).toContain(`${KATEX_ASSET_BASE}/katex.min.js`)
    expect(r.html).toContain(`${KATEX_ASSET_BASE}/katex.min.css`)
  })

  it("resolves \\ref and \\eqref to numbered links, including forward references", () => {
    expect(body).toContain('As Figure&nbsp;<a class="derive-ref" href="#fig-1">1</a> shows')
    expect(body).toContain('(Section&nbsp;<a class="derive-ref" href="#method">2</a>)')
    expect(body).toContain('(Table&nbsp;<a class="derive-ref" href="#tab-1">1</a>)')
    expect(body).toContain('Equation&nbsp;<a class="derive-ref" href="#eq-1">(1)</a>')
    expect(body).toContain('<a class="derive-ref" href="#eq-3">(3)</a>')
    expect(body).toContain('<strong>Figure&nbsp;<a class="derive-ref" href="#fig-2">2</a></strong>')
  })

  it("renders author-year citations from the .bib and a sorted References section", () => {
    expect(body).toContain(
      '[<a class="derive-cite" href="#ref-mildenhall2020nerf">Mildenhall et al. 2020</a>]',
    )
    expect(body).toContain(
      '[<a class="derive-cite" href="#ref-mildenhall2020nerf">Mildenhall et al. 2020</a>; <a class="derive-cite" href="#ref-kerbl2023gaussians">Kerbl et al. 2023</a>]',
    )
    expect(body).toContain(
      'Kerbl et al. <a class="derive-cite" href="#ref-kerbl2023gaussians">[2023]</a>',
    )
    const refs = body.slice(body.indexOf('<section class="derive-references"'))
    expect(refs).toContain("<h2>References</h2>")
    expect(refs.indexOf('id="ref-kerbl2023gaussians"')).toBeLessThan(
      refs.indexOf('id="ref-mildenhall2020nerf"'),
    )
    expect(refs).toContain(
      "Bernhard Kerbl, Georgios Kopanas, Thomas Leimkühler, and George Drettakis. 2023. 3D Gaussian Splatting for Real-Time Radiance Field Rendering. <em>ACM Transactions on Graphics</em> 42, 4 (2023), 139:1–139:14.",
    )
    expect(refs).toContain('<a href="https://doi.org/10.1145/3592433">')
    // Only cited entries appear.
    expect(refs).not.toContain("pharr2016pbrt")
  })

  it("renders tables with the header above the first \\midrule and captions above", () => {
    const table = body.slice(body.indexOf('id="tab-1"'), body.indexOf('id="tab-2"'))
    expect(table.indexOf("<figcaption>")).toBeLessThan(table.indexOf("<table"))
    expect(table).toContain(
      '<span class="derive-caption-label">Table 1: </span>PSNR on three datasets.',
    )
    expect(table).toMatch(/<thead><tr[^>]*><th>Method<\/th><th align="center">LLFF<\/th>/)
    expect(table).toContain("<tbody>")
    expect(table).toContain('<td align="center"><strong>27.9</strong></td>')
    expect((table.match(/<tr/g) ?? []).length).toBe(4)
  })

  it("renders figures with the caption after the image and \\Description as alt only", () => {
    const teaser = body.slice(body.indexOf('id="fig-1"'), body.indexOf('<h2 id="introduction">'))
    expect(teaser.indexOf("<img")).toBeLessThan(teaser.indexOf("<figcaption>"))
    expect(teaser).toContain(
      'alt="A photograph of a room next to three rendered viewpoints of the same room."',
    )
    expect(teaser).toContain('style="width:100%"')
    expect(teaser).toContain('<span class="derive-caption-label">Figure 1: </span>')
    expect(pageText(teaser)).not.toContain("A photograph of a room")
  })

  it("binds \\derivetable and \\derivefigure to the dynamic-data markup", () => {
    expect(r.bindings.map((b) => [b.name, b.kind])).toEqual([
      ["ablation", "table"],
      ["qualitative", "figure"],
    ])
    expect(body).toContain(
      '<table data-derive-table="ablation" class="derive-tabular derive-dynamic">',
    )
    expect(body).toContain('<figure data-derive-figure="qualitative" class="derive-dynamic">')
    expect(body).toContain("No image yet")
    expect(latexDynamicBindings(SIGCONF).map((b) => b.name)).toEqual(["ablation", "qualitative"])
  })

  it("renders a slot's current value inside the bound element", () => {
    const dynamic = new Map()
    dynamic.set("ablation", {
      kind: "table",
      table: {
        columns: [{ key: "run" }, { key: "psnr", align: "right" }],
        rows: [{ run: "full", psnr: 27.9 }],
      },
    })
    dynamic.set("qualitative", {
      kind: "figure",
      figure: { url: `/blob/${"a".repeat(64)}.png`, caption: "Held-out scenes" },
    })
    const live = renderLatex(SIGCONF, null, { resolve, imageUrl, dynamic }).body
    expect(live).toContain(
      '<table data-derive-table="ablation" class="derive-tabular derive-dynamic"><thead><tr><th>run</th><th align="right">psnr</th></tr></thead><tbody><tr><td>full</td><td align="right">27.9</td></tr></tbody></table>',
    )
    expect(live).toContain(`<img src="/blob/${"a".repeat(64)}.png"`)
    expect(live).toContain("<figcaption>Held-out scenes</figcaption>")
  })

  it("handles ligatures, footnotes, theorems, lists and the acknowledgments", () => {
    expect(body).toContain("baselines — see")
    expect(body).toContain("“Quoted” text and a non-breaking&nbsp;space survive.")
    expect(body).toContain('<sup class="derive-footnote-mark">1</sup>')
    expect(body).toContain("We use the quadrature")
    expect(body).toContain('<span class="derive-theorem-head">Theorem 1 (Consistency).</span>')
    expect(body).toContain("<ul><li>a feed-forward predictor")
    expect(body).toContain('<h2 id="acknowledgments">Acknowledgments</h2>')
    expect(body).toContain("<em>fast</em>")
  })

  it("wraps the page in the document shell with the LaTeX stylesheet", () => {
    expect(r.html).toContain("<main data-derive-ready>")
    expect(r.html).toContain(
      '<article class="derive-paper derive-paper-acm" data-latex-class="acmart" data-latex-format="sigconf">',
    )
    expect(r.html).toContain(".derive-paper{")
    expect(r.html).toContain("<title>LumenField: Radiance Fields from a Single Photograph</title>")
    expect(bodyOf(r.html)).toBe(body)
  })

  it("has no diagnostics for a clean document, and TAPS advisories for tikz", () => {
    expect(r.diagnostics).toEqual([])
    expect(latexAdvisories(SIGCONF, { resolve, imageUrl })).toEqual([
      "\\usepackage{booktabs}: acmart already loads booktabs; remove the line before submitting to TAPS",
      "\\usepackage{tikz}: tikz is not on ACM TAPS's accepted package list",
    ])
    // Published as a single file, the same source cannot reach its .bib or figure.
    const alone = latexAdvisories(SIGCONF)
    const bibLine = SIGCONF.split("\n").findIndex((l) => l.startsWith("\\bibliography{")) + 1
    expect(alone).toContain(`latex: line ${bibLine}: refs.bib was not found in this artifact`)
    expect(alone.some((a) => a.includes("figures/teaser.png: figure not found"))).toBe(true)
  })
})

describe("renderLatex: the acmtog journal sample (anonymous, review)", () => {
  const r = renderLatex(ACMTOG, null, { resolve })
  const body = r.body

  it("hides the authors, shows the submission id and the review band", () => {
    expect(r.profile).toMatchObject({
      kind: "acm",
      format: "acmtog",
      journal: true,
      anonymous: true,
      review: true,
    })
    expect(body).toContain("Anonymous Author(s)")
    expect(body).not.toContain("Ada Example")
    expect(body).not.toContain("ada@example.edu")
    expect(body).toContain("Submission Id: papers_0042")
    expect(body).toContain(
      '<p class="derive-review-band">Unpublished working draft. Not for distribution.</p>',
    )
    expect(body).toContain(
      "ACM Trans. Graph., Vol. 45, No. 4, Article 88. Publication date: August 2026.",
    )
  })

  it("uses journal float labels and author-year citations by default", () => {
    expect(body).toContain('<span class="derive-caption-label">Fig. 1. </span>')
    expect(body).toContain(
      '[<a class="derive-cite" href="#ref-pharr2016pbrt">Pharr et al. 2016</a>]',
    )
    expect(body).toContain('<ul class="derive-reflist-unnumbered">')
  })

  it("drops acks and anonsuppress under anonymous and reports the missing figure", () => {
    expect(body).not.toContain("Hidden while anonymous")
    expect(body).not.toContain("names the authors")
    expect(body).toContain(
      '<span class="derive-figure-missing" role="img" aria-label="missing-figure">missing-figure</span>',
    )
    expect(r.diagnostics).toEqual([
      {
        code: "figure-path",
        message: "missing-figure: figure not found in this artifact",
        line: 36,
      },
    ])
  })

  it("shows the authors again without the anonymous option", () => {
    const named = renderLatex(ACMTOG.replace("[acmtog,anonymous,review]", "[acmtog]"), null, {
      resolve,
    }).body
    expect(named).toContain("Ada Example")
    expect(named).toContain("Hidden while anonymous")
    expect(named).not.toContain("derive-review-band")
  })
})

describe("renderLatex: the CVPR author kit sample", () => {
  const r = renderLatex(CVPR, null, { resolve })
  const body = r.body

  it("detects the class from \\usepackage{cvpr} and renders the review band", () => {
    expect(r.profile).toMatchObject({
      kind: "cvpr",
      review: true,
      citeStyle: "numeric",
      compressCitations: true,
      bibStyle: "ieeenat",
    })
    expect(body).toContain(
      "CVPR 2026 Submission #1234. CONFIDENTIAL REVIEW COPY. DO NOT DISTRIBUTE.",
    )
    expect(body).toContain("Anonymous CVPR submission")
    expect(body).not.toContain("firstauthor@i1.org")
  })

  it("renders sorted, compressed numeric citations and cleveref wording", () => {
    expect(body).toContain('[<a class="derive-cite" href="#ref-kerbl2023gaussians">1–3</a>]')
    expect(body).toContain('[<a class="derive-cite" href="#ref-example2025dataset">4</a>]')
    expect(body).toContain('<a class="derive-ref" href="#method">Section 2</a>')
    expect(body).toContain('<a class="derive-ref" href="#tab-1">Tab. 1</a>')
    expect(body).toContain('<a class="derive-ref" href="#fig-1">Fig. 1</a>')
    expect(body).toContain('<a class="derive-ref" href="#eq-1">Eq. (1)</a>')
    expect(body).toContain('<span class="derive-caption-label">Figure 1. </span>')
    expect(body).toContain('<span class="derive-caption-label">Table 1. </span>')
  })

  it("formats references in the ieeenat_fullname shape, numbered", () => {
    const refs = body.slice(body.indexOf('<section class="derive-references"'))
    expect(refs).toContain('<ol><li id="ref-kerbl2023gaussians" value="1">')
    expect(refs).toContain(
      "3D Gaussian Splatting for Real-Time Radiance Field Rendering. <em>ACM Transactions on Graphics</em>, 42(4):139:1–139:14, 2023.",
    )
    expect(refs).toContain(
      "In <em>European Conference on Computer Vision (ECCV)</em>, pages 405–421, 2020.",
    )
    expect(refs).toContain(
      "<em>Physically Based Rendering: From Theory to Implementation</em>. Morgan Kaufmann, 2016.",
    )
    expect(refs).toContain(
      "The Example Consortium. The Example Scenes Dataset. https://example.org/scenes, 2025.",
    )
  })

  it("shows the author block in final mode, one column per \\and", () => {
    const final = renderLatex(CVPR.replace("[review]{cvpr}", "[final]{cvpr}"), null, {
      resolve,
    }).body
    expect(final).not.toContain("CONFIDENTIAL")
    expect(final).toContain("First Author<br>")
    expect(final).toContain("firstauthor@i1.org")
    expect((final.match(/<div class="derive-author">/g) ?? []).length).toBe(2)
  })

  it("wraps a block-level {\\small ...} group in a div rather than an inline span", () => {
    expect(body).toContain('<div class="derive-small"><section class="derive-references"')
    expect(body).not.toContain("derive-unknown")
  })
})

describe("the text projection agrees with pageText of the rendered page", () => {
  it.each([
    ["sigconf", SIGCONF],
    ["acmtog", ACMTOG],
    ["cvpr", CVPR],
  ])("%s", (_name, source) => {
    const parts = latexTextParts(source, { resolve, imageUrl })
    const rendered = renderLatex(source, null, { resolve, imageUrl })
    expect(normWs(parts.text)).toBe(normWs(pageText(rendered.body)))
    // Text segments copy the source byte for byte; that is what makes a quote editable.
    for (const seg of parts.segments) {
      if (seg.kind === "text")
        expect(source.slice(seg.rStart, seg.rEnd)).toBe(parts.text.slice(seg.tStart, seg.tEnd))
      expect(seg.tEnd).toBeGreaterThanOrEqual(seg.tStart)
    }
    // Segments tile the text in order.
    let t = 0
    for (const seg of parts.segments) {
      expect(seg.tStart).toBe(t)
      t = seg.tEnd
    }
    expect(t).toBe(parts.text.length)
  })

  it("mirrors the block-element list pageText spaces on", () => {
    expect([...EMIT_BLOCK_ELEMENTS].sort()).toEqual([...ANCHOR_BLOCK_ELEMENTS].sort())
  })

  it("maps a prose quote back to its source span", () => {
    const parts = latexTextParts(SIGCONF)
    const quote = "a good field needs many photographs"
    const at = parts.text.indexOf(quote)
    expect(at).toBeGreaterThan(0)
    const seg = parts.segments.find((s) => s.tStart <= at && at < s.tEnd)
    expect(seg?.kind).toBe("text")
    if (!seg) return
    const rStart = seg.rStart + (at - seg.tStart)
    expect(SIGCONF.slice(rStart, rStart + quote.length)).toBe(quote)
  })

  it("attributes made-up text (a citation label) to the macro that produced it", () => {
    const parts = latexTextParts(SIGCONF, { resolve })
    const at = parts.text.indexOf("Mildenhall et al. 2020")
    const seg = parts.segments.find((s) => s.tStart <= at && at < s.tEnd)
    expect(seg?.kind).toBe("entity")
    if (!seg) return
    expect(SIGCONF.slice(seg.rStart, seg.rEnd)).toBe("\\cite{mildenhall2020nerf}")
  })
})

describe("renderLatex: fail-soft on unsupported and hostile input", () => {
  it("keeps the words of an unknown macro's braces and reports the macro once", () => {
    const r = renderLatex(
      "\\documentclass{article}\\begin{document}\\foo{kept} and \\foo{again}\\end{document}",
    )
    expect(r.body).toContain(
      '<p>kept and <span class="derive-unknown" data-latex-unknown="foo"></span>again</p>',
    )
    expect(r.diagnostics).toEqual([
      {
        code: "unknown-macro",
        message: "\\foo is not supported; its text is kept as written",
        line: 1,
      },
    ])
  })

  it("renders an unknown environment's body in a labelled div", () => {
    const r = renderLatex("\\begin{document}\\begin{mystery}inside\\end{mystery}\\end{document}")
    expect(r.body).toContain('<div class="derive-env derive-env-mystery"><p>inside</p></div>')
    expect(r.diagnostics[0]?.code).toBe("unknown-environment")
  })

  it("replaces a tikzpicture with a placeholder and a diagnostic", () => {
    const r = renderLatex(
      "\\begin{document}\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}\\end{document}",
    )
    expect(r.body).toContain("tikzpicture (not rendered in the browser)")
    expect(r.body).not.toContain("\\draw")
    expect(r.diagnostics[0]?.code).toBe("unsupported-tikz")
  })

  it("reports unresolved references and citations without breaking the page", () => {
    const r = renderLatex("\\begin{document}See \\ref{nope} and \\cite{ghost}.\\end{document}")
    expect(r.body).toContain("See ?? and [ghost?].")
    expect(r.diagnostics.map((d) => d.code).sort()).toEqual(["unresolved-cite", "unresolved-ref"])
  })

  it("survives unbalanced braces, stray \\end and unterminated math", () => {
    const hostile =
      "\\begin{document}}}{{\\section{Open\n$x = \\end{figure} \\begin{itemize}\\item a\\end{document}"
    const r = renderLatex(hostile)
    expect(r.html).toContain("<main data-derive-ready>")
    expect(r.body).toContain("Open")
    expect(r.diagnostics.length).toBeGreaterThan(0)
  })

  it("stops runaway macro recursion", () => {
    const r = renderLatex("\\newcommand{\\loop}{x\\loop}\\begin{document}\\loop\\end{document}")
    expect(r.body).toContain("x")
    expect(r.diagnostics.some((d) => d.code === "macro-recursion")).toBe(true)
  })

  it("escapes HTML in prose and attributes", () => {
    const r = renderLatex(
      '\\begin{document}<script>alert(1)</script> \\href{javascript:alert(1)}{click} \\includegraphics{"><img src=x onerror=alert(1)>}\\end{document}',
    )
    expect(r.body).not.toContain("<script>")
    expect(r.body).toContain("&lt;script&gt;")
    expect(r.body).toContain("<a>click</a>")
    expect(r.body).not.toMatch(/<img[^>]*onerror/)
    expect(r.body).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;")
  })

  it("resolves \\input from a bundle and attributes its text to the \\input macro", () => {
    const main =
      "\\documentclass{article}\\begin{document}\\section{A}\\input{sec/intro}\\end{document}"
    const files: Record<string, string> = { "sec/intro.tex": "Included \\emph{prose}." }
    const r = renderLatex(main, null, { resolve: (p) => files[p] ?? null })
    expect(r.body).toContain("<p>Included <em>prose</em>.</p>")
    const parts = latexTextParts(main)
    expect(parts.text).not.toContain("Included")
    const single = renderLatex(main)
    expect(single.diagnostics[0]?.code).toBe("unresolved-input")
  })

  it("prefers a compiled .bbl over formatting the .bib", () => {
    const main =
      "\\documentclass{article}\\begin{document}Cite \\cite{k}.\\bibliography{refs}\\end{document}"
    const bbl =
      "\\begin{thebibliography}{1}\\bibitem{k} Precompiled Entry. 2020.\\end{thebibliography}"
    const r = renderLatex(main, null, {
      resolve: (p) => (p === "main.bbl" ? bbl : p === "refs.bib" ? REFS : null),
    })
    expect(r.body).toContain("Precompiled Entry. 2020.")
    expect(r.body).toContain('[<a class="derive-cite" href="#ref-k">1</a>]')
    expect(r.body).not.toContain("Mildenhall")
  })

  it("pins the KaTeX version the head requests", () => {
    expect(KATEX_ASSET_BASE).toBe(`/raw/vendor/katex/${KATEX_VERSION}`)
    expect(renderLatex("\\begin{document}no math\\end{document}").html).not.toContain("katex")
  })
})
