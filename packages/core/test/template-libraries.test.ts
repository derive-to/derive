import { describe, expect, it } from "vitest"
import { parseTemplateLibraryUri, templateLibraryUri } from "../src/template-libraries"

describe("authored template library URIs", () => {
  it("round-trips canonical library and entry addresses", () => {
    expect(parseTemplateLibraryUri(templateLibraryUri("tlb_one"))).toEqual({ libraryId: "tlb_one" })
    expect(parseTemplateLibraryUri(templateLibraryUri("tlb_one", "tpl-two"))).toEqual({
      libraryId: "tlb_one",
      entryId: "tpl-two",
    })
  })

  it.each([
    "derive://template-libraries",
    "derive://template-libraries/lib/",
    "derive://template-libraries/lib/entry/extra",
    "derive://template-libraries/lib/entry?x=1",
    "derive://template-libraries/lib/entry#x",
    "derive://template-libraries/lib with spaces/entry",
  ])("rejects a non-canonical URI: %s", (uri) => {
    expect(parseTemplateLibraryUri(uri)).toBeNull()
  })
})
