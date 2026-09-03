import { describe, expect, it } from "vitest"
import {
  authorListText,
  authorYearLabel,
  parseAuthors,
  parseBibtex,
  referenceParts,
  sortBibEntries,
} from "./bibtex"
import { latexToText } from "./latex-chars"

const text = (e: Parameters<typeof referenceParts>[0], style: "acm" | "ieeenat" | "plain") =>
  referenceParts(e, style)
    .map((p) => p.text)
    .join("")

describe("parseBibtex", () => {
  it("reads brace, quote and bare values, @string concatenation and months", () => {
    const bib = `
@string{acm = "ACM"}
@STRING{tog = acm # " Transactions on Graphics"}
@Article{key1,
  author = {Doe, Jane and John Q. Public},
  title = "A {Title} with \\"Quotes\\"",
  journal = tog,
  year = 2024,
  month = aug,
  volume = {43}
}
@comment{ignored {nested} braces }
@preamble{"\\newcommand{\\noop}[1]{#1}"}
`
    const p = parseBibtex(bib)
    expect(p.diagnostics).toEqual([])
    expect(p.strings).toEqual({ acm: "ACM", tog: "ACM Transactions on Graphics" })
    expect(p.preambles).toEqual(["\\newcommand{\\noop}[1]{#1}"])
    expect(p.entries).toHaveLength(1)
    const e = p.entries[0]
    expect(e?.type).toBe("article")
    expect(e?.key).toBe("key1")
    expect(e?.fields).toMatchObject({
      author: "Doe, Jane and John Q. Public",
      title: 'A {Title} with \\"Quotes\\"',
      journal: "ACM Transactions on Graphics",
      year: "2024",
      month: "August",
      volume: "43",
    })
  })

  it("accepts parenthesised entries and keeps going after a broken one", () => {
    const bib = `@misc(paren, title = {P}, year = 2020)
@book{broken, title = {No closing brace
@article{after, title = {After}, year = {2021}}`
    const p = parseBibtex(bib)
    expect(p.entries.map((e) => e.key)).toEqual(["paren", "after"])
    expect(p.diagnostics.map((d) => d.code)).toContain("malformed-field")
  })

  it("reports duplicate keys and unknown strings", () => {
    const p = parseBibtex("@misc{a, title={x}}\n@misc{a, title={y}}\n@misc{b, journal = nope}")
    expect(p.entries.map((e) => e.key)).toEqual(["a", "b"])
    expect(p.diagnostics.map((d) => d.code)).toEqual(["duplicate-key", "unknown-string"])
    expect(p.entries[1]?.fields.journal).toBe("nope")
  })

  it("never throws on hostile input", () => {
    for (const s of [
      "@",
      "@{",
      "@article{",
      "@article{k,",
      '@article{k, t = "',
      "@string{",
      "{{{{",
      "@article{k, t = {a} # }",
    ])
      expect(() => parseBibtex(s)).not.toThrow()
  })
})

describe("parseAuthors", () => {
  it("splits the three BibTeX name forms and corporate names", () => {
    const authors = parseAuthors(
      "Ludwig van Beethoven and de la Cruz, Jr., Juan and {The Example Consortium} and Kerbl, Bernhard and others",
    )
    expect(authors.map((a) => [a.first, a.von, a.last, a.jr, a.others])).toEqual([
      ["Ludwig", "van", "Beethoven", "", false],
      ["Juan", "de la", "Cruz", "Jr.", false],
      ["", "", "The Example Consortium", "", false],
      ["Bernhard", "", "Kerbl", "", false],
      ["", "", "", "", true],
    ])
    expect(authorListText(authors)).toBe(
      "Ludwig van Beethoven, Juan de la Cruz, Jr., The Example Consortium, Bernhard Kerbl et al.",
    )
  })

  it("resolves accents in names", () => {
    const [a] = parseAuthors('Leimk{\\"u}hler, Thomas')
    expect(a?.last).toBe("Leimkühler")
    expect(a?.first).toBe("Thomas")
    const [b] = parseAuthors('Fran\\c{c}ois M\\"uller')
    expect(b?.first).toBe("François")
    expect(b?.last).toBe("Müller")
  })

  it("joins two and three authors the way both styles print them", () => {
    expect(authorListText(parseAuthors("A One and B Two"))).toBe("A One and B Two")
    expect(authorListText(parseAuthors("A One and B Two and C Three"))).toBe(
      "A One, B Two, and C Three",
    )
  })
})

describe("latexToText", () => {
  it("turns accents, symbols, ligatures and braces into plain text", () => {
    expect(latexToText("{\\'E}cole---``quoted'' \\& co.~\\LaTeX{} \\textbf{bold} $x^2$")).toBe(
      "École—“quoted” & co.\u00a0LaTeX bold x^2",
    )
    expect(latexToText("\\v{s}\\H{o}\\c{c}\\.{z}\\={a}\\u{a}\\r{a}\\k{e}")).toBe("šőçżāăåę")
    expect(latexToText("\\'{\\i}")).toBe("í")
  })
})

describe("referenceParts", () => {
  const entries = parseBibtex(`
@inproceedings{nerf, author = {Ben Mildenhall and Ren Ng}, title = {{NeRF}: Scenes}, booktitle = {ECCV}, year = 2020, pages = {405--421}, doi = {10.1007/x}}
@article{gs, author = {Kerbl, Bernhard}, title = {Splatting}, journal = {ACM TOG}, volume = 42, number = 4, pages = {1--14}, year = 2023}
@book{pbrt, author = {Matt Pharr}, title = {PBRT}, publisher = {MK}, year = 2016}
@phdthesis{thesis, author = {Ada Example}, title = {On Light}, school = {ETH}, year = 2019}
@misc{web, title = {A Page}, howpublished = {\\url{https://example.org}}, year = 2025, url = {https://example.org}}
`).entries
  const byKey = Object.fromEntries(entries.map((e) => [e.key, e]))

  it("approximates ACM-Reference-Format", () => {
    expect(text(byKey.nerf as never, "acm")).toBe(
      "Ben Mildenhall and Ren Ng. 2020. NeRF: Scenes. In ECCV. 405–421. https://doi.org/10.1007/x",
    )
    expect(text(byKey.gs as never, "acm")).toBe(
      "Bernhard Kerbl. 2023. Splatting. ACM TOG 42, 4 (2023), 1–14. ",
    )
    expect(text(byKey.pbrt as never, "acm")).toBe("Matt Pharr. 2016. PBRT. MK. ")
    expect(text(byKey.thesis as never, "acm")).toBe(
      "Ada Example. 2019. On Light. Ph.D. Dissertation. ETH. ",
    )
    expect(referenceParts(byKey.nerf as never, "acm").find((p) => p.italic)?.text).toBe("ECCV")
  })

  it("approximates ieeenat_fullname", () => {
    expect(text(byKey.nerf as never, "ieeenat")).toBe(
      "Ben Mildenhall and Ren Ng. NeRF: Scenes. In ECCV, pages 405–421, 2020.",
    )
    expect(text(byKey.gs as never, "ieeenat")).toBe(
      "Bernhard Kerbl. Splatting. ACM TOG, 42(4):1–14, 2023.",
    )
    expect(text(byKey.pbrt as never, "ieeenat")).toBe("Matt Pharr. PBRT. MK, 2016.")
    expect(text(byKey.thesis as never, "ieeenat")).toBe(
      "Ada Example. On Light. PhD thesis, ETH, 2019.",
    )
    expect(text(byKey.web as never, "ieeenat")).toBe(
      "Anonymous. A Page. https://example.org, 2025. https://example.org",
    )
  })

  it("builds author-year labels and sorts alphabetically by first author", () => {
    expect(authorYearLabel(byKey.nerf as never)).toEqual({
      authors: "Mildenhall and Ng",
      year: "2020",
    })
    expect(authorYearLabel(byKey.gs as never)).toEqual({ authors: "Kerbl", year: "2023" })
    const three = parseBibtex("@misc{t, author={A One and B Two and C Three}, year=2001}")
      .entries[0]
    expect(authorYearLabel(three as never)).toEqual({ authors: "One et al.", year: "2001" })
    expect(sortBibEntries(entries).map((e) => e.key)).toEqual([
      "web",
      "thesis",
      "gs",
      "nerf",
      "pbrt",
    ])
  })
})
