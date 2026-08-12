import { describe, expect, it } from "vitest"
import type { TemplateResourceRegistrar } from "../src/template-resources"
import {
  registerTemplateResources,
  registerWorkspaceTemplateResources,
} from "../src/template-resources"

describe("stdio Template resources", () => {
  it("registers the portable catalog and exact source-bearing entry set", async () => {
    const registrations: unknown[][] = []
    const server = {
      registerResource: (...args: unknown[]) => {
        registrations.push(args)
      },
    } as TemplateResourceRegistrar
    registerTemplateResources(server)

    expect(registrations).toHaveLength(31)
    expect(registrations.map(([, uri]) => uri)).toContain("derive://templates/narrative-pitch")
    expect(registrations.map(([, uri]) => uri)).toContain(
      "derive://templates/weekly-research-context",
    )
    const catalog = registrations.find(([, uri]) => uri === "derive://templates/catalog")
    if (!catalog) throw new Error("catalog was not registered")
    expect((catalog[2] as { annotations: unknown }).annotations).toEqual({
      audience: ["assistant"],
      priority: 0.85,
    })
    const body = await (catalog[3] as (uri: URL) => Promise<{ contents: { text: string }[] }>)(
      new URL(String(catalog[1])),
    )
    expect(JSON.parse(body.contents[0]?.text ?? "{}")).toMatchObject({
      counts: { artifacts: 24, contexts: 6 },
      library: { id: "derive/built-ins" },
    })
  })

  it("registers authored-library discovery lazily with constant startup cost", async () => {
    const registrations: unknown[][] = []
    let requests = 0
    const server = {
      registerResource: (...args: unknown[]) => {
        registrations.push(args)
      },
    } as TemplateResourceRegistrar
    const client = new Proxy(
      {},
      {
        get: () => async () => {
          requests++
          return []
        },
      },
    )

    await registerWorkspaceTemplateResources(server, client as never)

    expect(requests).toBe(0)
    expect(registrations).toHaveLength(3)
    expect(registrations.map((args) => args[0])).toEqual([
      "template-libraries:catalog",
      "template-library",
      "template-library-entry",
    ])
  })
})
