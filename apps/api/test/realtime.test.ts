import { describe, expect, it } from "vitest"
import { type Backplane, createInProcessBackplane, type DeriveEvent } from "../src/bus"
import { anonName } from "../src/lib/http"
import { inMemoryLimiter, inMemoryRateLimiters } from "../src/lib/rate-limit"
import { bearer, json, jsonAs, publishAs, quotaApp, TEST_TOKEN } from "./helpers"

// The live-cursor frame is the wire contract between viewers: a position plus two
// one-shot signals (gone = "I blurred/left", tap = "I clicked"). There is no cosmetic
// payload — a peer's color is their identity tint, derived from the server-stamped name
// on the receiving side, so nothing about the look rides the wire. The server derives
// the identity itself and clamps x/y. These tests pin that contract by watching the bus.

/** A backplane that records every published frame, delegating the rest in-process. */
const recordingBackplane = (): { backplane: Backplane; frames: DeriveEvent[] } => {
  const inner = createInProcessBackplane()
  const frames: DeriveEvent[] = []
  return {
    frames,
    backplane: {
      ...inner,
      publish(channel, e) {
        frames.push(e)
        inner.publish(channel, e)
      },
    },
  }
}

describe("live cursor frame", () => {
  const seed = async () => {
    const { backplane, frames } = recordingBackplane()
    const { app } = quotaApp("realtime-cursor", { backplane })
    const { short_id } = await (
      await publishAs(app, "<h1>doc</h1>", { visibility: "public" }, bearer(TEST_TOKEN))
    ).json()
    const cursor = (body: unknown) => app.request(`/v1/artifacts/${short_id}/cursor`, json(body))
    const lastCursor = () =>
      [...frames].reverse().find((f) => f.type === "cursor") as
        | (DeriveEvent & Record<string, unknown>)
        | undefined
    return { cursor, lastCursor }
  }

  it("derives identity, strips any cosmetic fields, and passes position through", async () => {
    const { cursor, lastCursor } = await seed()
    // A legacy client may still send color/kind/emoji; the schema strips them silently.
    expect((await cursor({ id: "a", kind: "emoji", emoji: "🦊", x: 0.5, y: 0.5 })).status).toBe(204)
    const f = lastCursor()
    expect(f).toMatchObject({ type: "cursor", x: 0.5, y: 0.5 })
    // The broadcast id is SERVER-derived (matches the presence roster), never the client's
    // `body.id`, so a cursor and its facepile row are one identity.
    expect(f?.id).toMatch(/^anon_/)
    expect(f?.id).not.toBe("a")
    // No look rides the wire — the receiver tints from the name.
    expect(f?.color).toBeUndefined()
    expect(f?.kind).toBeUndefined()
    expect(f?.emoji).toBeUndefined()
  })
})

describe("realtime rate limits", () => {
  it("normal cursor traffic leaves visibility edits available and still checks access", async () => {
    const { app } = quotaApp("realtime-edit-budget", { rateLimit: true })
    const headers = bearer(TEST_TOKEN)
    const { short_id } = await (
      await publishAs(app, "<h1>doc</h1>", { visibility: "public" }, headers)
    ).json()
    const path = `/v1/artifacts/${short_id}`
    // About eleven seconds of movement at the client's 45ms cadence. This used
    // to exhaust the shared 120/min write budget before the Share dialog opened.
    for (let i = 0; i < 250; i++)
      expect((await app.request(`${path}/cursor`, json({ x: 0.5, y: 0.5 }))).status).toBe(204)
    expect((await app.request(`${path}/presence`, json({}))).status).toBe(200)
    const access = { workspaceAccess: "none", linkRole: "none", listed: "none" }
    expect((await app.request(`${path}/access`, jsonAs(headers, access, "PATCH"))).status).toBe(200)
    const record = await (await app.request(path, { headers })).json()
    expect(record.link_role).toBe("none")
    // A separate budget is not an access exemption: the old anonymous reader
    // loses both broadcast routes immediately when the owner removes link access.
    for (const route of ["cursor", "presence"])
      expect((await app.request(`${path}/${route}`, json({ x: 0.5, y: 0.5 }))).status).toBe(404)
  })

  it("bounds realtime floods independently, without disabling edit protection", async () => {
    const { app } = quotaApp("realtime-flood-budget", {
      rateLimit: true,
      rateLimiters: {
        ...inMemoryRateLimiters(),
        realtime: inMemoryLimiter(10_000, 2),
        write: inMemoryLimiter(60_000, 2),
      },
    })
    const headers = { ...bearer(TEST_TOKEN), "x-forwarded-for": "203.0.113.25" }
    const { short_id } = await (
      await publishAs(app, "<h1>doc</h1>", { visibility: "public" }, headers)
    ).json()
    const path = `/v1/artifacts/${short_id}`
    const cursor = () => app.request(`${path}/cursor`, jsonAs(headers, { x: 0.5, y: 0.5 }))
    expect((await cursor()).status).toBe(204)
    expect((await app.request(`${path}/presence`, jsonAs(headers, {}))).status).toBe(200)
    const blocked = await cursor()
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0)
    expect(Number(blocked.headers.get("Retry-After"))).toBeLessThanOrEqual(10)
    const edit = () => app.request(`${path}/access`, jsonAs(headers, { listed: "none" }, "PATCH"))
    expect((await edit()).status).toBe(200)
    expect((await edit()).status).toBe(429)
    // The pre-auth abuse backstop is scoped to the source, not the whole site.
    expect(
      (
        await app.request(
          `${path}/cursor`,
          jsonAs({ "x-forwarded-for": "203.0.113.26" }, { x: 0.5, y: 0.5 }),
        )
      ).status,
    ).toBe(204)
  })
})

// Presence identity is pinned to the guest token the browser carries (`?g=`), so one
// browser is one "viewing now" row — never several phantoms from a cookie raced across a
// page's concurrent mount requests (the bug this replaced). The token is opaque: the
// server derives the handle from it and never trusts it for anything else.
describe("presence identity (one browser = one viewer)", () => {
  const seed = async () => {
    const { app } = quotaApp("realtime-presence", {})
    const { short_id } = await (
      await publishAs(app, "<h1>doc</h1>", { visibility: "public" }, bearer(TEST_TOKEN))
    ).json()
    const roster = async (token?: string) =>
      (
        (await (
          await app.request(
            `/v1/artifacts/${short_id}/presence${token ? `?g=${encodeURIComponent(token)}` : ""}`,
            json({}),
          )
        ).json()) as { viewers: { id: string; name: string }[] }
      ).viewers
    return { roster }
  }

  it("collapses repeated heartbeats from one guest token to a single viewer", async () => {
    const { roster } = await seed()
    const first = await roster("alpha")
    expect(first).toHaveLength(1)
    // Identity + display handle both come from the one token — no id/name split.
    expect(first[0]?.id).toBe("anon_alpha")
    expect(first[0]?.name).toBe(anonName("anon_alpha"))
    // A second beat with the SAME token is the SAME viewer, not a phantom second row.
    const again = await roster("alpha")
    expect(again).toHaveLength(1)
    expect(again[0]?.id).toBe("anon_alpha")
  })

  it("sanitizes + namespaces the token so a client can't forge a real user id", async () => {
    const { roster } = await seed()
    const one = await roster("usr_boss!! drop")
    expect(one).toHaveLength(1)
    // Punctuation/whitespace stripped, then namespaced under anon_ — can never equal usr_boss.
    expect(one[0]?.id).toBe("anon_usr_bossdrop")
  })
})
