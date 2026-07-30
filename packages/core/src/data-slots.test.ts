import { describe, expect, it } from "vitest"
import {
  MAX_SLOT_BYTES,
  MAX_SLOTS_PER_VERSION,
  missingDataSlotAdvisory,
  parseDataSlots,
} from "./data-slots"

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
