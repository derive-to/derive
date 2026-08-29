import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DECK_CONTENT_TYPE, deriveFacts } from "@derive/core"
import { afterAll, describe, expect, it, vi } from "vitest"
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
<script type="application/derive-facts" data-fact="email-layout">{"schema":"derive.email/v1","title":"Deck summary","blocks":[{"type":"paragraph","body":"A rich deck email."}]}</script>
<script type="application/derive-facts" data-fact="ignored-deck-fact">{"secret":"not an operational contract"}</script>
</body></html>`

/** A published deck plus a ready MCP session. */
const setup = async (name: string) => {
  const { app, blobs, meta, token } = appWithGrant(dir, name, "openid derive:read derive:publish")
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
  return { app, blobs, token, short_id, meta }
}

const setupDocument = async (name: string, source: string) => {
  const { app, meta, token } = appWithGrant(dir, name, "openid derive:read derive:publish")
  await rpc(app, token, initBody)
  await meta.setMembership({ id: `m_${name}`, org_id: "default", user_id: "u_o", role: "owner" })
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(source)]), "document.html")
  form.append("title", "Large document")
  const res = await app.request("/v1/artifacts", {
    method: "POST",
    body: form,
    headers: { authorization: `Bearer ${token}` },
  })
  const { short_id } = (await res.json()) as { short_id: string }
  return { app, token, short_id }
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

  it("serves a current stored map without rereading the source blob", async () => {
    const { app, blobs, token, short_id, meta } = await setup("map-stored-read")
    const art = await meta.getByShortId(short_id)
    const row = deriveFacts(DECK, DECK_CONTENT_TYPE).find((fact) => fact.slot === "$map")
    expect(art).toBeTruthy()
    expect(row).toBeDefined()
    await meta.setVersionData((art as { id: string }).id, 1, [
      {
        id: "vd_stored_map",
        slot: "$map",
        json: (row as { json: string }).json,
        size_bytes: (row as { bytes: number }).bytes,
        gen: (row as { gen: number }).gen,
      },
    ])
    const get = vi.spyOn(blobs, "get")
    get.mockClear()

    const map = await readJson(app, token, { short_id, map: true })

    expect(map.kind).toBe("deck")
    expect(map.nodes.map((node: { ref: string }) => node.ref)).toContain("slide:2")
    expect(get).not.toHaveBeenCalled()
    get.mockRestore()
  })

  it("falls back to authored source when a stored map is corrupt", async () => {
    const { app, blobs, token, short_id, meta } = await setup("map-corrupt-fallback")
    const art = await meta.getByShortId(short_id)
    const good = deriveFacts(DECK, DECK_CONTENT_TYPE).find((fact) => fact.slot === "$map")
    expect(art).toBeTruthy()
    expect(good).toBeDefined()
    await meta.setVersionData((art as { id: string }).id, 1, [
      {
        id: "vd_corrupt_map",
        slot: "$map",
        json: '{"kind":"deck","bytes":"wrong","nodes":[]}',
        size_bytes: 44,
        gen: (good as { gen: number }).gen,
      },
    ])
    const get = vi.spyOn(blobs, "get")
    get.mockClear()

    const map = await readJson(app, token, { short_id, map: true })

    expect(map.kind).toBe("deck")
    expect(map.nodes.map((node: { ref: string }) => node.ref)).toContain("slide:2")
    expect(get).toHaveBeenCalled()
    get.mockRestore()
  })
})

describe("read focus", () => {
  it("returns one deck slide with the same stable ref that map and node use", async () => {
    const { app, token, short_id } = await setup("focus-deck")

    const focused = await readJson(app, token, { short_id, focus: "The ask" })
    expect(focused.count).toBe(1)
    expect(focused.matches).toHaveLength(1)
    expect(focused.matches[0]).toMatchObject({
      node: "slide:2",
      type: "slide",
      title: "The ask",
    })
    expect(focused.matches[0].body).toContain("two")
    expect(focused.matches[0].body).not.toContain("The problem")

    const exact = await readJson(app, token, {
      short_id,
      focus: "data-derive-slide",
      format: "html",
    })
    expect(exact.count).toBe(2)
    expect(exact.matches.map((match: { node: string }) => match.node)).toEqual([
      "slide:1",
      "slide:2",
    ])
    expect(exact.matches[1].body).toContain('data-derive-slide="1"')
  })

  it("does not change the ordinary small-document read", async () => {
    const source =
      "<!doctype html><html><body><h1>Small note</h1><p>The complete body still returns.</p></body></html>"
    const { app, token, short_id } = await setupDocument("focus-small-baseline", source)

    const ordinary = await readTool(app, token, { short_id })
    expect(ordinary.isError).toBe(false)
    expect(ordinary.text).toContain("Small note")
    expect(ordinary.text).toContain("The complete body still returns.")
  })

  it("locates and reads one complete part of a large HTML document in one call", async () => {
    const sections = Array.from({ length: 80 }, (_, i) => {
      const target = i === 62 ? "<p>The fallback budget is 17 percent.</p>" : ""
      return `<section><h2>Decision ${i + 1}</h2><p>${"routine context ".repeat(40)}</p>${target}</section>`
    }).join("\n")
    const source = `<!doctype html><html><body>${sections}</body></html>`
    const { app, token, short_id } = await setupDocument("focus-large", source)

    const outline = await readJson(app, token, { short_id })
    expect(outline.sections).toHaveLength(80)

    const focused = await readJson(app, token, { short_id, focus: "fallback budget" })
    expect(focused.count).toBe(1)
    expect(focused.matches).toHaveLength(1)
    expect(focused.matches[0]).toMatchObject({
      node: "sec:decision-63",
      title: "Decision 63",
    })
    expect(focused.matches[0].body).toContain("17 percent")
    expect(JSON.stringify(focused).length).toBeLessThan(source.length / 20)
  })

  it("matches visible text across inline markup while returning Markdown", async () => {
    const source =
      "<!doctype html><html><body><h2>The <em>buried</em> decision</h2><p>A &amp; B</p></body></html>"
    const { app, token, short_id } = await setupDocument("focus-visible-text", source)

    const focused = await readJson(app, token, {
      short_id,
      focus: "The buried decision",
    })

    expect(focused.count).toBe(1)
    expect(focused.matches[0]).toMatchObject({
      node: "sec:the-buried-decision",
      title: "The buried decision",
    })
    expect(focused.matches[0].body).toContain("*buried*")
    expect(focused.matches[0].body).toContain("A & B")
  })

  it("bounds repeated matches and treats a missing literal as an empty result", async () => {
    const sections = Array.from(
      { length: 5 },
      (_, i) => `<section><h2>Option ${i + 1}</h2><p>Shared verification receipt.</p></section>`,
    ).join("\n")
    const source = `<!doctype html><html><body>${sections}</body></html>`
    const { app, token, short_id } = await setupDocument("focus-results", source)

    const repeated = await readJson(app, token, { short_id, focus: "verification receipt" })
    expect(repeated.count).toBe(5)
    expect(repeated.matches).toHaveLength(3)
    expect(repeated).toMatchObject({ truncated: true, more_matches: 2 })

    const missing = await readJson(app, token, { short_id, focus: "compaction threshold" })
    expect(missing.count).toBe(0)
    expect(missing.matches).toEqual([])
    expect(missing.next).toContain("No matching part")
  })

  it("refuses a focus combined with another part selector", async () => {
    const { app, token, short_id } = await setup("focus-exclusive")
    for (const extra of [
      { map: true },
      { node: "slide:1" },
      { section: "the-ask" },
      { lines: "1-4" },
    ]) {
      const result = await readTool(app, token, { short_id, focus: "ask", ...extra })
      expect(result.isError, JSON.stringify(extra)).toBe(true)
      expect(result.text).toContain("focus")
    }
  })
})

describe("read: map/node exclusivity with the whole-version views", () => {
  it("refuses render alongside map or node instead of silently rendering", async () => {
    // Found by heavy preview testing: the render branch runs BEFORE the map rung, so the
    // map rung's own guard never fired and read(map, render) answered with a SCREENSHOT —
    // a different question than the one asked.
    const { app, token, short_id } = await setup("map-render")
    for (const args of [
      { short_id, map: true, render: "top" },
      { short_id, node: "slide:1", render: "top" },
    ]) {
      const r = await readTool(app, token, args)
      expect(r.isError, `${JSON.stringify(args)} should refuse`).toBe(true)
      expect(r.text).toContain("pass it alone")
    }
  })
})

describe("a deck carries its derived facts", () => {
  it("persists $map for a DECK, not just for pages", async () => {
    // Found on the preview: a freshly published deck carried no facts at all. Its type is
    // `text/x-derive-deck`, and the facts pipeline gated on a literal text/html check —
    // right while every fact was author-embedded, wrong once $map shipped, since a deck's
    // structure is the thing a map is most useful for.
    const { app, token, short_id } = await setup("deck-facts")
    const one = await readJson(app, token, { short_id, data: "$map" })
    expect(one.fact).toBe("$map")
    expect(one.data.kind).toBe("deck")
    expect((one.data.nodes as { ref: string }[]).map((n) => n.ref)).toContain("slide:1")
  })

  it("persists only the email-layout operational fact from authored deck facts", async () => {
    const { app, token, short_id, meta } = await setup("deck-email-layout-fact")
    const artifact = await meta.getByShortId(short_id)
    const version = await meta.getVersion((artifact as { id: string }).id, 1)
    expect(version?.content_type).toBe(DECK_CONTENT_TYPE)
    expect(
      await meta.getVersionData((artifact as { id: string }).id, 1, "email-layout"),
    ).toHaveLength(1)
    const layout = await readJson(app, token, { short_id, data: "email-layout" })
    expect(layout.fact).toBe("email-layout")
    expect(layout.data).toMatchObject({ schema: "derive.email/v1", title: "Deck summary" })

    const ignored = await readTool(app, token, { short_id, data: "ignored-deck-fact" })
    expect(ignored.text).toContain('No facts "ignored-deck-fact"')
  })
})
