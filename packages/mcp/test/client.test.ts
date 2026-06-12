import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { serve } from "@hono/node-server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createApp } from "@dock/api/app"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { createClient, type DockClient } from "../src/client"

let server: ReturnType<typeof serve>
let meta: SqliteMetaStore
let client: DockClient
const dir = mkdtempSync(join(tmpdir(), "dock-mcp-"))

beforeAll(async () => {
  meta = new SqliteMetaStore(join(dir, "dock.db"))
  const app = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://dock.test",
  })
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  client = createClient({ baseUrl: `http://localhost:${port}` })
})

afterAll(() => {
  server.close()
  meta.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("dock client (the MCP server's backend) over real HTTP", () => {
  let shortId: string

  it("publishes and reads content back", async () => {
    const a = await client.publish({ content: "# Hello", filename: "hello.md", title: "Hello" })
    shortId = a.short_id
    expect(a.current_version).toBe(1)
    expect(a.kind).toBe("file")
    expect(await client.getContent(shortId)).toBe("# Hello")
  })

  it("publishes a new version and reads each version back", async () => {
    const a = await client.publish({
      id: shortId,
      content: "# Hello v2",
      filename: "hello.md",
      message: "update",
    })
    expect(a.current_version).toBe(2)
    expect(await client.getContent(shortId, 1)).toBe("# Hello")
    expect(await client.getContent(shortId, 2)).toBe("# Hello v2")
  })

  it("lists version history with messages", async () => {
    const a = await client.get(shortId)
    expect(a.versions.map((v) => v.n)).toEqual([1, 2])
    expect(a.versions[1].message).toBe("update")
  })

  it("runs the comment loop: comment, read back, resolve on republish", async () => {
    const a = await client.publish({ content: "# spec", filename: "spec.md", title: "Spec" })
    const c1 = await client.createComment(a.short_id, {
      body_md: "tighten the intro",
      author: "jess",
      anchor: { type: "TextQuoteSelector", exact: "spec" },
    })
    expect(c1.state).toBe("open")

    // agent reads the open feedback
    const open = await client.listComments(a.short_id, "open")
    expect(open).toHaveLength(1)
    expect(open[0].body_md).toBe("tighten the intro")

    // agent republishes, resolving the thread in the same call
    const v2 = await client.publish({
      id: a.short_id,
      content: "# spec v2",
      filename: "spec.md",
      message: "address",
      resolves: [c1.id],
    })
    expect(v2.current_version).toBe(2)
    expect(await client.listComments(a.short_id, "open")).toHaveLength(0)
  })

  it("surfaces server errors as thrown messages", async () => {
    await expect(client.get("nope0000")).rejects.toThrow(/dock 404/)
  })
})
