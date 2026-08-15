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
    expect(registrations).toHaveLength(4)
    expect(registrations.map((args) => args[0])).toEqual([
      "template-libraries:catalog",
      "template-libraries:page",
      "template-library",
      "template-library-entry",
    ])
  })

  it("continues a truncated authored-library catalog through a resource URI", async () => {
    const registrations: unknown[][] = []
    const cursors: Array<string | undefined> = []
    const server = {
      registerResource: (...args: unknown[]) => {
        registrations.push(args)
      },
    } as TemplateResourceRegistrar
    const cursor = "2026-08-13T12:00:00.000Z~tlb_next"
    const client = {
      listTemplateLibraries: async (value?: string) => {
        cursors.push(value)
        return {
          libraries: [],
          truncated: value === undefined,
          next_cursor: value === undefined ? cursor : null,
        }
      },
    }
    registerWorkspaceTemplateResources(server, client as never)

    const catalog = registrations.find(([name]) => name === "template-libraries:catalog")
    const page = registrations.find(([name]) => name === "template-libraries:page")
    if (!catalog || !page) throw new Error("catalog resources were not registered")
    const first = await (catalog[3] as (uri: URL) => Promise<{ contents: { text: string }[] }>)(
      new URL("derive://template-libraries"),
    )
    const firstBody = JSON.parse(first.contents[0]?.text ?? "{}") as { next_uri?: string }
    expect(firstBody.next_uri).toBe(
      `derive://template-libraries?cursor=${encodeURIComponent(cursor)}`,
    )
    await (
      page[3] as (
        uri: URL,
        variables: { cursor: string },
      ) => Promise<{ contents: { text: string }[] }>
    )(new URL(firstBody.next_uri as string), { cursor: encodeURIComponent(cursor) })
    expect(cursors).toEqual([undefined, cursor])
  })
})
