import { describe, expect, it } from "vitest"
import type { TemplateResourceRegistrar } from "../src/template-resources"
import { registerTemplateResources } from "../src/template-resources"

describe("stdio Template resources", () => {
  it("registers the portable catalog and exact source-bearing entry set", async () => {
    const registrations: Parameters<TemplateResourceRegistrar["registerResource"]>[] = []
    const server: TemplateResourceRegistrar = {
      registerResource: (...args) => {
        registrations.push(args)
      },
    }
    registerTemplateResources(server)

    expect(registrations).toHaveLength(31)
    expect(registrations.map(([, uri]) => uri)).toContain("derive://templates/narrative-pitch")
    expect(registrations.map(([, uri]) => uri)).toContain(
      "derive://templates/weekly-research-context",
    )
    const catalog = registrations.find(([, uri]) => uri === "derive://templates/catalog")
    if (!catalog) throw new Error("catalog was not registered")
    expect(catalog[2].annotations).toEqual({ audience: ["assistant"], priority: 0.85 })
    const body = await catalog[3](new URL(catalog[1]))
    expect(JSON.parse(body.contents[0]?.text ?? "{}")).toMatchObject({
      counts: { artifacts: 24, contexts: 6 },
      library: { id: "derive/built-ins" },
    })
  })
})
