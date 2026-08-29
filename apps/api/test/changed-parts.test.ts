import type { DocNode } from "@derive/core"
import { describe, expect, it, vi } from "vitest"

import { changedParts, changedPartsWithReceipt } from "../src/lib/changed-parts"

const page = (value: string): string =>
  `<!doctype html><html><body>${Array.from(
    { length: 20 },
    (_, i) => `<section id="s${i}"><h2>Part ${i}</h2><p>${value} ${i}</p></section>`,
  ).join("\n")}</body></html>`

describe("changed parts", () => {
  it("reuses an immutable receipt without rematerializing its body", () => {
    const materialize = vi.fn((change: "added" | "changed" | "moved", node: DocNode) => ({
      change,
      node: node.ref,
      type: node.type,
    }))
    const before = "<section id='a'><h2>A</h2><p>Before</p></section>"
    const after = "<section id='a'><h2>A</h2><p>After</p></section>"
    const first = changedPartsWithReceipt(
      "before-cache-test",
      before,
      "text/html",
      "after-cache-test",
      after,
      "text/html",
      materialize,
    )
    const second = changedPartsWithReceipt(
      "before-cache-test",
      "ignored",
      "text/html",
      "after-cache-test",
      "ignored",
      "text/html",
      () => {
        throw new Error("cached receipt rematerialized")
      },
    )
    expect(second).toBe(first)
    expect(materialize).toHaveBeenCalledTimes(1)
  })

  it("counts a full rewrite but materializes only the three returned bodies", () => {
    const materialize = vi.fn((change: "added" | "changed" | "moved", node: DocNode) => ({
      change,
      node: node.ref,
      type: node.type,
    }))
    const result = changedParts(
      page("Before"),
      "text/html",
      page("After"),
      "text/html",
      materialize,
    )

    expect(result).toMatchObject({ count: 20, truncated: true, more_changes: 17 })
    expect(result.changes).toHaveLength(3)
    expect(materialize).toHaveBeenCalledTimes(3)
  })

  it("reports the moved slide without treating shifted neighbours as moves", () => {
    const slide = (id: number) =>
      `<section class="slide" data-derive-slide="${id}"><h2>Slide ${id}</h2></section>`
    const wrap = (ids: number[]) =>
      `<!doctype html><html><body>${ids.map(slide).join("\n")}<script>derive-deck</script></body></html>`

    const inserted = changedParts(
      wrap([0, 10, 20, 30]),
      "text/x-derive-deck",
      wrap([0, 40, 10, 20, 30]),
      "text/x-derive-deck",
    )
    expect(inserted).toMatchObject({ count: 1 })
    expect(inserted.changes).toEqual([
      expect.objectContaining({ change: "added", node: "slide:2", title: "Slide 40" }),
    ])

    const moved = changedParts(
      wrap([0, 40, 10, 20, 30]),
      "text/x-derive-deck",
      wrap([0, 30, 40, 10, 20]),
      "text/x-derive-deck",
    )
    expect(moved).toMatchObject({ count: 1 })
    expect(moved.changes).toEqual([
      expect.objectContaining({
        change: "moved",
        node: "slide:2",
        from_node: "slide:5",
        title: "Slide 30",
      }),
    ])

    const removed = changedParts(
      wrap([0, 30, 40, 10, 20]),
      "text/x-derive-deck",
      wrap([0, 30, 10, 20]),
      "text/x-derive-deck",
    )
    expect(removed).toMatchObject({ count: 1 })
    expect(removed.changes).toEqual([
      expect.objectContaining({ change: "removed", node: "slide:3", title: "Slide 40" }),
    ])
  })

  it("returns the changed Markdown section with its reusable ref", () => {
    const result = changedParts(
      "# Plan\n\nBefore.\n\n## Limits\n\nKeep.",
      "text/markdown",
      "# Plan\n\nAfter.\n\n## Limits\n\nKeep.",
      "text/markdown",
    )

    expect(result).toMatchObject({ count: 1 })
    expect(result.changes).toEqual([
      expect.objectContaining({ change: "changed", node: "sec:plan", title: "Plan" }),
    ])
    expect(result.changes[0]?.body).toContain("After.")
  })

  it("refuses ambiguous authored identity instead of returning a false receipt", () => {
    const duplicate = `<!doctype html><html><body>
      <section><h2 id="same">One</h2></section>
      <section><h2 id="same">Two</h2></section>
    </body></html>`

    expect(() => changedParts(duplicate, "text/html", duplicate, "text/html")).toThrow(
      "share stable identity",
    )
  })
})
