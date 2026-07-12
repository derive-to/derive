import { describe, expect, it } from "vitest"
import { type Backplane, createInProcessBackplane, type DeriveEvent } from "../src/bus"
import { anonName } from "../src/lib/http"
import { bearer, json, publishAs, quotaApp, TEST_TOKEN } from "./helpers"

// The live-cursor frame is the wire contract between viewers: it carries a chosen
// look (kind + emoji) plus two one-shot signals (gone = "I blurred/left", tap =
// "I clicked"). The server passes the cosmetic fields through but keeps them
// bounded, and — as everywhere — derives the identity name itself. These tests
// pin that contract by watching what gets published on the bus.

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

  it("passes an emoji look through and defaults the rest", async () => {
    const { cursor, lastCursor } = await seed()
    expect((await cursor({ id: "a", kind: "emoji", emoji: "🦊", x: 0.5, y: 0.5 })).status).toBe(204)
    const f = lastCursor()
    expect(f).toMatchObject({ type: "cursor", kind: "emoji", emoji: "🦊" })
    // The broadcast id is SERVER-derived (matches the presence roster), never the client's
    // `body.id` — that's what lets "follow this peer" line up with their facepile row.
    expect(f?.id).toMatch(/^anon_/)
    expect(f?.id).not.toBe("a")
    // color falls back to the server default; x/y survive.
    expect(f?.color).toBe("#655999")
    expect(f).toMatchObject({ x: 0.5, y: 0.5 })
  })

  it("carries the scroll fraction (sf) so peers can follow, and clamps it 0..1", async () => {
    const { cursor, lastCursor } = await seed()
    await cursor({ id: "a", sf: 0.42, x: 0.1, y: 0.2 })
    expect(lastCursor()?.sf).toBe(0.42)
    // Out-of-range sf is rejected by the schema (0..1), so a bad client can't warp follow.
    expect((await cursor({ id: "a", sf: 1.5, x: 0, y: 0 })).status).toBe(400)
  })

  it("passes `live` through so a scroll with the mouse off the doc updates sf, not the cursor", async () => {
    const { cursor, lastCursor } = await seed()
    // A bare scroll (pointer not over the doc) carries live:false — peers consume sf but
    // don't render/move the cursor. The server must forward the flag verbatim.
    await cursor({ id: "a", sf: 0.7, live: false, x: 0.1, y: 0.2 })
    expect(lastCursor()?.live).toBe(false)
    expect(lastCursor()?.sf).toBe(0.7)
  })

  it("defaults kind to arrow and never forwards an emoji for an arrow cursor", async () => {
    const { cursor, lastCursor } = await seed()
    // Even if a client sends an emoji with an arrow kind, it isn't forwarded.
    await cursor({ id: "b", kind: "arrow", emoji: "🦊", x: 0.1, y: 0.2 })
    expect(lastCursor()).toMatchObject({ kind: "arrow" })
    expect(lastCursor()?.emoji).toBeUndefined()
    // Omitted kind → arrow.
    await cursor({ id: "b", x: 0.3, y: 0.4 })
    expect(lastCursor()).toMatchObject({ kind: "arrow" })
  })

  it("forwards the gone (leave) and tap signals as present-only flags", async () => {
    const { cursor, lastCursor } = await seed()
    expect((await cursor({ id: "c", gone: true, x: 0.5, y: 0.5 })).status).toBe(204)
    expect(lastCursor()?.gone).toBe(true)

    await cursor({ id: "c", tap: true, x: 0.5, y: 0.5 })
    expect(lastCursor()?.tap).toBe(true)

    // A plain move carries neither flag (so peers branch on truthiness).
    await cursor({ id: "c", x: 0.6, y: 0.6 })
    expect(lastCursor()?.gone).toBeUndefined()
    expect(lastCursor()?.tap).toBeUndefined()
  })

  it("rejects an out-of-bounds look (oversized emoji, unknown kind)", async () => {
    const { cursor } = await seed()
    expect((await cursor({ id: "d", emoji: "x".repeat(64), x: 0, y: 0 })).status).toBe(400)
    expect((await cursor({ id: "d", kind: "rainbow", x: 0, y: 0 })).status).toBe(400)
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

  it("keeps distinct guest tokens (e.g. a private tab) as distinct viewers", async () => {
    const { roster } = await seed()
    await roster("alpha")
    const both = await roster("beta")
    expect(both.map((v) => v.id).sort()).toEqual(["anon_alpha", "anon_beta"])
  })

  it("sanitizes + namespaces the token so a client can't forge a real user id", async () => {
    const { roster } = await seed()
    const one = await roster("usr_boss!! drop")
    expect(one).toHaveLength(1)
    // Punctuation/whitespace stripped, then namespaced under anon_ — can never equal usr_boss.
    expect(one[0]?.id).toBe("anon_usr_bossdrop")
  })
})
