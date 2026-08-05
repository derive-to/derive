import { describe, expect, it } from "vitest"
import { documentContext, MAP_INSTEAD_OF_SOURCE_CHARS } from "../src/lib/turn-core"

/**
 * WHAT THE MODEL IS SHOWN OF THE DOCUMENT.
 *
 * A revision lane must see the document, or it invents one. But the paste is re-sent on
 * EVERY model call of a turn (up to twelve), so a big document costs its size over and
 * over and reliably exceeds the hosted turn budget before the turn can answer. Above a
 * threshold a lane that can read parts back is given the map instead.
 *
 * The asymmetry is the point: a lane with NO tools always gets the source, because a map
 * it cannot follow is strictly worse than a document it can at least see.
 */

const big = (n: number) =>
  `<!doctype html><html><body>${Array.from(
    { length: n },
    (_, i) => `<h2>Section ${i}</h2><p>${"body text ".repeat(60)}</p>`,
  ).join("")}</body></html>`

describe("documentContext", () => {
  it("pastes a small document whole, whatever the lane can do", () => {
    const src = "<h2>Short</h2><p>tiny</p>"
    for (const canRead of [true, false]) {
      const out = documentContext(src, "index.html", "text/html", canRead)
      expect(out).toContain("BEGIN DOCUMENT")
      expect(out).toContain("tiny")
    }
  })

  it("gives a big document's MAP to a lane that can read parts back", () => {
    const src = big(60)
    expect(src.length).toBeGreaterThan(MAP_INSTEAD_OF_SOURCE_CHARS)
    const out = documentContext(src, "index.html", "text/html", true)
    expect(out).toContain("BEGIN DOCUMENT MAP")
    expect(out).toContain('"ref":"sec:section-0"')
    // The whole point: the body text is NOT in the prompt.
    expect(out).not.toContain("body text body text")
    expect(out.length).toBeLessThan(src.length / 2)
    // And it says how to get the part it does not include.
    expect(out).toContain('node:"<ref>"')
  })

  it("still pastes a big document to a lane with no tools", () => {
    // A map it cannot follow would leave it blind; a big prompt beats a blind model.
    const out = documentContext(big(60), "index.html", "text/html", false)
    expect(out).toContain("BEGIN DOCUMENT")
    expect(out).not.toContain("BEGIN DOCUMENT MAP")
  })

  it("falls back to the paste when a document cannot be mapped", () => {
    // An ambiguous deck (a slide nested inside a slide) throws in the mapper. Losing the
    // document there would be far worse than a large prompt.
    const nested =
      `<html><body><section class="slide"><section class="slide">${"x".repeat(40_000)}` +
      `</section></section><section class="slide">y</section>` +
      `<script>"derive-deck"</script></body></html>`
    const out = documentContext(nested, "index.html", "text/html", true)
    expect(out).toContain("BEGIN DOCUMENT")
    expect(out).not.toContain("BEGIN DOCUMENT MAP")
  })
})
