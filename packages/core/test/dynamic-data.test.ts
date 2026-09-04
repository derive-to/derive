import { describe, expect, it } from "vitest"
import {
  applyDynamicBindings,
  applyDynamicPatch,
  DYNAMIC_DATA_CLIENT_JS,
  DYNAMIC_MAX_SLOTS,
  DYNAMIC_NAME_PATTERN,
  type DynamicValue,
  emptyDynamicValue,
  isDynamicName,
  parseDynamicBindings,
  renderDynamicValue,
  validateDynamicValue,
} from "../src"

const results = (rows: Record<string, string | number | null>[], key?: string): DynamicValue => ({
  kind: "table",
  table: {
    columns: [
      { key: "model", label: "Model" },
      { key: "acc", label: "Acc", align: "right" },
    ],
    rows,
    ...(key ? { key } : {}),
  },
})

const tableOf = (value: DynamicValue | string) => {
  if (typeof value === "string" || value.kind !== "table") throw new Error(String(value))
  return value.table
}

describe("dynamic data contract", () => {
  it("keeps the name grammar and caps explicit", () => {
    expect(DYNAMIC_NAME_PATTERN).toBe("^[a-z0-9][a-z0-9-]{0,63}$")
    expect(isDynamicName("results")).toBe(true)
    expect(isDynamicName("ablation-2")).toBe(true)
    expect(isDynamicName("Results")).toBe(false)
    expect(isDynamicName("-x")).toBe(false)
    expect(DYNAMIC_MAX_SLOTS).toBe(32)
  })

  it("validates values and drops what it does not know", () => {
    expect(
      validateDynamicValue({ kind: "table", table: { columns: [{ key: "a" }], rows: [{ b: 1 }] } }),
    ).toBe('row references undeclared column "b"')
    expect(
      validateDynamicValue({ kind: "figure", figure: { url: "javascript:alert(1)" } }),
    ).toMatch(/figure url/)
    const ok = validateDynamicValue({
      kind: "figure",
      figure: { url: `/blob/${"a".repeat(64)}.png`, caption: "Teaser", extra: true },
    })
    expect(ok).toEqual({
      kind: "figure",
      figure: { url: `/blob/${"a".repeat(64)}.png`, caption: "Teaser" },
    })
    expect(emptyDynamicValue("figure")).toEqual({ kind: "figure", figure: { url: null } })
  })
})

describe("applyDynamicPatch", () => {
  const seeded = results(
    [
      { model: "base", acc: null },
      { model: "ours", acc: null },
    ],
    "model",
  )

  it("addresses rows by the key column and applies a batch atomically", () => {
    const next = tableOf(
      applyDynamicPatch(seeded, {
        kind: "table",
        cells: [{ row: "ours", col: "acc", value: 0.91 }],
        delete_rows: ["base"],
        append_rows: [{ model: "big", acc: 0.95 }],
      }),
    )
    expect(next.rows).toEqual([
      { model: "ours", acc: 0.91 },
      { model: "big", acc: 0.95 },
    ])
    expect(next.key).toBe("model")
  })

  it("refuses ambiguity and unknown addresses instead of guessing", () => {
    const dup = results(
      [
        { model: "x", acc: 1 },
        { model: "x", acc: 2 },
      ],
      "model",
    )
    expect(
      applyDynamicPatch(dup, { kind: "table", cells: [{ row: "x", col: "acc", value: 3 }] }),
    ).toMatch(/refusing to guess/)
    expect(
      applyDynamicPatch(seeded, { kind: "table", cells: [{ row: "nope", col: "acc", value: 1 }] }),
    ).toMatch(/no row where model/)
    expect(
      applyDynamicPatch(seeded, { kind: "table", cells: [{ row: "ours", col: "f1", value: 1 }] }),
    ).toBe('unknown column "f1"')
    expect(applyDynamicPatch(seeded, { kind: "table" })).toBe("an empty patch changes nothing")
    expect(applyDynamicPatch(seeded, { kind: "figure", figure: {} })).toMatch(/is a table/)
  })

  it("addresses rows by index when the table declares no key, against the pre-batch table", () => {
    const indexed = results([
      { model: "a", acc: 1 },
      { model: "b", acc: 2 },
    ])
    const next = tableOf(
      applyDynamicPatch(indexed, {
        kind: "table",
        cells: [{ row: 1, col: "acc", value: 20 }],
        delete_rows: [0],
        append_rows: [{ model: "c", acc: 3 }],
      }),
    )
    expect(next.rows).toEqual([
      { model: "b", acc: 20 },
      { model: "c", acc: 3 },
    ])
    expect(
      applyDynamicPatch(indexed, { kind: "table", cells: [{ row: 2, col: "acc", value: 0 }] }),
    ).toMatch(/out of range/)
  })

  it("merges a figure patch shallowly and re-validates", () => {
    const figure: DynamicValue = { kind: "figure", figure: { url: null, caption: "Ablation" } }
    const url = `/blob/${"b".repeat(64)}.png`
    expect(applyDynamicPatch(figure, { kind: "figure", figure: { url } })).toEqual({
      kind: "figure",
      figure: { url, caption: "Ablation" },
    })
    expect(applyDynamicPatch(figure, { kind: "figure", figure: { url: "ftp://x" } })).toMatch(
      /figure url/,
    )
  })
})

describe("parseDynamicBindings", () => {
  it("reads markdown fences with pipe-table and JSON seeds, first name wins", () => {
    const md = [
      "# Results",
      "",
      "```derive-table results",
      "| Model | Acc |",
      "| --- | ---: |",
      "| base | -- |",
      "| ours | 0.9 |",
      "```",
      "",
      "```derive-figure ablation",
      '{"caption":"Ablation study"}',
      "```",
      "",
      "```derive-table results",
      "| Other | x |",
      "| --- | --- |",
      "```",
      "",
      "````markdown",
      "```derive-table nested",
      "| a |",
      "| - |",
      "```",
      "````",
      "",
      "```derive-table Bad_Name",
      "| a |",
      "| - |",
      "```",
    ].join("\n")
    const { bindings, advisories } = parseDynamicBindings(md, "text/markdown; charset=utf-8")
    expect(bindings.map((b) => `${b.kind}:${b.name}`)).toEqual(["table:results", "figure:ablation"])
    const seed = bindings[0]?.seed
    expect(seed && seed.kind === "table" ? seed.table : null).toEqual({
      columns: [
        { key: "model", label: "Model" },
        { key: "acc", label: "Acc", align: "right" },
      ],
      rows: [
        { model: "base", acc: null },
        { model: "ours", acc: 0.9 },
      ],
    })
    expect(bindings[1]?.seed).toEqual({
      kind: "figure",
      figure: { url: null, caption: "Ablation study" },
    })
    expect(advisories).toEqual([
      'Dynamic table "Bad_Name" was ignored: names are lowercase letters, digits and dashes.',
    ])
  })

  it("keeps a binding whose seed is unusable and says why", () => {
    const { bindings, advisories } = parseDynamicBindings(
      "```derive-figure hero\nnot json\n```",
      "text/markdown",
    )
    expect(bindings).toEqual([{ name: "hero", kind: "figure", seed: null }])
    expect(advisories[0]).toMatch(/seeds empty/)
  })

  it("reads HTML tables and figures through their data attributes", () => {
    const html = `<!doctype html><html><body>
      <table data-derive-table="results"><caption>Totals</caption>
        <thead><tr><th>Model</th><th>Acc &amp; F1</th></tr></thead>
        <tbody><tr><td>base</td><td>--</td></tr><tr><td><b>ours</b></td><td>0.9</td></tr></tbody>
      </table>
      <figure data-derive-figure="teaser"><img src="/blob/${"c".repeat(64)}.png" alt="Teaser"><figcaption>The <em>teaser</em></figcaption></figure>
      <table><tr><td>plain</td></tr></table>
    </body></html>`
    const { bindings, advisories } = parseDynamicBindings(html, "text/html; charset=utf-8")
    expect(advisories).toEqual([])
    expect(bindings.map((b) => b.name)).toEqual(["results", "teaser"])
    const table = bindings[0]?.seed
    expect(table && table.kind === "table" ? table.table : null).toEqual({
      columns: [
        { key: "model", label: "Model" },
        { key: "acc-f1", label: "Acc & F1" },
      ],
      rows: [
        { model: "base", "acc-f1": null },
        { model: "ours", "acc-f1": 0.9 },
      ],
    })
    expect(bindings[1]?.seed).toEqual({
      kind: "figure",
      figure: { url: `/blob/${"c".repeat(64)}.png`, alt: "Teaser", caption: "The teaser" },
    })
    expect(parseDynamicBindings(html, "application/pdf").bindings).toEqual([])
  })
})

describe("rendering and serve-time substitution", () => {
  it("escapes cells, renders null as --, and carries alignment as an attribute", () => {
    const html = renderDynamicValue("results", results([{ model: "<b>x</b>", acc: null }]))
    expect(html).toBe(
      '<table data-derive-table="results"><thead><tr><th>Model</th><th align="right">Acc</th></tr></thead>' +
        '<tbody><tr><td>&lt;b&gt;x&lt;/b&gt;</td><td align="right">--</td></tr></tbody></table>',
    )
  })

  it("replaces bound elements only, keeps a leading caption and an authored figcaption", () => {
    const html =
      '<table data-derive-table="results"><caption>Totals</caption><tr><td>old</td></tr></table>' +
      '<table data-derive-table="missing"><tr><td>untouched</td></tr></table>' +
      '<figure data-derive-figure="teaser"><img src="x.png"><figcaption>Authored caption</figcaption></figure>'
    const slots = new Map<string, DynamicValue>([
      ["results", results([{ model: "ours", acc: 0.9 }])],
      ["teaser", { kind: "figure", figure: { url: `/blob/${"d".repeat(64)}.png` } }],
    ])
    const out = applyDynamicBindings(html, slots)
    expect(out).toContain('<table data-derive-table="results"><caption>Totals</caption><thead>')
    expect(out).toContain("<td>ours</td>")
    expect(out).not.toContain("old")
    expect(out).toContain('<table data-derive-table="missing"><tr><td>untouched</td></tr></table>')
    expect(out).toContain(
      `<figure data-derive-figure="teaser"><img src="/blob/${"d".repeat(64)}.png" alt="Authored caption"><figcaption>Authored caption</figcaption></figure>`,
    )
    expect(applyDynamicBindings(html, new Map())).toBe(html)
  })
})

describe("the in-frame client", () => {
  type Listener = (event: { source: unknown; data: unknown }) => void
  interface FakeElement {
    attr: string
    name: string
    innerHTML: string
    caption: string | null
    firstChild: null
    querySelector(selector: string): { html: string } | null
    insertBefore(node: { html: string }, ref: unknown): void
  }
  const boot = (elements: FakeElement[]) => {
    const listeners: Listener[] = []
    const parent = {}
    const frame = {
      parent,
      addEventListener: (type: string, listener: Listener) => {
        if (type === "message") listeners.push(listener)
      },
    }
    const document = {
      querySelectorAll: (selector: string) =>
        elements.filter((el) => selector === `[${el.attr}="${el.name}"]`),
    }
    const load = Function("window", "document", DYNAMIC_DATA_CLIENT_JS) as (
      frame: typeof frame,
      document: typeof document,
    ) => void
    load(frame, document)
    return {
      fire: (data: unknown, source: unknown = parent) => {
        for (const listener of listeners) listener({ source, data })
      },
    }
  }
  const element = (attr: string, name: string, caption: string | null): FakeElement => {
    const el: FakeElement = {
      attr,
      name,
      innerHTML: "<tr><td>old</td></tr>",
      caption,
      firstChild: null,
      querySelector: (selector) =>
        selector === ":scope > caption" && el.caption !== null ? { html: el.caption } : null,
      insertBefore: (node) => {
        el.innerHTML = node.html + el.innerHTML
      },
    }
    return el
  }

  it("swaps the bound element from a parent message and keeps its caption", () => {
    const bound = element("data-derive-table", "results", "<caption>Totals</caption>")
    const other = element("data-derive-table", "other", null)
    const { fire } = boot([bound, other])
    fire({
      source: "derive-host",
      type: "dynamic-updated",
      kind: "table",
      name: "results",
      html: "<tbody>new</tbody>",
    })
    expect(bound.innerHTML).toBe("<caption>Totals</caption><tbody>new</tbody>")
    expect(other.innerHTML).toBe("<tr><td>old</td></tr>")
  })

  it("ignores messages from anyone but the parent and malformed names", () => {
    const bound = element("data-derive-table", "results", null)
    const { fire } = boot([bound])
    fire(
      { source: "derive-host", type: "dynamic-updated", kind: "table", name: "results", html: "x" },
      {},
    )
    fire({
      source: "derive-host",
      type: "dynamic-updated",
      kind: "table",
      name: 'results"]',
      html: "x",
    })
    fire({ source: "derive", type: "dynamic-updated", kind: "table", name: "results", html: "x" })
    expect(bound.innerHTML).toBe("<tr><td>old</td></tr>")
  })
})

describe("parseDynamicBindings — LaTeX", () => {
  it("reads \\derivetable and \\derivefigure, empty seeds, first name wins, names validated", () => {
    const tex = [
      "\\documentclass{article}\\begin{document}",
      "\\begin{table}\\derivetable{results}\\end{table}",
      "\\begin{figure}\\derivefigure[width=\\linewidth]{teaser}\\end{figure}",
      "\\derivetable{results}",
      "\\derivetable{Bad_Name}",
      "\\end{document}",
    ].join("\n")
    const { bindings, advisories } = parseDynamicBindings(tex, "text/x-latex; charset=utf-8")
    expect(bindings).toEqual([
      {
        name: "results",
        kind: "table",
        seed: { kind: "table", table: { columns: [{ key: "value" }], rows: [] } },
      },
      { name: "teaser", kind: "figure", seed: { kind: "figure", figure: { url: null } } },
    ])
    expect(advisories).toEqual([
      'Dynamic table "Bad_Name" was ignored: names are lowercase letters, digits and dashes.',
    ])
  })
})
