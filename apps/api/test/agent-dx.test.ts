import type { MetaStore } from "@derive/core"
import { describe, expect, it } from "vitest"
import { parseManifestSkillPins, stalePins } from "../src/lib/manifest-pins"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// The agent-DX MVP, tested at its three seams: manifest skill-pin parsing +
// staleness (pure), the publish advisory reaching the MCP response note, and the
// read-render self-heal (a dead-lettered render re-queues on read instead of
// demanding a no-op republish).

const owner: TestUser = { id: "u_dx_own", email: "dxown@derive.test", name: "Owner" }

type App = ReturnType<typeof makeAuthedApp>["app"]

// Direct tools/call over the stateless /mcp endpoint (mcp-contexts' shape).
const callRaw = async (
  app: App,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  })
  const ct = res.headers.get("content-type") ?? ""
  const txt = await res.text()
  const out = ct.includes("application/json")
    ? JSON.parse(txt)
    : JSON.parse(
        (txt.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim(),
      )
  const r = out?.result as { content?: { text: string }[]; isError?: boolean } | undefined
  const t = r?.content?.[0]?.text
  if (t == null) throw new Error(`no tool text: ${JSON.stringify(out)}`)
  return { text: t, isError: !!r?.isError }
}
// biome-ignore lint/suspicious/noExplicitAny: test convenience over a JSON payload
const call = async (app: App, token: string, name: string, args = {}): Promise<any> =>
  JSON.parse((await callRaw(app, token, name, args)).text)

const setup = async (name: string) => {
  const { app, meta } = makeAuthedApp(name, [owner], "editor")
  await app.request("/v1/me", { headers: as(owner.email) })
  const bot = await (
    await app.request("/v1/agents", jsonAs(as(owner.email), { name: "DxBot", role: "editor" }))
  ).json()
  return { app, meta, token: bot.token as string }
}

describe("manifest skill pins", () => {
  const MD = `---
skills:
  - id: aaaa1111
    version: 2
  - id: bbbb2222
  - id: "cccc3333"
    version: 5
repos:
  - url: https://example.com/x.git
---
# Manifest body
`

  it("parses ids + version pins out of the frontmatter, narrow rules", () => {
    expect(parseManifestSkillPins(MD)).toEqual([
      { id: "aaaa1111", version: 2 },
      { id: "bbbb2222", version: null },
      { id: "cccc3333", version: 5 },
    ])
    expect(parseManifestSkillPins("# no frontmatter")).toEqual([])
    expect(parseManifestSkillPins("---\nrepos:\n  - url: x\n---\nbody")).toEqual([])
  })

  it("reports only pins that trail the artifact's current version", async () => {
    const versions: Record<string, number> = { aaaa1111: 4, cccc3333: 5 }
    const meta = {
      getByShortId: async (id: string) =>
        versions[id] === undefined ? null : { current_version: versions[id] },
    } as unknown as MetaStore
    const stale = await stalePins(meta, parseManifestSkillPins(MD))
    // aaaa1111 pinned 2 < current 4 = stale; bbbb2222 unpinned = never stale;
    // cccc3333 pinned 5 == current 5 = fresh.
    expect(stale).toEqual([{ short_id: "aaaa1111", pinned: 2, current: 4 }])
  })
})

describe("publish advisories reach the MCP response", () => {
  it("an expiring upload URL embedded in content is called out in the note", async () => {
    const { app, token } = await setup("dx-advisory")
    const res = await call(app, token, "publish", {
      title: "Page",
      filename: "index.html",
      content:
        '<meta name="viewport" content="width=device-width"><img src="https://derive.test/v1/assets/t/abc.def">',
    })
    expect(res.published).toBe(true)
    expect(res.note).toContain("UPLOAD url")
  })
})

describe("read render self-heal", () => {
  it("a dead-lettered render re-queues on read instead of demanding a republish", async () => {
    const { app, meta, token } = await setup("dx-render-heal")
    const pub = await call(app, token, "publish", {
      title: "Healed",
      filename: "index.html",
      content: '<meta name="viewport" content="width=device-width"><h1>hi</h1>',
    })
    const a = await meta.getByShortId(pub.short_id)
    if (!a) throw new Error("artifact missing")
    // Drain whatever the publish itself enqueued, then dead-letter the preview.
    const lease = new Date(Date.now() + 60_000).toISOString()
    await meta.claimDueRenderJobs(new Date().toISOString(), 50, lease)
    await meta.setVersionPreview(a.id, pub.version, {
      preview_status: "failed",
      preview_error: "boom (transient)",
    })
    const healed = await callRaw(app, token, "read", { short_id: pub.short_id, render: "top" })
    expect(healed.isError).toBe(true)
    expect(healed.text).toContain("re-queued")
    expect(healed.text).toContain("boom (transient)")
    // The variant was reset to pending (a second read must not say failed again)...
    const v = await meta.getVersion(a.id, pub.version)
    expect(v?.preview_status).toBe("pending")
    // ...and exactly one fresh job is waiting for the worker.
    const jobs = await meta.claimDueRenderJobs(new Date().toISOString(), 50, lease)
    expect(jobs.filter((j) => j.artifact_id === a.id && j.version_n === pub.version)).toHaveLength(
      1,
    )
  })

  it("does NOT re-queue a SUPERSEDED version, which would strand it in pending forever", async () => {
    // The render worker discards a job whose version is no longer current (previews.ts
    // marks it done without rendering). So healing an old version would flip `failed` to
    // `pending` with nothing able to render it, and the heal could never fire again --
    // it only triggers on `failed`. An honest error would become "not ready yet" forever.
    const { app, meta, token } = await setup("dx-render-heal-old")
    const pub = await call(app, token, "publish", {
      title: "Superseded",
      filename: "index.html",
      content: "<h1>v1</h1>",
    })
    const a = await meta.getByShortId(pub.short_id)
    if (!a) throw new Error("artifact missing")
    // Publish a second version, so v1 is no longer current.
    await call(app, token, "publish", { short_id: pub.short_id, content: "<h1>v2</h1>" })
    const after = await meta.getByShortId(pub.short_id)
    expect(after?.current_version).toBe(pub.version + 1)

    const lease = new Date(Date.now() + 60_000).toISOString()
    await meta.claimDueRenderJobs(new Date().toISOString(), 50, lease)
    await meta.setVersionPreview(a.id, pub.version, {
      preview_status: "failed",
      preview_error: "boom (transient)",
    })

    const res = await callRaw(app, token, "read", {
      short_id: pub.short_id,
      version: pub.version,
      render: "top",
    })
    // It still reports the real failure rather than pretending a retry is coming.
    expect(res.isError).toBe(true)
    expect(res.text).toContain("boom (transient)")
    expect(res.text).not.toContain("re-queued")
    // And it must not promise a retry it won't perform. Dogfooding caught the message
    // still saying "reading again re-queues a fresh render" here, which the guard above
    // had just made false: advice that silently does nothing.
    expect(res.text).not.toContain("Reading again re-queues")
    expect(res.text).toContain(`only v${pub.version + 1} re-renders`)
    // The variant KEEPS its failed status: no silent downgrade to a pending it can't leave.
    const v = await meta.getVersion(a.id, pub.version)
    expect(v?.preview_status).toBe("failed")
    // And no doomed job was enqueued for the superseded version.
    const jobs = await meta.claimDueRenderJobs(new Date().toISOString(), 50, lease)
    expect(jobs.filter((j) => j.artifact_id === a.id && j.version_n === pub.version)).toHaveLength(
      0,
    )
  })
})
