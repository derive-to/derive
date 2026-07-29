import { describe, expect, it } from "vitest"
import { collectRender } from "../src/lib/collect-render"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// PUBLISH → SEE IT, in one call.
//
// The publish-then-look-at-it loop was two calls and a guess at how long to sleep, and a
// human can shortcut it by opening the tab while an agent cannot. `render` folds the
// screenshot into the publish response; without it the response is byte-for-byte what it
// always was, so no existing caller changes shape.

const owner: TestUser = { id: "u_pr", email: "pr@derive.test", name: "Owner" }
type App = ReturnType<typeof makeAuthedApp>["app"]

const callRaw = async (
  app: App,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
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
  return out?.result as { content?: { type: string; text?: string }[]; isError?: boolean }
}

const setup = async (name: string) => {
  const { app, meta } = makeAuthedApp(name, [owner], "editor")
  await app.request("/v1/me", { headers: as(owner.email) })
  const bot = await (
    await app.request("/v1/agents", jsonAs(as(owner.email), { name: "PrBot", role: "editor" }))
  ).json()
  return { app, meta, token: bot.token as string }
}

describe("publish carries its own render", () => {
  it("without `render`, the response is unchanged — one text block, no image", async () => {
    const { app, token } = await setup("pubrender-off")
    const r = await callRaw(app, token, "publish", { title: "Plain", content: "# Plain\n\nbody" })
    expect(r?.content).toHaveLength(1)
    expect(r?.content?.[0]?.type).toBe("text")
    const body = JSON.parse(r?.content?.[0]?.text ?? "{}")
    expect(body.published).toBe(true)
    // The pointer to go look is still there for anyone who wants the old loop.
    expect(body.render).toContain("read(")
  })

  it("refuses an unknown variant by name rather than on a schema check", async () => {
    const { app, token } = await setup("pubrender-bad")
    const r = await callRaw(app, token, "publish", {
      title: "Bad",
      content: "# Bad\n\nbody",
      render: "thumbnail",
    })
    expect(r?.isError).toBe(true)
    expect(r?.content?.[0]?.text).toContain("top, full, marked")
  })

  it("falls back to the ordinary response when the shot isn't ready in time", async () => {
    // Nothing renders in this harness, so `wait:0` is the not-ready path: a publish must
    // still SUCCEED and report itself when the picture can't be had.
    const { app, token } = await setup("pubrender-slow")
    const r = await callRaw(app, token, "publish", {
      title: "Slow",
      content: "# Slow\n\nbody",
      render: "top",
      wait: 0,
    })
    expect(r?.isError).toBeFalsy()
    expect(r?.content).toHaveLength(1)
    const body = JSON.parse(r?.content?.[0]?.text ?? "{}")
    expect(body.published).toBe(true)
    // And it says WHY there is no picture. The generic "queued — call read(...)" pointer
    // ignores that a render was asked for, and reads as though nothing was requested.
    expect(body.render).toContain("not waited for")
  })

  it("says the wait ELAPSED when one was given and the shot still didn't land", async () => {
    const { app, token } = await setup("pubrender-elapsed")
    const r = await callRaw(app, token, "publish", {
      title: "Elapsed",
      content: "# Elapsed\n\nbody",
      render: "top",
      wait: 1,
    })
    const body = JSON.parse(r?.content?.[0]?.text ?? "{}")
    expect(body.published).toBe(true)
    expect(body.render).toContain("not ready within 1s")
  })

  it("accepts a wait sent as a STRING, the way a stale client sends it", async () => {
    // The bug this change exists for. A client that connected before `wait` existed has no
    // type to coerce against, so it sends "1". A bare z.number() rejects that — the render
    // can be requested and never waited for, which is half-reachable and reads as broken.
    const { app, token } = await setup("pubrender-string-wait")
    const r = await callRaw(app, token, "publish", {
      title: "Stringy",
      content: "# Stringy\n\nbody",
      render: "top",
      wait: "1",
    })
    expect(r?.isError).toBeFalsy()
    const body = JSON.parse(r?.content?.[0]?.text ?? "{}")
    expect(body.published).toBe(true)
    expect(body.render).toContain("not ready within 1s")
  })
})

describe("collectRender", () => {
  it("returns the bytes once ready, and SNIFFS the type instead of assuming png", async () => {
    // JPEG magic bytes. The variants are PNG today, but the read path used to HARDCODE
    // image/png, so this pins that it reports what the bytes actually are — the moment a
    // variant is ever stored as anything else, a hardcode would mislabel it silently.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
    const meta = {
      getVersion: async () => ({ preview_key: "k", preview_status: "ready" }),
    } as unknown as Parameters<typeof collectRender>[0]["meta"]
    const blobs = { get: async () => jpeg, put: async () => "k" } as unknown as Parameters<
      typeof collectRender
    >[0]["blobs"]

    const got = await collectRender({ meta, blobs }, "art_1", 1, "top", 5)
    expect(got?.mimeType).toBe("image/jpeg")
    expect(got?.bytes).toEqual(jpeg)
  })

  it("gives up immediately on a failed variant instead of burning the whole wait", async () => {
    const { app, meta, token } = await setup("collect-failed")
    const pub = JSON.parse(
      (await callRaw(app, token, "publish", { title: "Dead", content: "# Dead\n\nbody" }))
        ?.content?.[0]?.text ?? "{}",
    )
    const art = await meta.getByShortId(pub.short_id)
    if (!art) throw new Error("artifact missing")
    await meta.setVersionPreview(art.id, pub.version, {
      preview_status: "failed",
      preview_error: "boom",
    })
    const started = Date.now()
    const got = await collectRender(
      { meta, blobs: { get: async () => null, put: async () => "" } },
      art.id,
      pub.version,
      "top",
      30,
    )
    // Null, and fast: a failed variant will never become ready by waiting for it.
    expect(got).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
