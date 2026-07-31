import { describe, expect, it } from "vitest"
import {
  factDeltas,
  factDriftAdvisories,
  factShape,
  factSummary,
  MAX_FACT_BYTES,
  MAX_FACTS_PER_VERSION,
  missingFactAdvisory,
  parseFacts,
  shapeOfJson,
} from "./index"

const html = (body: string) => `<!doctype html><html><body>${body}</body></html>`
const slot = (name: string, json: string) =>
  `<script type="application/derive-data" data-slot="${name}">${json}</script>`

describe("parseFacts — HTML", () => {
  it("extracts a well-formed slot with its trimmed json and byte size", () => {
    const { facts, advisories } = parseFacts(
      html(slot("checks", `\n{"pass":44,"fail":0}\n`)),
      "text/html",
    )
    expect(advisories).toEqual([])
    expect(facts).toEqual([{ slot: "checks", json: `{"pass":44,"fail":0}`, bytes: 20 }])
  })

  it("extracts multiple facts in document order", () => {
    const src = html(slot("a", "1") + slot("b", `{"x":true}`))
    const { facts } = parseFacts(src, "text/html")
    expect(facts.map((s) => s.slot)).toEqual(["a", "b"])
  })

  it("tolerates attribute order (data-slot before type) and single quotes", () => {
    const src = html(`<script data-slot='m' type='application/derive-data'>[1,2,3]</script>`)
    const { facts } = parseFacts(src, "text/html")
    expect(facts).toEqual([{ slot: "m", json: "[1,2,3]", bytes: 7 }])
  })

  it("ignores ordinary scripts and other script types", () => {
    const src = html(
      `<script>console.log(1)</script>` +
        `<script type="application/json" data-slot="x">{"a":1}</script>` +
        slot("real", "true"),
    )
    const { facts } = parseFacts(src, "text/html")
    expect(facts.map((s) => s.slot)).toEqual(["real"])
  })

  it("advises and skips invalid JSON, storing nothing for it", () => {
    const { facts, advisories } = parseFacts(html(slot("bad", "{not json}")), "text/html")
    expect(facts).toEqual([])
    expect(advisories).toHaveLength(1)
    expect(advisories[0]).toContain("not valid JSON")
  })

  it("advises and skips an invalid fact name", () => {
    const { facts, advisories } = parseFacts(html(slot("Bad Name", "1")), "text/html")
    expect(facts).toEqual([])
    expect(advisories[0]).toContain("invalid name")
  })

  it("advises a data-typed script with no fact name", () => {
    const src = html(`<script type="application/derive-data">1</script>`)
    const { facts, advisories } = parseFacts(src, "text/html")
    expect(facts).toEqual([])
    expect(advisories[0]).toContain("no fact name")
  })

  it("keeps the first of a duplicated fact name and advises", () => {
    const src = html(slot("dup", "1") + slot("dup", "2"))
    const { facts, advisories } = parseFacts(src, "text/html")
    expect(facts).toEqual([{ slot: "dup", json: "1", bytes: 1 }])
    expect(advisories[0]).toContain("more than once")
  })

  it("advises and skips a fact over the byte cap", () => {
    const big = JSON.stringify({ s: "x".repeat(MAX_FACT_BYTES) })
    const { facts, advisories } = parseFacts(html(slot("big", big)), "text/html")
    expect(facts).toEqual([])
    expect(advisories[0]).toContain("over the")
  })

  it("caps the number of facts per version and advises about the rest", () => {
    const many = Array.from({ length: MAX_FACTS_PER_VERSION + 3 }, (_, i) =>
      slot(`s${i}`, `${i}`),
    ).join("")
    const { facts, advisories } = parseFacts(html(many), "text/html")
    expect(facts).toHaveLength(MAX_FACTS_PER_VERSION)
    expect(advisories.some((a) => a.includes(`More than ${MAX_FACTS_PER_VERSION}`))).toBe(true)
  })

  it("returns nothing for a page with no data blocks", () => {
    expect(parseFacts(html("<p>hi</p>"), "text/html")).toEqual({ facts: [], advisories: [] })
  })

  // A literal </script> inside a JSON string ends the block right there — the HTML parser
  // does not care that a JSON string wanted it, and neither does a browser. The plain
  // "not valid JSON" verdict is actively misleading here (the author is looking at JSON
  // that IS valid), so the advisory names the real cause and the escape.
  it("blames </script>, not the JSON, when a block is cut mid-string", () => {
    const { facts, advisories } = parseFacts(html(slot("x", '{"h": "</script>"}')), "text/html")
    expect(facts).toEqual([])
    expect(advisories[0]).toContain("</script>")
    expect(advisories[0]).toContain("<\\/script>")
  })

  it("keeps the plain message for ordinary bad JSON (no false </script> blame)", () => {
    const { advisories } = parseFacts(html(slot("x", "{bad}")), "text/html")
    expect(advisories[0]).toContain("not valid JSON")
    expect(advisories[0]).not.toContain("unterminated")
  })

  it("escaping the closing tag as <\\/script> stores the fact", () => {
    const { facts } = parseFacts(html(slot("x", '{"h": "<\\/script>"}')), "text/html")
    expect(facts).toHaveLength(1)
  })

  // Browsers trim the type attribute; without the trim this was a SILENT no-op — no slot
  // stored and no advisory to notice, the worst of both.
  it("trims the type and data-slot attributes", () => {
    const src = html(`<script type="application/derive-data " data-slot=" a ">1</script>`)
    expect(parseFacts(src, "text/html").facts).toEqual([{ slot: "a", json: "1", bytes: 1 }])
  })

  it("counts the size cap in BYTES, not characters", () => {
    // 11K multibyte chars is ~33KB encoded — over the cap even though it is well under
    // 32K characters.
    const multibyte = JSON.stringify({ s: "日".repeat(11 * 1024) })
    const { facts, advisories } = parseFacts(html(slot("a", multibyte)), "text/html")
    expect(facts).toEqual([])
    expect(advisories[0]).toContain("over the")
  })

  it("skips only the offending slot, keeping good ones on the same page", () => {
    const src = html(slot("big", JSON.stringify({ s: "x".repeat(33 * 1024) })) + slot("ok", "1"))
    const { facts, advisories } = parseFacts(src, "text/html")
    expect(facts.map((s) => s.slot)).toEqual(["ok"])
    expect(advisories).toHaveLength(1)
  })

  it("stays fast on a large page full of decoy scripts", () => {
    const src = html(`${"<script>noop()</script>".repeat(5000)}${slot("a", "1")}`)
    const started = performance.now()
    const { facts } = parseFacts(src, "text/html")
    expect(facts).toHaveLength(1)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe("parseFacts — markdown", () => {
  const md = (name: string, body: string) => "```derive-data " + name + "\n" + body + "\n```"

  it("extracts a fenced data block", () => {
    const src = `# Report\n\n${md("checks", `{"pass":41,"fail":2}`)}\n\nprose`
    const { facts, advisories } = parseFacts(src, "text/markdown")
    expect(advisories).toEqual([])
    expect(facts).toEqual([{ slot: "checks", json: `{"pass":41,"fail":2}`, bytes: 20 }])
  })

  it("extracts multiple fences and validates each", () => {
    const src = `${md("a", "1")}\n\n${md("b", "{bad}")}\n\n${md("c", `{"ok":true}`)}`
    const { facts, advisories } = parseFacts(src, "text/markdown")
    expect(facts.map((s) => s.slot)).toEqual(["a", "c"])
    expect(advisories[0]).toContain("not valid JSON")
  })

  it("does not treat an ordinary code fence as a data block", () => {
    const src = '```json\n{"a":1}\n```'
    expect(parseFacts(src, "text/markdown").facts).toEqual([])
  })
})

// The nudge that keeps facts from depending on the author remembering. Its whole value is
// precision: a missed nudge costs nothing, a false one trains the reader to skip
// advisories, and that channel is load-bearing for everything else here.
describe("missingFactAdvisory", () => {
  const table = (rows: number) =>
    html(`<table>${"<tr><td>Passing</td><td>44</td></tr>".repeat(rows)}</table>`)

  it("nudges a page whose table carries figures and no slot", () => {
    const note = missingFactAdvisory(table(4), "text/html")
    expect(note).toContain("no facts")
    expect(note).toContain("versions")
  })

  it("says nothing when the page already carries a fact", () => {
    const src = table(4) + slot("checks", '{"pass":44}')
    expect(missingFactAdvisory(src, "text/html")).toBeNull()
  })

  it("says nothing when a derive-data block exists but failed to parse", () => {
    // That case has its own, more specific advisory; two notes about one block is noise.
    expect(missingFactAdvisory(table(4) + slot("bad", "{oops}"), "text/html")).toBeNull()
  })

  it("stays quiet on prose that merely mentions numbers", () => {
    const prose = html(
      "<p>We shipped 3 fixes in 2026, up from 2 the year before, across 14 repos.</p>",
    )
    expect(missingFactAdvisory(prose, "text/html")).toBeNull()
  })

  it("stays quiet on a table of words rather than figures", () => {
    const words = html("<table><tr><td>Alice</td><td>Editor</td></tr></table>".repeat(6))
    expect(missingFactAdvisory(words, "text/html")).toBeNull()
  })

  it("stays quiet below the threshold — one or two figures is not a dataset", () => {
    expect(missingFactAdvisory(table(1), "text/html")).toBeNull()
  })

  it("reads markdown tables too", () => {
    const md = ["| metric | value |", "| --- | --- |", "| pass | 44 |", "| fail | 0 |"].join("\n")
    // Four numeric cells across the two data rows (the alignment row has none).
    expect(missingFactAdvisory(`${md}\n${md}`, "text/markdown")).toContain("no facts")
  })

  it("ignores content types with no slot grammar", () => {
    expect(missingFactAdvisory(table(8), "text/x-derive-deck")).toBeNull()
  })
})

// Shape drift is the quiet way a trend read goes wrong: rename a key at v20 and
// versions:"all" still returns thirty happy-looking points that are two different
// metrics. A series that gets LESS trustworthy the longer it runs is worse than none.
describe("factShape / factDriftAdvisories", () => {
  const shape = (o: unknown) => factShape(o)

  it("fingerprints keys and value kinds, order-independently", () => {
    expect(shape({ pass: 1, fail: 0 })).toBe(shape({ fail: 0, pass: 1 }))
    expect(shape({ pass: 1 })).not.toBe(shape({ passed: 1 }))
    // A changed TYPE matters as much as a changed name.
    expect(shape({ pass: 1 })).not.toBe(shape({ pass: "1" }))
  })

  it("treats a value change as the same shape", () => {
    expect(shape({ pass: 41, fail: 2 })).toBe(shape({ pass: 48, fail: 0 }))
  })

  it("flags a renamed key, naming what went and what arrived", () => {
    const notes = factDriftAdvisories(
      [{ slot: "checks", json: '{"passed":48}' }],
      [{ slot: "checks", shape: shapeOfJson('{"pass":41}') }],
    )
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("gone: pass:number")
    expect(notes[0]).toContain("new: passed:number")
  })

  it("says nothing when the shape holds", () => {
    expect(
      factDriftAdvisories(
        [{ slot: "checks", json: '{"pass":48,"fail":0}' }],
        [{ slot: "checks", shape: shapeOfJson('{"pass":41,"fail":2}') }],
      ),
    ).toEqual([])
  })

  it("says nothing for a brand-new slot or a dropped one", () => {
    // New: there is no prior shape to disagree with.
    expect(
      factDriftAdvisories(
        [{ slot: "fresh", json: "{}" }],
        [{ slot: "checks", shape: "pass:number" }],
      ),
    ).toEqual([])
    // Dropped: not publishing a fact is ordinary authoring, not a broken series.
    expect(factDriftAdvisories([], [{ slot: "checks", shape: "pass:number" }])).toEqual([])
  })

  it("is bounded on deep and wide payloads", () => {
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 50; i++) deep = { nest: deep }
    expect(() => shape(deep)).not.toThrow()
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]))
    expect(shape(wide).split("|").length).toBeLessThanOrEqual(40)
  })
})

describe("parseFacts — content type gating", () => {
  it("finds no facts in a non-html, non-markdown type", () => {
    expect(parseFacts(slot("x", "1"), "text/x-derive-deck").facts).toEqual([])
  })

  it("is total and deterministic — same input, same result twice", () => {
    const src = html(
      slot("a", "1") + slot("a", "2") + `<script type="application/derive-data">bad</script>`,
    )
    expect(parseFacts(src, "text/html")).toEqual(parseFacts(src, "text/html"))
  })
})

// The unfurl summary: the incentive half. A shared link that shows its own numbers is
// what rewards emitting a fact at all, so this has to look right on a card and never
// break one — lossy on purpose, null rather than empty.
describe("factSummary", () => {
  const row = (slot: string, json: string) => ({ slot, json })

  it("summarizes an object slot's leading scalar fields", () => {
    expect(factSummary([row("checks", '{"pass":48,"fail":0,"flaky":1}')])).toBe(
      "pass 48 · fail 0 · flaky 1",
    )
  })

  it("caps at three fields so a card stays scannable", () => {
    const s = factSummary([row("m", '{"a":1,"b":2,"c":3,"d":4,"e":5}')])
    expect(s).toBe("a 1 · b 2 · c 3")
  })

  it("names a bare scalar slot by its own fact name", () => {
    expect(factSummary([row("uptime", "99.95")])).toBe("uptime 99.95")
    expect(factSummary([row("status", '"green"')])).toBe("status green")
  })

  it("skips nested objects and arrays rather than printing noise", () => {
    expect(factSummary([row("checks", '{"pass":48,"detail":{"a":1},"tags":["x"],"fail":0}')])).toBe(
      "pass 48 · fail 0",
    )
  })

  it("drops values too long for a card", () => {
    const long = "x".repeat(40)
    expect(factSummary([row("checks", JSON.stringify({ note: long, pass: 48 }))])).toBe("pass 48")
  })

  it("rounds noisy floats", () => {
    expect(factSummary([row("m", '{"ratio":0.123456789}')])).toBe("ratio 0.12")
  })

  it("returns null when there is nothing card-worthy, so the card falls back", () => {
    expect(factSummary([])).toBeNull()
    expect(factSummary([row("x", "{}")])).toBeNull()
    expect(factSummary([row("x", '{"nested":{"a":1}}')])).toBeNull()
    expect(factSummary([row("x", "{bad json")])).toBeNull()
  })

  it("draws from several facts when the first is thin", () => {
    expect(factSummary([row("a", '{"x":1}'), row("b", '{"y":2}')])).toBe("x 1 · y 2")
  })
})

// Slot deltas: the review-loop half. A version diff that shows prose changes but not the
// figures the page is about is only half a diff.
describe("factDeltas", () => {
  const row = (slot: string, json: string) => ({ slot, json })

  it("reports changed scalar fields with before and after", () => {
    expect(
      factDeltas([row("checks", '{"pass":41,"fail":2}')], [row("checks", '{"pass":44,"fail":0}')]),
    ).toEqual(["checks.pass 41 → 44", "checks.fail 2 → 0"])
  })

  it("says nothing when the numbers held", () => {
    expect(factDeltas([row("checks", '{"pass":44}')], [row("checks", '{"pass":44}')])).toEqual([])
  })

  it("reports a fact appearing or disappearing as its own event", () => {
    expect(factDeltas([], [row("checks", '{"pass":1}')])).toEqual(["checks (new)"])
    expect(factDeltas([row("checks", '{"pass":1}')], [])).toEqual(["checks (gone)"])
  })

  it("reports a new field inside an existing slot", () => {
    expect(factDeltas([row("c", '{"pass":1}')], [row("c", '{"pass":1,"flaky":3}')])).toEqual([
      "c.flaky 3 (new)",
    ])
  })

  it("reaches nested scalars", () => {
    expect(factDeltas([row("c", '{"t":{"ms":900}}')], [row("c", '{"t":{"ms":750}}')])).toEqual([
      "c.t.ms 900 → 750",
    ])
  })

  it("caps the list so a review stays readable", () => {
    const before = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]))
    const after = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i + 1]))
    expect(
      factDeltas([row("m", JSON.stringify(before))], [row("m", JSON.stringify(after))]).length,
    ).toBeLessThanOrEqual(8)
  })

  it("survives an unparseable stored row", () => {
    expect(() => factDeltas([row("c", "{bad")], [row("c", '{"pass":1}')])).not.toThrow()
  })
})

describe("browser parity and adversarial input (the CodeQL round)", () => {
  // Five high-severity alerts arrived the day the parser moved to its own package —
  // on code that had passed silently inside core for two PRs. The move re-attributed
  // every line as new, which is the only reason they surfaced. All five were real.

  it('ends a block at "</script >" exactly like a browser does', () => {
    // The close tag may carry whitespace (or junk) before its ">" and still terminate
    // the element. Matching only the literal "</script>" made this parser read PAST a
    // close the browser honored — the two disagreed about where the body ends, which
    // is the drift SPEC.md's normative close-tag hazard exists to prevent. Found in
    // the reference implementation itself.
    const page =
      '<script type="application/derive-data" data-slot="a">{"x":1}</script >' +
      '<script type="application/derive-data" data-slot="b">{"y":2}</SCRIPT\t>'
    const { facts } = parseFacts(page, "text/html")
    expect(facts.map((s) => [s.slot, s.json])).toEqual([
      ["a", '{"x":1}'],
      ["b", '{"y":2}'],
    ])
  })

  it("still reports the truncation hazard when the early close is a spaced tag", () => {
    const page =
      '<script type="application/derive-data" data-slot="tpl">{"t": "</script >"}</script>'
    const { facts, advisories } = parseFacts(page, "text/html")
    expect(facts).toHaveLength(0)
    expect(advisories.join(" ")).toMatch(/unterminated string/)
  })

  it("parses the CodeQL fence attack string in linear time", () => {
    // The exact adversarial shape from the alert: many repetitions of an almost-opener.
    // The old whole-block regex went polynomial here; the line scanner is linear by
    // construction, so this must return promptly rather than hang the suite.
    const attack = "\n```derive-data\t!\na".repeat(20_000)
    const started = Date.now()
    const { facts } = parseFacts(attack, "text/markdown")
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(facts).toHaveLength(0)
  })

  it("counts numeric cells in linear time on the adversarial table shapes", () => {
    const tdAttack = "<td".repeat(30_000)
    const pipeAttack = `|0${" ".repeat(30_000)}`
    const started = Date.now()
    expect(missingFactAdvisory(tdAttack, "text/html")).toBeNull()
    expect(missingFactAdvisory(pipeAttack, "text/markdown")).toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("still finds real numeric cells after the linear-time rewrite", () => {
    const html = `<table>${"<td> 42 </td><td>$1,204.50</td><td>93%</td><td>7</td>"}</table>`
    expect(missingFactAdvisory(html, "text/html")).toMatch(/4 numeric table cells/)
    const md = "| a | b |\n|---|---|\n| 41 | 7% |\n| $9 | 12.5 |\n"
    expect(missingFactAdvisory(md, "text/markdown")).toMatch(/4 numeric table cells/)
  })
})

describe("the rename: both spellings parse, forever", () => {
  // This shipped as "facts" before the name settled on facts. A version is IMMUTABLE, so
  // documents already published carry the old spelling in bytes nothing may rewrite —
  // they have to keep parsing a decade from now. Dropping the old form would silently
  // empty the history of anything published early, which is the same harm §3.2 forbids
  // when it bans fabricated gaps, arriving from the other direction.
  it("reads the new spelling", () => {
    const page = '<script type="application/derive-facts" data-fact="checks">{"pass":48}</script>'
    expect(parseFacts(page, "text/html").facts.map((s) => s.slot)).toEqual(["checks"])
  })

  it("still reads the ORIGINAL spelling that shipped to production", () => {
    const page = '<script type="application/derive-data" data-slot="checks">{"pass":48}</script>'
    const { facts, advisories } = parseFacts(page, "text/html")
    expect(facts.map((s) => [s.slot, s.json])).toEqual([["checks", '{"pass":48}']])
    expect(advisories).toEqual([])
  })

  it("reads a mixed document, because one page may carry both", () => {
    const page =
      '<script type="application/derive-data" data-slot="old">{"a":1}</script>' +
      '<script type="application/derive-facts" data-fact="new">{"b":2}</script>'
    expect(parseFacts(page, "text/html").facts.map((s) => s.slot)).toEqual(["old", "new"])
  })

  it("reads both markdown fence words", () => {
    const md = '```derive-facts new\n{"b":2}\n```\n\n```derive-data old\n{"a":1}\n```\n'
    expect(parseFacts(md, "text/markdown").facts.map((s) => s.slot)).toEqual(["new", "old"])
  })

  it("leaves an ordinary fenced code block alone", () => {
    const md = "```js foo\nconst a = 1\n```\n"
    expect(parseFacts(md, "text/markdown").facts).toEqual([])
  })
})
