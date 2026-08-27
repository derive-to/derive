import { describe, expect, it } from "vitest"
import { isValidExportRecipient } from "./export-dialog"
import { exportChoices } from "./export-options"

describe("export email recipient validation", () => {
  it("accepts ordinary and reserved-test recipients after trimming", () => {
    expect(isValidExportRecipient(" person@example.com ")).toBe(true)
    expect(isValidExportRecipient("qa+exports@example.test")).toBe(true)
    expect(isValidExportRecipient("person@sub.example.co.uk")).toBe(true)
  })

  it("blocks malformed values before the mutation can emit an opaque schema error", () => {
    for (const value of ["", "not-an-email", "missing@domain", "two@@example.com", "a b@x.com"])
      expect(isValidExportRecipient(value)).toBe(false)
  })
})

describe("export option registry", () => {
  it("keeps page and deck availability in one ordered source of truth", () => {
    expect(exportChoices(false)).toEqual([
      "page_pdf",
      "chart_png",
      "chart_json",
      "chart_csv",
      "email",
    ])
    expect(exportChoices(true)).toEqual(["deck_pdf", "deck_pptx", "page_pdf", "email"])
  })
})
