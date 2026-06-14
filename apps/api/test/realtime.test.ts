import { describe, expect, it } from "vitest"
import { type Backplane, createInProcessBackplane, type DockEvent } from "../src/bus"
import { bearer, json, publishAs, quotaApp, TEST_TOKEN } from "./helpers"

// The live-cursor frame is the wire contract between viewers: it carries a chosen
// look (kind + emoji) plus two one-shot signals (gone = "I blurred/left", tap =
// "I clicked"). The server passes the cosmetic fields through but keeps them
// bounded, and — as everywhere — derives the identity name itself. These tests
// pin that contract by watching what gets published on the bus.

/** A backplane that records every published frame, delegating the rest in-process. */
const recordingBackplane = (): { backplane: Backplane; frames: DockEvent[] } => {
  const inner = createInProcessBackplane()
  const frames: DockEvent[] = []
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
        | (DockEvent & Record<string, unknown>)
        | undefined
    return { cursor, lastCursor }
  }

  it("passes an emoji look through and defaults the rest", async () => {
    const { cursor, lastCursor } = await seed()
    expect((await cursor({ id: "a", kind: "emoji", emoji: "🦊", x: 0.5, y: 0.5 })).status).toBe(204)
    const f = lastCursor()
    expect(f).toMatchObject({ type: "cursor", id: "a", kind: "emoji", emoji: "🦊" })
    // color falls back to the server default; x/y survive.
    expect(f?.color).toBe("#655999")
    expect(f).toMatchObject({ x: 0.5, y: 0.5 })
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
