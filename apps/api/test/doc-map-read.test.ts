import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deriveFacts } from "@derive/core"
import { afterAll, describe, expect, it } from "vitest"
import { appWithGrant } from "./mcp-helpers"

/**
 * THE DOC MAP OVER THE WIRE.
 *
 * `read map:true` hands back a document's addressable parts; `read node:` hands back one of
 * them. The properties worth pinning at this layer are the ones a unit test cannot see:
 * that the refs a map returns are exactly the refs `node` accepts, that a bad ref fails
 * with the list of good ones, and that the same structure is reachable as a plain URL with
 * no MCP session at all (which is the point of shipping it as a derived fact).
 */

const dir = mkdtempSync(join(tmpdir(), "derive-doc-map-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type App = ReturnType<typeof appWithGrant>["app"]

const rpc = async (app: App, token: string, body: unknown) => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const ct = res.headers.get("content-type") ?? ""
  const txt = await res.text()
  return ct.includes("application/json")
    ? JSON.parse(txt)
    : JSON.parse(
        (txt.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim(),
      )
}

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "vitest", version: "1.0.0" },
  },
}

const readTool = async (
  app: App,
  token: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> => {
  const out = await rpc(app, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "read", arguments: args },
  })
  const r = out?.result as { content?: { text: string }[]; isError?: boolean } | undefined
  const t = r?.content?.[0]?.text
  if (t == null) throw new Error(`no tool text: ${JSON.stringify(out)}`)
  return { text: t, isError: !!r?.isError }
}

// biome-ignore lint/suspicious/noExplicitAny: test convenience over a JSON payload
const readJson = async (app: App, token: string, args: Record<string, unknown>): Promise<any> =>
  JSON.parse((await readTool(app, token, args)).text)

const DECK = `<!doctype html><html><head><title>d</title><style>.slide{opacity:0}</style></head><body>
  <section class="slide" data-derive-slide="0"><h2>The problem</h2><p>one</p></section>
  <section class="slide" data-derive-slide="1"><h2>The ask</h2><p>two</p></section>
<script>parent.postMessage({source:"derive-deck",type:"state",i:0,total:2},"*")</script>
</body></html>`

/** A published deck plus a ready MCP session. */
const setup = async (name: string) => {
  const { app, meta, token } = appWithGrant(dir, name, "openid derive:read derive:publish")
  await rpc(app, token, initBody)
  await meta.setMembership({ id: "m_o", org_id: "default", user_id: "u_o", role: "owner" })
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(DECK)]), "deck.html")
  form.append("title", "Deck")
  const res = await app.request("/v1/artifacts", {
    method: "POST",
    body: form,
    headers: { authorization: `Bearer ${token}` },
  })
  const { short_id } = (await res.json()) as { short_id: string }
  return { app, token, short_id, meta }
}

describe("read map / node", () => {
  it("maps a deck, and every ref it returns resolves", async () => {
    const { app, token, short_id } = await setup("map-read")
    const map = await readJson(app, token, { short_id, map: true })
    expect(map.kind).toBe("deck")
    const refs = (map.nodes as { ref: string }[]).map((n) => n.ref)
    expect(refs).toContain("slide:1")
    expect(refs).toContain("slide:2")
    expect(refs).toContain("style:1")
    // Steering lives in the RESPONSE, so the tool description stays small and the surface
    // teaches itself at the moment it is used.
    expect(map.note).toContain("node:")

    for (const ref of refs) {
      const one = await readJson(app, token, { short_id, node: ref })
      expect(one.node).toBe(ref)
      expect(one.bytes).toBeGreaterThan(0)
    }
  })

  it("returns one slide's exact source, far under a full read", async () => {
    const { app, token, short_id } = await setup("map-node-src")
    const one = await readJson(app, token, { short_id, node: "slide:2", format: "html" })
    expect(one.body).toContain('data-derive-slide="1"')
    expect(one.body).toContain("The ask")
    expect(one.body).not.toContain("The problem")
    expect(one.body.length).toBeLessThan(DECK.length / 2)
  })

  it("names the refs you could have used when one does not exist", async () => {
    const { app, token, short_id } = await setup("map-bad-ref")
    const bad = await readTool(app, token, { short_id, node: "slide:9" })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain("slide:1")
  })

  it("refuses map alongside the whole-document views", async () => {
    const { app, token, short_id } = await setup("map-excl")
    expect((await readTool(app, token, { short_id, map: true, node: "slide:1" })).isError).toBe(
      true,
    )
    expect((await readTool(app, token, { short_id, map: true, section: "*" })).isError).toBe(true)
  })

  it("serves the map as a plain URL, no MCP session needed", async () => {
    // The point of shipping the map as a derived FACT rather than only a tool response:
    // any script or pipeline reads a document's shape with a GET.
    //
    // The row is seeded directly here rather than published into place: this harness does
    // not await the post-publish derivation pass (every derived slot, `$outline` included,
    // is absent right after a publish in-process), so seeding is what isolates the ROUTE.
    // That deriveFacts actually emits `$map` is pinned in packages/core's own suite.
    const { app, token, short_id, meta } = await setup("map-url")
    const art = await meta.getByShortId(short_id)
    const source = DECK
    const row = deriveFacts(source, "text/html").find((f) => f.slot === "$map")
    expect(row).toBeDefined()
    await meta.setVersionData((art as { id: string }).id, 1, [
      {
        id: "vd_map",
        slot: "$map",
        json: (row as { json: string }).json,
        size_bytes: (row as { bytes: number }).bytes,
        gen: (row as { gen: number }).gen,
      },
    ])
    const res = await app.request(`/raw/${short_id}/data/$map.json`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { kind: string; nodes: { ref: string }[] }
    expect(json.kind).toBe("deck")
    expect(json.nodes.map((n) => n.ref)).toContain("slide:2")
  })
})
