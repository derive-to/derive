import { describe, expect, it } from "vitest"
import { isValidExportRecipient } from "./export-dialog"

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
