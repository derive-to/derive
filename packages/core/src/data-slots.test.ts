import { describe, expect, it } from "vitest"
import { MAX_SLOT_BYTES, MAX_SLOTS_PER_VERSION, parseDataSlots } from "./data-slots"

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
