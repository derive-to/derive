import { mkdtempSync, rmSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "@dock/api/app"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { serve } from "@hono/node-server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createClient, type DockClient } from "../src/client"

let server: ReturnType<typeof serve>
let meta: SqliteMetaStore
let client: DockClient
const dir = mkdtempSync(join(tmpdir(), "dock-mcp-"))

beforeAll(async () => {
  meta = new SqliteMetaStore(join(dir, "dock.db"))
  // The MCP server authenticates to Dock with a static token (DOCK_TOKEN in prod);
  // anonymous callers can't write, so the test wires the same token end-to-end.
  const app = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://dock.test",
    token: "tok",
  })
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  client = createClient({ baseUrl: `http://localhost:${port}`, token: "tok" })
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
    expect(a.versions[1]?.message).toBe("update")
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
    expect(open[0]?.body_md).toBe("tighten the intro")

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

  it("resolves and reopens a thread directly (not just via republish)", async () => {
    const a = await client.publish({ content: "x", filename: "t.md" })
    const c = await client.createComment(a.short_id, { body_md: "fix", author: "jess" })
    await client.setThreadState(a.short_id, c.id, "resolved")
    expect(await client.listComments(a.short_id, "open")).toHaveLength(0)
    await client.setThreadState(a.short_id, c.id, "open")
    expect(await client.listComments(a.short_id, "open")).toHaveLength(1)
  })

  it("leaves an anchored comment as a new thread", async () => {
    const a = await client.publish({ content: "alpha beta", filename: "ac.md" })
    const c = await client.createComment(a.short_id, {
      body_md: "on beta",
      author: "agent",
      anchor: { type: "TextQuoteSelector", exact: "beta" },
    })
    expect(c.thread_id).toBe(c.id) // a brand-new thread
    expect(JSON.parse(c.anchor as string).exact).toBe("beta")
  })

  it("diffs two versions", async () => {
    const a = await client.publish({ content: "# title\nalpha", filename: "d.md" })
    await client.publish({
      id: a.short_id,
      content: "# title\nbeta",
      filename: "d.md",
      message: "v2",
    })
    const d = await client.diff(a.short_id, 1, 2)
    expect(d).toMatchObject({ from: 1, to: 2 })
    expect(d.ops).toContainEqual({ t: "add", line: "beta" })
    expect(d.ops).toContainEqual({ t: "del", line: "alpha" })
  })

  it("restores a past version as a new current revision", async () => {
    const a = await client.publish({ content: "original", filename: "r.md" })
    await client.publish({ id: a.short_id, content: "changed", filename: "r.md", message: "v2" })
    const restored = await client.restore(a.short_id, 1)
    expect(restored.current_version).toBe(3)
    expect(await client.getContent(a.short_id)).toBe("original")
    expect(await client.getContent(a.short_id, 1)).toBe("original") // history intact
  })

  it("includes time-grouped sessions and version names on the detail endpoint", async () => {
    const a = await client.publish({ content: "v1", filename: "s.md" })
    await client.publish({ id: a.short_id, content: "v2", filename: "s.md", message: "edit" })
    const got = await client.get(a.short_id)
    expect(Array.isArray(got.sessions)).toBe(true)
    expect(got.versions[0]).toHaveProperty("name")
  })

  it("surfaces server errors as thrown messages", async () => {
    await expect(client.get("nope0000")).rejects.toThrow(/dock 404/)
  })
})
