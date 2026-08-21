import { describe, expect, it } from "vitest"
import { unsafeHtmlTemplateBindings } from "../src/html-bindings"

const inputs = [
  { name: "Project name", description: "The project", required: true },
  { name: "Audience", description: "Who sees it" },
]

describe("HTML template bindings", () => {
  it("rejects declared bindings in tags, scripts, or styles", () => {
    const source =
      '<h1 data-name="{{Project name}}">{{Project name}}</h1><script>"{{Audience}}"</script>'
    expect(unsafeHtmlTemplateBindings(source, inputs)).toEqual(["Project name", "Audience"])
  })

  it("scans malformed, whitespace-heavy bindings without regex backtracking", () => {
    const source = `{{{{${" ".repeat(20_000)}<div data-name="{{Project name}}">ok</div>`
    expect(unsafeHtmlTemplateBindings(source, inputs)).toEqual(["Project name"])
  })
})
