import { describe, expect, it } from "vitest"
import {
  ANALYSIS_POLL_MS,
  ANALYSIS_WAIT_MS,
  analysisPollInterval,
  codeRefLabel,
  paperRefLabel,
} from "./analysis-view"

describe("waiting for an analysis a copied prompt asked for", () => {
  const since = 1_000_000

  it("looks every few seconds until one appears or its version moves", () => {
    expect(analysisPollInterval({ since, version: null }, null, since + 60_000)).toBe(
      ANALYSIS_POLL_MS,
    )
    expect(analysisPollInterval({ since, version: null }, 1, since + 60_000)).toBe(false)
    expect(analysisPollInterval({ since, version: 3 }, 3, since + 60_000)).toBe(ANALYSIS_POLL_MS)
    expect(analysisPollInterval({ since, version: 3 }, 4, since + 60_000)).toBe(false)
  })

  it("stops after a while, and never polls without a copied prompt", () => {
    expect(analysisPollInterval({ since, version: null }, null, since + ANALYSIS_WAIT_MS + 1)).toBe(
      false,
    )
    expect(analysisPollInterval(null, null, since)).toBe(false)
  })
})

describe("reference labels", () => {
  it("reads a code reference and a paper reference the way a person scans them", () => {
    expect(codeRefLabel({ path: "src/model.py", symbol: "class Encoder", lines: "40-88" })).toBe(
      "src/model.py · class Encoder · lines 40-88",
    )
    expect(codeRefLabel({ path: "train.py", symbol: null, lines: null })).toBe("train.py")
    expect(paperRefLabel({ section: "main.tex#method", heading: "Method", label: "eq:loss" })).toBe(
      "Method · eq:loss",
    )
    expect(paperRefLabel({ section: "main.tex", heading: null, label: null })).toBe("main.tex")
  })
})
