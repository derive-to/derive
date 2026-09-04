import { describe, expect, it } from "vitest"
import { type LatexNode, parseLatex, plainTextOf } from "./latex-parse"

const shape = (n: LatexNode): unknown => {
  switch (n.type) {
    case "text":
      return n.value
    case "par":
      return "¶"
    case "amp":
      return "&"
    case "group":
      return { group: n.body.map(shape) }
    case "macro":
      return {
        macro: n.name,
        ...(n.star ? { star: true } : {}),
        ...(n.opt ? { opt: n.opt.raw } : {}),
        ...(n.paren ? { paren: n.paren.raw } : {}),
        ...(n.args.length ? { args: n.args.map((a) => a.raw) } : {}),
        ...(n.def ? { def: n.def } : {}),
      }
    case "env":
      return {
        env: n.name,
        ...(n.opt ? { opt: n.opt.raw } : {}),
        ...(n.args.length ? { args: n.args.map((a) => a.raw) } : {}),
        body: n.body.map(shape),
      }
    case "math":
      return { math: n.tex, display: n.display, ...(n.env ? { env: n.env } : {}) }
    case "verbatim":
      return { verbatim: n.name, text: n.text }
  }
}

describe("parseLatex", () => {
  it("reads macros by their signature and leaves unknown macros argument-less", () => {
    const p = parseLatex("\\section*[short]{Title} \\emph{x} \\foo{kept} \\cmidrule(lr){2-3}")
    expect(p.nodes.map(shape)).toEqual([
      { macro: "section", star: true, opt: "short", args: ["Title"] },
      " ",
      { macro: "emph", args: ["x"] },
      " ",
      { macro: "foo" },
      { group: ["kept"] },
      " ",
      { macro: "cmidrule", paren: "lr", args: ["2-3"] },
    ])
  })

  it("keeps source offsets on every node", () => {
    const src = "Hello \\emph{world} $x^2$\n\nNext & more"
    const p = parseLatex(src)
    for (const n of p.nodes) expect(n.end).toBeGreaterThanOrEqual(n.start)
    const emph = p.nodes[1]
    expect(emph?.type).toBe("macro")
    expect(src.slice(emph?.start, emph?.end)).toBe("\\emph{world}")
    const math = p.nodes[3]
    expect(math?.type).toBe("math")
    expect(src.slice(math?.start, math?.end)).toBe("$x^2$")
    const par = p.nodes[4]
    expect(par?.type).toBe("par")
    expect(src.slice(par?.start, par?.end)).toBe("\n\n")
  })

  it("captures math in all four delimiters and math environments raw", () => {
    const p = parseLatex("$a$ \\(b\\) \\[c\\] $$d$$ \\begin{align}e &= f\\end{align}")
    expect(p.nodes.filter((n) => n.type === "math").map(shape)).toEqual([
      { math: "a", display: false },
      { math: "b", display: false },
      { math: "c", display: true },
      { math: "d", display: true },
      { math: "e &= f", display: true, env: "align" },
    ])
  })

  it("captures verbatim families raw, including a % that is not a comment", () => {
    const p = parseLatex(
      "\\verb|a % b| \\begin{lstlisting}[language=C]\nx = 1; % keep\n\\end{lstlisting} % comment\nafter",
    )
    expect(p.nodes.map(shape)).toEqual([
      { verbatim: "verb", text: "a % b" },
      " ",
      { verbatim: "lstlisting", text: "\nx = 1; % keep\n" },
      " ",
      "\nafter",
    ])
    const spec = parseLatex("\\begin{lstlisting}[language=C]\nx\n\\end{lstlisting}").nodes[0]
    expect(spec?.type === "verbatim" && spec.opt?.raw).toBe("language=C")
  })

  it("reads definitions with parameters and defaults", () => {
    const p = parseLatex(
      "\\newcommand{\\vect}[1]{\\mathbf{#1}}\\renewcommand*\\eg[2][x]{#1 #2}\\def\\conf#1{C#1}\\DeclareMathOperator{\\argmax}{arg\\,max}",
    )
    expect(p.nodes.map((n) => (n.type === "macro" ? n.def : null))).toEqual([
      { name: "vect", params: 1, defaultArg: null, body: "\\mathbf{#1}" },
      { name: "eg", params: 2, defaultArg: "x", body: "#1 #2" },
      { name: "conf", params: 1, defaultArg: null, body: "C#1" },
      { name: "argmax", params: 0, defaultArg: null, body: "arg\\,max" },
    ])
  })

  it("nests environments and records where the body ends", () => {
    const src =
      "\\begin{table}[t]\\caption{C}\\begin{tabular}{lr}a & b \\\\ c & d\\end{tabular}\\end{table}"
    const p = parseLatex(src)
    const table = p.nodes[0]
    expect(table?.type).toBe("env")
    if (table?.type !== "env") return
    expect(table.opt?.raw).toBe("t")
    expect(src.slice(table.bodyStart, table.bodyEnd)).toBe(
      "\\caption{C}\\begin{tabular}{lr}a & b \\\\ c & d\\end{tabular}",
    )
    const tabular = table.body[1]
    expect(tabular?.type === "env" && tabular.args[0]?.raw).toBe("lr")
    expect(tabular?.type === "env" && tabular.body.map(shape)).toEqual([
      "a ",
      "&",
      " b ",
      { macro: "\\" },
      " c ",
      "&",
      " d",
    ])
  })

  it("skips the space after a control word but keeps it after a group", () => {
    expect(parseLatex("\\LaTeX is \\emph{x} y").nodes.map(shape)).toEqual([
      { macro: "LaTeX" },
      "is ",
      { macro: "emph", args: ["x"] },
      " y",
    ])
  })

  it("never throws and reports diagnostics for broken input", () => {
    const cases = [
      "}",
      "{",
      "\\begin{figure}",
      "\\end{figure}",
      "\\begin{a}\\end{b}",
      "$x",
      "\\begin{verbatim}open",
      "\\section{",
      "\\",
      "\\newcommand",
      "{".repeat(600) + "}".repeat(600),
    ]
    for (const src of cases) {
      const p = parseLatex(src)
      expect(p.nodes).toBeDefined()
    }
    expect(parseLatex("}").diagnostics[0]?.code).toBe("stray-brace")
    expect(parseLatex("\\begin{figure}").diagnostics[0]?.code).toBe("unterminated-environment")
    expect(parseLatex("\\end{figure}").diagnostics[0]?.code).toBe("stray-end")
    expect(parseLatex("\\begin{a}x\\end{b}").diagnostics[0]?.code).toBe("mismatched-environment")
    expect(parseLatex("$x").diagnostics[0]?.code).toBe("unterminated-math")
    expect(
      parseLatex("{".repeat(600)).diagnostics.some((d) => d.code === "unterminated-group"),
    ).toBe(true)
  })

  it("treats a blank line as a paragraph break and single newlines as text", () => {
    expect(parseLatex("a\nb\n\n  \nc").nodes.map(shape)).toEqual(["a\nb", "¶", "c"])
  })

  it("plainTextOf flattens nodes for labels and ids", () => {
    expect(plainTextOf(parseLatex("A \\emph{b} {c} $d$ \\\\ e").nodes)).toBe("A b c d e")
  })
})
