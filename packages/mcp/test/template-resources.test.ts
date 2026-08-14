import { describe, expect, it } from "vitest"
import type { TemplateResourceRegistrar } from "../src/template-resources"
import {
  registerTemplateResources,
  registerWorkspaceTemplateResources,
} from "../src/template-resources"

describe("stdio Template resources", () => {
  it("registers one portable catalog and a lazy source-bearing entry route", async () => {
    const registrations: unknown[][] = []
    const server = {
      registerResource: (...args: unknown[]) => {
        registrations.push(args)
      },
    } as TemplateResourceRegistrar
    registerTemplateResources(server)

    expect(registrations).toHaveLength(2)
    expect(registrations.map((args) => args[0])).toEqual(["templates:catalog", "templates:entry"])
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

    const entry = registrations.find(([name]) => name === "templates:entry")
    if (!entry) throw new Error("entry route was not registered")
    const exact = await (
      entry[3] as (uri: URL, variables: { id: string }) => Promise<{ contents: { text: string }[] }>
    )(new URL("derive://templates/decision-memo"), { id: "decision-memo" })
    expect(JSON.parse(exact.contents[0]?.text ?? "{}")).toMatchObject({
      template: { template_id: "decision-memo" },
      starter: { mime_type: "text/markdown" },
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

    registerWorkspaceTemplateResources(server, client as never)

    expect(requests).toBe(0)
    expect(registrations).toHaveLength(3)
    expect(registrations.map((args) => args[0])).toEqual([
      "template-libraries:catalog",
      "template-library",
      "template-library-entry",
    ])
  })
})
