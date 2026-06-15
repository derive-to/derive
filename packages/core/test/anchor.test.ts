import { describe, expect, it } from "vitest"
import {
  type AnchorThread,
  isAnchored,
  planAnchorSweep,
  quoteSelector,
  reanchor,
} from "../src/anchor"

const text = "Q1 trended down to mean sentiment 3.1 across all channels this quarter."

describe("quoteSelector + reanchor", () => {
  it("builds a selector with surrounding context", () => {
    const i = text.indexOf("mean sentiment 3.1")
    const sel = quoteSelector(text, i, "mean sentiment 3.1".length)
    expect(sel.exact).toBe("mean sentiment 3.1")
    expect(sel.prefix?.endsWith("down to ")).toBe(true)
    expect(sel.suffix?.startsWith(" across")).toBe(true)
  })

  it("re-anchors in unchanged text", () => {
    const i = text.indexOf("mean sentiment 3.1")
    const sel = quoteSelector(text, i, "mean sentiment 3.1".length)
    expect(reanchor(sel, text).found).toBe(true)
  })

  it("re-anchors when surrounding text changed but the quote survived", () => {
    const sel = quoteSelector(text, text.indexOf("mean sentiment 3.1"), "mean sentiment 3.1".length)
    const v2 = "After the migration, mean sentiment 3.1 held across channels."
    expect(reanchor(sel, v2).found).toBe(true)
  })

  it("marks orphaned when the quote is gone", () => {
    const sel = quoteSelector(text, text.indexOf("mean sentiment 3.1"), "mean sentiment 3.1".length)
    const v2 = "We switched to median sentiment 3.6 this quarter."
    expect(reanchor(sel, v2).found).toBe(false)
  })
})

describe("isAnchored", () => {
  it("treats no-anchor and unparseable anchors as anchored", () => {
    expect(isAnchored(null, text)).toBe(true)
    expect(isAnchored("not json", text)).toBe(true)
  })
  it("checks a stored selector against current text", () => {
    const sel = JSON.stringify(quoteSelector(text, text.indexOf("3.1"), 3))
    expect(isAnchored(sel, text)).toBe(true)
    expect(isAnchored(sel, "no numbers here")).toBe(false)
  })
})

describe("planAnchorSweep", () => {
  const anchor = (quote: string) =>
    JSON.stringify(quoteSelector(text, text.indexOf(quote), quote.length))
  const thread = (over: Partial<AnchorThread> = {}): AnchorThread => ({
    thread_id: "t1",
    anchor: anchor("mean sentiment 3.1"),
    state: "open",
    ...over,
  })

  it("outdates an open thread whose quote vanished", () => {
    const gone = "We switched to median sentiment 3.6 this quarter."
    expect(planAnchorSweep([thread()], gone)).toEqual([{ thread_id: "t1", state: "outdated" }])
  })

  it("leaves an open thread alone when its quote survives", () => {
    expect(planAnchorSweep([thread()], text)).toEqual([])
  })

  it("reopens an outdated thread when its quote reappears", () => {
    expect(planAnchorSweep([thread({ state: "outdated" })], text)).toEqual([
      { thread_id: "t1", state: "open" },
    ])
  })

  it("never touches resolved threads or whole-document (un-anchored) threads", () => {
    const gone = "nothing here"
    expect(planAnchorSweep([thread({ state: "resolved" })], gone)).toEqual([])
    expect(planAnchorSweep([thread({ anchor: null })], gone)).toEqual([])
  })
})
