import { describe, expect, it } from "vitest"
import { DERIVE_STY, dynamicTableTex, injectDerivePackage } from "./latex-dynamic"
import { blobRefsIn, planLatexExport } from "./latex-export"
import { CVPR_KIT_FILES, latexTemplate, latexTemplateSummaries } from "./latex-templates"

const SHA_A = "a".repeat(64)
const SHA_B = "b".repeat(64)
const PNG = Uint8Array.from([137, 80, 78, 71])

const meta = {
  title: "Paper",
  shortId: "abc12345",
  version: 3,
  url: "https://derive.test/artifacts/paper-abc12345",
  exportedAt: "2026-09-03T12:00:00Z",
}

const text = (files: Record<string, string | Uint8Array>, path: string): string => {
  const f = files[path]
  if (typeof f !== "string") throw new Error(`${path} is not text`)
  return f
}

describe("planLatexExport", () => {
  const main = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\begin{table}\\caption{R}\\derivetable{results}\\end{table}",
    "\\begin{figure}\\derivefigure[width=\\linewidth]{teaser}\\caption{T}\\end{figure}",
    `\\includegraphics[width=3cm]{/blob/${SHA_A}.png}`,
    "\\end{document}",
    "",
  ].join("\n")

  it("writes derive.sty, the fragments and the README, and injects the package once", () => {
    const plan = planLatexExport({
      entry: "main.tex",
      files: { "main.tex": main },
      slots: {
        results: {
          kind: "table",
          table: {
            columns: [{ key: "model" }, { key: "psnr", align: "right" }],
            rows: [{ model: "ours", psnr: 28.6 }],
          },
        },
        teaser: { kind: "figure", figure: { url: `/blob/${SHA_B}.jpg` } },
      },
      slotRevisions: { results: 4, teaser: 1 },
      blobs: { [SHA_A]: { bytes: PNG, ext: "png" }, [SHA_B]: { bytes: PNG, ext: "jpg" } },
      meta,
    })
    expect(Object.keys(plan.files).sort()).toEqual([
      "README-derive.md",
      "derive-dynamic/results.tex",
      "derive-dynamic/teaser.jpg",
      "derive-dynamic/teaser.tex",
      "derive.sty",
      `figures/${SHA_A}.png`,
      "main.tex",
    ])
    expect(plan.files["derive.sty"]).toBe(DERIVE_STY)
    const entry = text(plan.files, "main.tex")
    expect(entry).toContain("\\documentclass{article}\n\\usepackage{derive}")
    expect(entry).toContain(`\\includegraphics[width=3cm]{figures/${SHA_A}.png}`)
    expect(entry).not.toContain("/blob/")
    expect(text(plan.files, "derive-dynamic/results.tex")).toBe(
      "\\begin{tabular}{lr}\n\\toprule\nmodel & psnr \\\\\n\\midrule\nours & 28.6 \\\\\n\\bottomrule\n\\end{tabular}\n",
    )
    expect(text(plan.files, "derive-dynamic/teaser.tex")).toBe(
      "\\expandafter\\includegraphics\\expandafter[\\derivefigopts]{derive-dynamic/teaser.jpg}\n",
    )
    expect(plan.files["derive-dynamic/teaser.jpg"]).toBe(PNG)
    expect(plan.notes).toEqual([])
    const readme = text(plan.files, "README-derive.md")
    expect(readme).toContain("version 3")
    expect(readme).toContain("| `results` | table | 4 |")
    expect(readme).toContain("| `teaser` | figure | 1 |")
    expect(readme).toContain("Overleaf")
    // Idempotent on the entry: exporting the export injects nothing twice.
    expect(injectDerivePackage(entry, true)).toBe(entry)
  })

  it("prints placeholders and notes for slots without data and figures it cannot bundle", () => {
    const plan = planLatexExport({
      entry: "main.tex",
      files: { "main.tex": main },
      slots: { teaser: { kind: "figure", figure: { url: "https://example.org/pic.png" } } },
      blobs: {},
      meta,
    })
    expect(text(plan.files, "derive-dynamic/results.tex")).toBe("\\derivemissing{results}\n")
    expect(text(plan.files, "derive-dynamic/teaser.tex")).toBe("\\derivemissing{teaser}\n")
    expect(text(plan.files, "main.tex")).toContain(`{/blob/${SHA_A}.png}`)
    expect(plan.notes).toEqual([
      'Dynamic table "results" has no data yet; the paper prints a placeholder box.',
      'Dynamic figure "teaser" points at an external URL (https://example.org/pic.png); download it and reference it with \\includegraphics.',
      `main.tex: the figure ${SHA_A.slice(0, 12)}… could not be read; its \\includegraphics still points at the Derive URL.`,
    ])
    expect(text(plan.files, "README-derive.md")).toContain("## Before you compile")
  })

  it("warns about image formats pdfLaTeX cannot read", () => {
    const plan = planLatexExport({
      entry: "main.tex",
      files: { "main.tex": "\\begin{document}\\derivefigure{teaser}\\end{document}" },
      slots: { teaser: { kind: "figure", figure: { url: `/blob/${SHA_B}.webp` } } },
      blobs: { [SHA_B]: { bytes: PNG, ext: "webp" } },
      meta,
    })
    expect(plan.notes).toEqual([
      'Dynamic figure "teaser" is a .webp file; pdfLaTeX reads PNG, JPEG and PDF, so convert derive-dynamic/teaser.webp before compiling.',
    ])
  })

  it("finds bindings in \\input files and keeps every bundle file", () => {
    const plan = planLatexExport({
      entry: "main.tex",
      files: {
        "main.tex": "\\documentclass{article}\\begin{document}\\input{sec/results}\\end{document}",
        "sec/results.tex": "\\derivetable{results}",
        "refs.bib": "@misc{k}",
        "fig/a.png": PNG,
      },
      slots: { results: { kind: "table", table: { columns: [{ key: "a" }], rows: [] } } },
      blobs: {},
      meta,
    })
    expect(text(plan.files, "main.tex")).toContain("\\usepackage{derive}")
    expect(plan.files["refs.bib"]).toBe("@misc{k}")
    expect(plan.files["fig/a.png"]).toBe(PNG)
    expect(text(plan.files, "derive-dynamic/results.tex")).toBe(
      dynamicTableTex({ columns: [{ key: "a" }], rows: [] }),
    )
  })

  it("leaves a paper without bindings alone apart from the README", () => {
    const plan = planLatexExport({
      entry: "main.tex",
      files: { "main.tex": "\\documentclass{article}\\begin{document}x\\end{document}" },
      slots: {},
      blobs: {},
      meta,
    })
    expect(Object.keys(plan.files).sort()).toEqual(["README-derive.md", "main.tex"])
    expect(text(plan.files, "main.tex")).not.toContain("derive")
    expect(text(plan.files, "README-derive.md")).not.toContain("Dynamic tables")
  })

  it("notes the CVPR kit files a bundle lacks", () => {
    const plan = planLatexExport({
      entry: "main.tex",
      files: { "main.tex": latexTemplate("cvpr").files["main.tex"] as string },
      slots: {},
      blobs: {},
      meta,
    })
    expect(plan.notes.some((n) => n.includes("cvpr.sty"))).toBe(true)
    expect(plan.notes.some((n) => n.includes("ieeenat_fullname.bst"))).toBe(true)
    const withKit = planLatexExport({
      entry: "main.tex",
      files: {
        "main.tex": latexTemplate("cvpr").files["main.tex"] as string,
        "cvpr.sty": "% kit",
        "ieeenat_fullname.bst": "% kit",
      },
      slots: {},
      blobs: {},
      meta,
    })
    expect(withKit.notes.filter((n) => n.includes("kit"))).toEqual([])
  })

  it("collects blob references from text", () => {
    expect(
      blobRefsIn(`\\includegraphics{/blob/${SHA_A}.png} and https://x.test/blob/${SHA_B}`),
    ).toEqual([
      { sha: SHA_A, ext: "png" },
      { sha: SHA_B, ext: null },
    ])
  })
})

describe("the paper starters", () => {
  it("list two templates whose files carry the contract the generator guards", () => {
    expect(latexTemplateSummaries().map((t) => t.id)).toEqual(["acm-siggraph", "cvpr"])
    for (const id of ["acm-siggraph", "cvpr"] as const) {
      const t = latexTemplate(id)
      expect(t.entry).toBe("main.tex")
      const main = t.files["main.tex"] as string
      expect(main).toContain("\\usepackage{derive}")
      expect(main).toMatch(/\\derivetable(\[[^\]]*\])?\{results\}/)
      expect(main).toMatch(/\\derivefigure(\[[^\]]*\])?\{teaser\}/)
      expect(t.files["derive.sty"]).toBe(DERIVE_STY)
      // The starters ship no README: the export writes README-derive.md, and the web bar
      // hides a root README on papers.
      expect(t.files["README.md"]).toBeUndefined()
    }
    expect(latexTemplate("acm-siggraph").files["references.bib"]).toContain("@inproceedings")
    expect(latexTemplate("cvpr").files["main.bib"]).toContain("@inproceedings")
  })

  it("pins the CVPR kit files to a commit with their hashes", () => {
    expect(CVPR_KIT_FILES.map((f) => f.path)).toEqual(["cvpr.sty", "ieeenat_fullname.bst"])
    for (const f of CVPR_KIT_FILES) {
      expect(f.url).toMatch(
        /^https:\/\/raw\.githubusercontent\.com\/cvpr-org\/author-kit\/[0-9a-f]{40}\//,
      )
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})
