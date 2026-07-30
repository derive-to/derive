import { describe, expect, it } from "vitest"
import {
  MAX_SLOT_BYTES,
  MAX_SLOTS_PER_VERSION,
  missingDataSlotAdvisory,
  parseDataSlots,
  shapeOfJson,
  slotDeltas,
  slotDriftAdvisories,
  slotShape,
  slotSummary,
} from "./index"

const html = (body: string) => `<!doctype html><html><body>${body}</body></html>`
const slot = (name: string, json: string) =>
  `<script type="application/derive-data" data-slot="${name}">${json}</script>`

describe("parseDataSlots — HTML", () => {
  it("extracts a well-formed slot with its trimmed json and byte size", () => {
    const { slots, advisories } = parseDataSlots(
      html(slot("checks", `\n{"pass":44,"fail":0}\n`)),
      "text/html",
    )
    expect(advisories).toEqual([])
    expect(slots).toEqual([{ slot: "checks", json: `{"pass":44,"fail":0}`, bytes: 20 }])
  })

  it("extracts multiple slots in document order", () => {
    const src = html(slot("a", "1") + slot("b", `{"x":true}`))
    const { slots } = parseDataSlots(src, "text/html")
    expect(slots.map((s) => s.slot)).toEqual(["a", "b"])
  })

  it("tolerates attribute order (data-slot before type) and single quotes", () => {
    const src = html(`<script data-slot='m' type='application/derive-data'>[1,2,3]</script>`)
    const { slots } = parseDataSlots(src, "text/html")
    expect(slots).toEqual([{ slot: "m", json: "[1,2,3]", bytes: 7 }])
  })

  it("ignores ordinary scripts and other script types", () => {
    const src = html(
      `<script>console.log(1)</script>` +
        `<script type="application/json" data-slot="x">{"a":1}</script>` +
        slot("real", "true"),
    )
    const { slots } = parseDataSlots(src, "text/html")
    expect(slots.map((s) => s.slot)).toEqual(["real"])
  })

  it("advises and skips invalid JSON, storing nothing for it", () => {
    const { slots, advisories } = parseDataSlots(html(slot("bad", "{not json}")), "text/html")
    expect(slots).toEqual([])
    expect(advisories).toHaveLength(1)
    expect(advisories[0]).toContain("not valid JSON")
  })

  it("advises and skips an invalid slot name", () => {
    const { slots, advisories } = parseDataSlots(html(slot("Bad Name", "1")), "text/html")
    expect(slots).toEqual([])
    expect(advisories[0]).toContain("invalid name")
  })

  it("advises a data-typed script with no slot name", () => {
    const src = html(`<script type="application/derive-data">1</script>`)
    const { slots, advisories } = parseDataSlots(src, "text/html")
    expect(slots).toEqual([])
    expect(advisories[0]).toContain("no slot name")
  })

  it("keeps the first of a duplicated slot name and advises", () => {
    const src = html(slot("dup", "1") + slot("dup", "2"))
    const { slots, advisories } = parseDataSlots(src, "text/html")
    expect(slots).toEqual([{ slot: "dup", json: "1", bytes: 1 }])
    expect(advisories[0]).toContain("more than once")
  })

  it("advises and skips a slot over the byte cap", () => {
    const big = JSON.stringify({ s: "x".repeat(MAX_SLOT_BYTES) })
    const { slots, advisories } = parseDataSlots(html(slot("big", big)), "text/html")
    expect(slots).toEqual([])
    expect(advisories[0]).toContain("over the")
  })

  it("caps the number of slots per version and advises about the rest", () => {
    const many = Array.from({ length: MAX_SLOTS_PER_VERSION + 3 }, (_, i) =>
      slot(`s${i}`, `${i}`),
    ).join("")
    const { slots, advisories } = parseDataSlots(html(many), "text/html")
    expect(slots).toHaveLength(MAX_SLOTS_PER_VERSION)
    expect(advisories.some((a) => a.includes(`More than ${MAX_SLOTS_PER_VERSION}`))).toBe(true)
  })

  it("returns nothing for a page with no data blocks", () => {
    expect(parseDataSlots(html("<p>hi</p>"), "text/html")).toEqual({ slots: [], advisories: [] })
  })

  // A literal </script> inside a JSON string ends the block right there — the HTML parser
  // does not care that a JSON string wanted it, and neither does a browser. The plain
  // "not valid JSON" verdict is actively misleading here (the author is looking at JSON
  // that IS valid), so the advisory names the real cause and the escape.
  it("blames </script>, not the JSON, when a block is cut mid-string", () => {
    const { slots, advisories } = parseDataSlots(html(slot("x", '{"h": "</script>"}')), "text/html")
    expect(slots).toEqual([])
    expect(advisories[0]).toContain("</script>")
    expect(advisories[0]).toContain("<\\/script>")
  })

  it("keeps the plain message for ordinary bad JSON (no false </script> blame)", () => {
    const { advisories } = parseDataSlots(html(slot("x", "{bad}")), "text/html")
    expect(advisories[0]).toContain("not valid JSON")
    expect(advisories[0]).not.toContain("unterminated")
  })

  it("escaping the closing tag as <\\/script> stores the slot", () => {
    const { slots } = parseDataSlots(html(slot("x", '{"h": "<\\/script>"}')), "text/html")
    expect(slots).toHaveLength(1)
  })

  // Browsers trim the type attribute; without the trim this was a SILENT no-op — no slot
  // stored and no advisory to notice, the worst of both.
  it("trims the type and data-slot attributes", () => {
    const src = html(`<script type="application/derive-data " data-slot=" a ">1</script>`)
    expect(parseDataSlots(src, "text/html").slots).toEqual([{ slot: "a", json: "1", bytes: 1 }])
  })

  it("counts the size cap in BYTES, not characters", () => {
    // 11K multibyte chars is ~33KB encoded — over the cap even though it is well under
    // 32K characters.
    const multibyte = JSON.stringify({ s: "日".repeat(11 * 1024) })
    const { slots, advisories } = parseDataSlots(html(slot("a", multibyte)), "text/html")
    expect(slots).toEqual([])
    expect(advisories[0]).toContain("over the")
  })

  it("skips only the offending slot, keeping good ones on the same page", () => {
    const src = html(slot("big", JSON.stringify({ s: "x".repeat(33 * 1024) })) + slot("ok", "1"))
    const { slots, advisories } = parseDataSlots(src, "text/html")
    expect(slots.map((s) => s.slot)).toEqual(["ok"])
    expect(advisories).toHaveLength(1)
  })

  it("stays fast on a large page full of decoy scripts", () => {
    const src = html(`${"<script>noop()</script>".repeat(5000)}${slot("a", "1")}`)
    const started = performance.now()
    const { slots } = parseDataSlots(src, "text/html")
    expect(slots).toHaveLength(1)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe("parseDataSlots — markdown", () => {
  const md = (name: string, body: string) => "```derive-data " + name + "\n" + body + "\n```"

  it("extracts a fenced data block", () => {
    const src = `# Report\n\n${md("checks", `{"pass":41,"fail":2}`)}\n\nprose`
    const { slots, advisories } = parseDataSlots(src, "text/markdown")
    expect(advisories).toEqual([])
    expect(slots).toEqual([{ slot: "checks", json: `{"pass":41,"fail":2}`, bytes: 20 }])
  })

  it("extracts multiple fences and validates each", () => {
    const src = `${md("a", "1")}\n\n${md("b", "{bad}")}\n\n${md("c", `{"ok":true}`)}`
    const { slots, advisories } = parseDataSlots(src, "text/markdown")
    expect(slots.map((s) => s.slot)).toEqual(["a", "c"])
    expect(advisories[0]).toContain("not valid JSON")
  })

  it("does not treat an ordinary code fence as a data block", () => {
    const src = '```json\n{"a":1}\n```'
    expect(parseDataSlots(src, "text/markdown").slots).toEqual([])
  })
})

// The nudge that keeps slots from depending on the author remembering. Its whole value is
// precision: a missed nudge costs nothing, a false one trains the reader to skip
// advisories, and that channel is load-bearing for everything else here.
describe("missingDataSlotAdvisory", () => {
  const table = (rows: number) =>
    html(`<table>${"<tr><td>Passing</td><td>44</td></tr>".repeat(rows)}</table>`)

  it("nudges a page whose table carries figures and no slot", () => {
    const note = missingDataSlotAdvisory(table(4), "text/html")
    expect(note).toContain("no data slot")
    expect(note).toContain("versions")
  })

  it("says nothing when the page already carries a slot", () => {
    const src = table(4) + slot("checks", '{"pass":44}')
    expect(missingDataSlotAdvisory(src, "text/html")).toBeNull()
  })

  it("says nothing when a derive-data block exists but failed to parse", () => {
    // That case has its own, more specific advisory; two notes about one block is noise.
    expect(missingDataSlotAdvisory(table(4) + slot("bad", "{oops}"), "text/html")).toBeNull()
  })

  it("stays quiet on prose that merely mentions numbers", () => {
    const prose = html(
      "<p>We shipped 3 fixes in 2026, up from 2 the year before, across 14 repos.</p>",
    )
    expect(missingDataSlotAdvisory(prose, "text/html")).toBeNull()
  })

  it("stays quiet on a table of words rather than figures", () => {
    const words = html("<table><tr><td>Alice</td><td>Editor</td></tr></table>".repeat(6))
    expect(missingDataSlotAdvisory(words, "text/html")).toBeNull()
  })

  it("stays quiet below the threshold — one or two figures is not a dataset", () => {
    expect(missingDataSlotAdvisory(table(1), "text/html")).toBeNull()
  })

  it("reads markdown tables too", () => {
    const md = ["| metric | value |", "| --- | --- |", "| pass | 44 |", "| fail | 0 |"].join("\n")
    // Four numeric cells across the two data rows (the alignment row has none).
    expect(missingDataSlotAdvisory(`${md}\n${md}`, "text/markdown")).toContain("no data slot")
  })

  it("ignores content types with no slot grammar", () => {
    expect(missingDataSlotAdvisory(table(8), "text/x-derive-deck")).toBeNull()
  })
})

// Shape drift is the quiet way a trend read goes wrong: rename a key at v20 and
// versions:"all" still returns thirty happy-looking points that are two different
// metrics. A series that gets LESS trustworthy the longer it runs is worse than none.
describe("slotShape / slotDriftAdvisories", () => {
  const shape = (o: unknown) => slotShape(o)

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
    const notes = slotDriftAdvisories(
      [{ slot: "checks", json: '{"passed":48}' }],
      [{ slot: "checks", shape: shapeOfJson('{"pass":41}') }],
    )
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain("gone: pass:number")
    expect(notes[0]).toContain("new: passed:number")
  })

  it("says nothing when the shape holds", () => {
    expect(
      slotDriftAdvisories(
        [{ slot: "checks", json: '{"pass":48,"fail":0}' }],
        [{ slot: "checks", shape: shapeOfJson('{"pass":41,"fail":2}') }],
      ),
    ).toEqual([])
  })

  it("says nothing for a brand-new slot or a dropped one", () => {
    // New: there is no prior shape to disagree with.
    expect(
      slotDriftAdvisories(
        [{ slot: "fresh", json: "{}" }],
        [{ slot: "checks", shape: "pass:number" }],
      ),
    ).toEqual([])
    // Dropped: not publishing a slot is ordinary authoring, not a broken series.
    expect(slotDriftAdvisories([], [{ slot: "checks", shape: "pass:number" }])).toEqual([])
  })

  it("is bounded on deep and wide payloads", () => {
    let deep: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 50; i++) deep = { nest: deep }
    expect(() => shape(deep)).not.toThrow()
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]))
    expect(shape(wide).split("|").length).toBeLessThanOrEqual(40)
  })
})

describe("parseDataSlots — content type gating", () => {
  it("finds no slots in a non-html, non-markdown type", () => {
    expect(parseDataSlots(slot("x", "1"), "text/x-derive-deck").slots).toEqual([])
  })

  it("is total and deterministic — same input, same result twice", () => {
    const src = html(
      slot("a", "1") + slot("a", "2") + `<script type="application/derive-data">bad</script>`,
    )
    expect(parseDataSlots(src, "text/html")).toEqual(parseDataSlots(src, "text/html"))
  })
})

// The unfurl summary: the incentive half. A shared link that shows its own numbers is
// what rewards emitting a slot at all, so this has to look right on a card and never
// break one — lossy on purpose, null rather than empty.
describe("slotSummary", () => {
  const row = (slot: string, json: string) => ({ slot, json })

  it("summarizes an object slot's leading scalar fields", () => {
    expect(slotSummary([row("checks", '{"pass":48,"fail":0,"flaky":1}')])).toBe(
      "pass 48 · fail 0 · flaky 1",
    )
  })

  it("caps at three fields so a card stays scannable", () => {
    const s = slotSummary([row("m", '{"a":1,"b":2,"c":3,"d":4,"e":5}')])
    expect(s).toBe("a 1 · b 2 · c 3")
  })

  it("names a bare scalar slot by its own slot name", () => {
    expect(slotSummary([row("uptime", "99.95")])).toBe("uptime 99.95")
    expect(slotSummary([row("status", '"green"')])).toBe("status green")
  })

  it("skips nested objects and arrays rather than printing noise", () => {
    expect(slotSummary([row("checks", '{"pass":48,"detail":{"a":1},"tags":["x"],"fail":0}')])).toBe(
      "pass 48 · fail 0",
    )
  })

  it("drops values too long for a card", () => {
    const long = "x".repeat(40)
    expect(slotSummary([row("checks", JSON.stringify({ note: long, pass: 48 }))])).toBe("pass 48")
  })

  it("rounds noisy floats", () => {
    expect(slotSummary([row("m", '{"ratio":0.123456789}')])).toBe("ratio 0.12")
  })

  it("returns null when there is nothing card-worthy, so the card falls back", () => {
    expect(slotSummary([])).toBeNull()
    expect(slotSummary([row("x", "{}")])).toBeNull()
    expect(slotSummary([row("x", '{"nested":{"a":1}}')])).toBeNull()
    expect(slotSummary([row("x", "{bad json")])).toBeNull()
  })

  it("draws from several slots when the first is thin", () => {
    expect(slotSummary([row("a", '{"x":1}'), row("b", '{"y":2}')])).toBe("x 1 · y 2")
  })
})

// Slot deltas: the review-loop half. A version diff that shows prose changes but not the
// figures the page is about is only half a diff.
describe("slotDeltas", () => {
  const row = (slot: string, json: string) => ({ slot, json })

  it("reports changed scalar fields with before and after", () => {
    expect(
      slotDeltas([row("checks", '{"pass":41,"fail":2}')], [row("checks", '{"pass":44,"fail":0}')]),
    ).toEqual(["checks.pass 41 → 44", "checks.fail 2 → 0"])
  })

  it("says nothing when the numbers held", () => {
    expect(slotDeltas([row("checks", '{"pass":44}')], [row("checks", '{"pass":44}')])).toEqual([])
  })

  it("reports a slot appearing or disappearing as its own event", () => {
    expect(slotDeltas([], [row("checks", '{"pass":1}')])).toEqual(["checks (new)"])
    expect(slotDeltas([row("checks", '{"pass":1}')], [])).toEqual(["checks (gone)"])
  })

  it("reports a new field inside an existing slot", () => {
    expect(slotDeltas([row("c", '{"pass":1}')], [row("c", '{"pass":1,"flaky":3}')])).toEqual([
      "c.flaky 3 (new)",
    ])
  })

  it("reaches nested scalars", () => {
    expect(slotDeltas([row("c", '{"t":{"ms":900}}')], [row("c", '{"t":{"ms":750}}')])).toEqual([
      "c.t.ms 900 → 750",
    ])
  })

  it("caps the list so a review stays readable", () => {
    const before = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]))
    const after = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i + 1]))
    expect(
      slotDeltas([row("m", JSON.stringify(before))], [row("m", JSON.stringify(after))]).length,
    ).toBeLessThanOrEqual(8)
  })

  it("survives an unparseable stored row", () => {
    expect(() => slotDeltas([row("c", "{bad")], [row("c", '{"pass":1}')])).not.toThrow()
  })
})
