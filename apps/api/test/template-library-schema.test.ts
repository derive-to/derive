import { describe, expect, it } from "vitest"
import { isTemplateLibrarySchemaUnavailable } from "../src/lib/template-library-schema"

describe("template-library schema release sequencing", () => {
  it("recognizes the missing table errors from D1 and Postgres", () => {
    expect(
      isTemplateLibrarySchemaUnavailable(
        new Error("D1_ERROR: no such table: template_library: SQLITE_ERROR"),
      ),
    ).toBe(true)
    expect(
      isTemplateLibrarySchemaUnavailable(
        Object.assign(new Error('relation "template_library_entry" does not exist'), {
          code: "42P01",
        }),
      ),
    ).toBe(true)
    expect(
      isTemplateLibrarySchemaUnavailable(
        new Error("query failed", {
          cause: new Error('relation "template_library" does not exist'),
        }),
      ),
    ).toBe(true)
  })

  it("does not hide unrelated database failures", () => {
    expect(isTemplateLibrarySchemaUnavailable(new Error("connection timed out"))).toBe(false)
    expect(isTemplateLibrarySchemaUnavailable({ code: "23505", message: "duplicate key" })).toBe(
      false,
    )
  })
})
