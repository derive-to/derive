import { describe, expect, it } from "vitest"
import { normalizeLatexSource } from "./latex-import"

const enc = new TextEncoder()
const dec = new TextDecoder()
const DOC = "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n"
const bytes = (files: Record<string, string | Uint8Array>): Record<string, Uint8Array> =>
  Object.fromEntries(
    Object.entries(files).map(([p, v]) => [p, typeof v === "string" ? enc.encode(v) : v]),
  )

const ok = (files: Record<string, string | Uint8Array>) => {
  const r = normalizeLatexSource(bytes(files))
  if (!r.ok) throw new Error(`refused: ${r.code} ${r.detail}`)
  return r
}

describe("normalizeLatexSource", () => {
  it("unwraps a top-level directory, drops resource forks, keeps figures byte for byte", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00])
    const r = ok({
      "paper-v2/main.tex": DOC,
      "paper-v2/fig/a.png": png,
      "paper-v2/._main.tex": "junk",
      "__MACOSX/paper-v2/._fig": "junk",
    })
    expect(r.entry).toBe("/main.tex")
    expect(Object.keys(r.files).sort()).toEqual(["/fig/a.png", "/main.tex"])
    expect([...(r.files["/fig/a.png"] ?? [])]).toEqual([...png])
    expect(r.notes).toContain("unwrapped the top-level directory paper-v2/")
  })

  it("does not unwrap when a root file sits beside the directory", () => {
    const r = ok({ "main.tex": DOC, "sections/intro.tex": "Intro" })
    expect(Object.keys(r.files).sort()).toEqual(["/main.tex", "/sections/intro.tex"])
  })

  it("takes the entry the archive's 00README names, JSON or text", () => {
    const json = ok({
      "00README.json": JSON.stringify({
        sources: [
          { filename: "notes.tex", usage: "ignore" },
          { filename: "paper.tex", usage: "toplevel" },
        ],
      }),
      "paper.tex": DOC,
      "main.tex": DOC,
    })
    expect(json.entry).toBe("/paper.tex")
    expect(json.notes).toContain("entry paper.tex named by the archive's 00README")
    const text = ok({
      "00README.XXX": "notes.tex ignore\npaper.tex toplevelfile\n",
      "paper.tex": DOC,
      "main.tex": DOC,
    })
    expect(text.entry).toBe("/paper.tex")
  })

  it("prefers a root main.tex only when it is a document, else the document nobody inputs", () => {
    const chapter = ok({
      "main.tex": "\\section{Only a chapter}",
      "paper.tex": `\\documentclass{article}\n\\begin{document}\n\\input{main}\n\\end{document}`,
      "appendix.tex": DOC,
    })
    expect(chapter.entry).toBe("/paper.tex")
    expect(chapter.notes).toContain("entry paper.tex chosen by its \\documentclass")
    const nested = ok({
      "src/thesis.tex": `\\documentclass{book}\n\\begin{document}\n\\include{chapters/one}\n\\end{document}`,
      "src/chapters/one.tex": `\\documentclass{standalone}\n\\begin{document}x\\end{document}`,
    })
    expect(nested.entry).toBe("/thesis.tex")
  })

  it("drops a root index.html, SKILL.md or MANIFEST.md that would steal the entry", () => {
    const r = ok({ "index.html": "<h1>site</h1>", "MANIFEST.md": "# ctx", "main.tex": DOC })
    expect(Object.keys(r.files)).toEqual(["/main.tex"])
    expect(r.notes.some((n) => n.startsWith("dropped index.html"))).toBe(true)
  })

  it("refuses an archive with no LaTeX document", () => {
    expect(normalizeLatexSource(bytes({ "README.md": "hi", "fig.png": "x" }))).toEqual({
      ok: false,
      code: "no_tex",
      detail: "no .tex file",
    })
    const parts = normalizeLatexSource(bytes({ "intro.tex": "\\section{Intro}" }))
    expect(parts.ok).toBe(false)
  })

  it("copies the entry's .bbl to main.bbl and leaves an existing main.bbl alone", () => {
    const r = ok({
      "paper.tex": DOC,
      "paper.bbl": "\\begin{thebibliography}{1}\\end{thebibliography}",
    })
    expect(dec.decode(r.files["/main.bbl"])).toContain("thebibliography")
    expect(r.files["/paper.bbl"]).toBeDefined()
    const kept = ok({ "paper.tex": DOC, "paper.bbl": "theirs", "main.bbl": "mine" })
    expect(dec.decode(kept.files["/main.bbl"])).toBe("mine")
  })

  it("transcodes latin-1 text files when the entry declares inputenc latin1", () => {
    const latin = new Uint8Array([
      ...enc.encode("\\documentclass{article}\\usepackage[latin1]{inputenc}\\begin{document}caf"),
      0xe9,
      ...enc.encode("\\end{document}"),
    ])
    const png = new Uint8Array([0x89, 0xe9, 0xff])
    const r = ok({ "main.tex": latin, "refs.bib": new Uint8Array([0xe9]), "fig.png": png })
    expect(dec.decode(r.files["/main.tex"])).toContain("café")
    expect(dec.decode(r.files["/refs.bib"])).toBe("é")
    expect([...(r.files["/fig.png"] ?? [])]).toEqual([...png])
    expect(r.notes).toContain("transcoded the text files from latin-1 to UTF-8")
  })
})
