/**
 * Dynamic tables and figures as LaTeX: the `derive.sty` package a source export ships,
 * the `\derivetable{name}` / `\derivefigure{name}` bindings a document declares, and the
 * TeX fragments the exporter writes for each slot so the paper compiles with the data
 * the version currently holds. Shared by the HTML renderer (which reads the bindings)
 * and the source zip (which writes the fragments).
 *
 * In real TeX the macros resolve to `derive-dynamic/<name>.tex`; a missing fragment
 * typesets a framed "no data yet" box rather than stopping the run, mirroring the empty
 * placeholder the web page shows for an unfilled slot.
 */

import { DERIVE_STY } from "./derive-sty.gen"
import type { DynamicTableLike } from "./latex-emit"
import { type MacroNode, parseLatex } from "./latex-parse"

/** The package text written to `derive.sty` in a source export and shipped in every paper
 *  starter. Canonical source: packages/core/src/latex-templates/derive.sty, mirrored here
 *  by scripts/gen-latex-templates.mjs. */
export { DERIVE_STY }

/** Escape text for a LaTeX body: the ten special characters, in an order that never
 *  re-escapes its own output. */
export const escapeLatex = (s: string): string =>
  s
    .replace(/\\/g, "@@bs@@")
    .replace(/([{}$&#%_])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/@@bs@@/g, "\\textbackslash{}")

const cellTex = (v: string | number | null): string =>
  v === null || v === undefined ? "--" : escapeLatex(String(v))

/** A booktabs tabular for the table's current value. Column alignment follows `align`
 *  (left by default), so the fragment reads like a hand-written table. */
export const dynamicTableTex = (table: DynamicTableLike): string => {
  const spec = table.columns
    .map((c) => (c.align === "right" ? "r" : c.align === "center" ? "c" : "l"))
    .join("")
  const head = table.columns.map((c) => escapeLatex(c.label ?? c.key)).join(" & ")
  const rows = table.rows.map((row) =>
    table.columns.map((c) => cellTex(row[c.key] ?? null)).join(" & "),
  )
  const lines = [
    `\\begin{tabular}{${spec || "l"}}`,
    "\\toprule",
    `${head} \\\\`,
    "\\midrule",
    ...rows.map((r) => `${r} \\\\`),
    "\\bottomrule",
    "\\end{tabular}",
  ]
  return `${lines.join("\n")}\n`
}

/** The fragment for a figure slot: `\includegraphics` of the exported image file with
 *  the options `\derivefigure[...]` set, or the missing-data box when the slot has no
 *  image yet (`file` null). `file` is the exported path relative to the project root. */
export const dynamicFigureTex = (file: string | null, name: string): string => {
  if (!file) return `\\derivemissing{${escapeLatex(name)}}\n`
  // \expandafter feeds the stored options to \includegraphics as if typed in brackets.
  return `\\expandafter\\includegraphics\\expandafter[\\derivefigopts]{${file}}\n`
}

export interface LatexBinding {
  name: string
  kind: "table" | "figure"
  start: number
  end: number
}

const BINDING_MACROS: Record<string, "table" | "figure"> = {
  derivetable: "table",
  derivefigure: "figure",
}

/** Every `\derivetable{name}` / `\derivefigure{name}` in the source, in order, including
 *  those inside floats and groups but not inside comments, verbatim or math. Names are
 *  returned as written; the caller validates them against the slot grammar. */
export const latexDynamicBindings = (source: string): LatexBinding[] => {
  const out: LatexBinding[] = []
  const visit = (nodes: ReturnType<typeof parseLatex>["nodes"]) => {
    for (const n of nodes) {
      if (n.type === "macro") {
        const kind = BINDING_MACROS[n.name]
        if (kind) {
          const name = bindingName(n)
          if (name) out.push({ name, kind, start: n.start, end: n.end })
        }
        for (const a of n.args) visit(a.nodes)
        if (n.opt) visit(n.opt.nodes)
      } else if (n.type === "group") visit(n.body)
      else if (n.type === "env") {
        for (const a of n.args) visit(a.nodes)
        visit(n.body)
      }
    }
  }
  visit(parseLatex(source).nodes)
  return out
}

export const bindingName = (macro: MacroNode): string | null => {
  const arg = macro.args[0]
  if (!arg) return null
  const name = arg.raw.trim()
  return name || null
}

const DOCUMENTCLASS = /^[ \t]*\\documentclass(?:\[[^\]]*\])?\{[^}]*\}[^\n]*/m
const HAS_DERIVE = /^[ \t]*\\usepackage(?:\[[^\]]*\])?\{[^}]*\bderive\b[^}]*\}/m

/** Add `\usepackage{derive}` after `\documentclass` when the document binds dynamic data
 *  and does not load the package already. Idempotent; a document without bindings is
 *  returned unchanged so an export never edits what it does not need to. `force` skips the
 *  bindings check for an entry whose bindings live in the files it `\input`s. */
export const injectDerivePackage = (source: string, force = false): string => {
  if (!force && !latexDynamicBindings(source).length) return source
  if (HAS_DERIVE.test(source)) return source
  const m = DOCUMENTCLASS.exec(source)
  if (!m || m.index === undefined) return `\\usepackage{derive}\n${source}`
  const at = m.index + m[0].length
  return `${source.slice(0, at)}\n\\usepackage{derive}${source.slice(at)}`
}
