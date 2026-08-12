import { describe, expect, it } from "vitest"
import { fillTemplateSource, unsafeHtmlTemplateBindings } from "./fill"

const inputs = [
  { name: "Project name", description: "The project", required: true },
  { name: "Audience", description: "Who sees it" },
]

describe("template source filling", () => {
  it("fills human, underscore, and dash spellings without rewriting other bytes", () => {
    const source = "A {{Project name}} B {{project_name}} C {{project-name}} D {{Unknown}}"
    expect(fillTemplateSource(source, inputs, { "Project name": "Atlas" }, "md")).toBe(
      "A Atlas B Atlas C Atlas D {{Unknown}}",
    )
  })

  it("treats replacement metacharacters as ordinary text", () => {
    expect(fillTemplateSource("{{Audience}}", inputs, { Audience: "$& $` $'" }, "md")).toBe(
      "$& $` $'",
    )
  })

  it("escapes HTML-looking text while preserving CSS, JS, and deck protocol bytes", () => {
    const source =
      '<style>.x{color:red}</style><h1>{{Project name}}</h1><script>parent.postMessage({source:"derive-deck"},"*")</script>'
    const result = fillTemplateSource(
      source,
      inputs,
      { "Project name": '</h1><script>alert("x")</script>' },
      "html",
    )
    expect(result).toContain("&lt;/h1&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;")
    expect(result).toContain(".x{color:red}")
    expect(result).toContain('source:"derive-deck"')
  })

  it("rejects declared bindings in tags, scripts, or styles", () => {
    const source =
      '<h1 data-name="{{Project name}}">{{Project name}}</h1><script>"{{Audience}}"</script>'
    expect(unsafeHtmlTemplateBindings(source, inputs)).toEqual(["Project name", "Audience"])
  })
})
