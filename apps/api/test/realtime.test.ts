import { describe, expect, it } from "vitest"
import { type Backplane, createInProcessBackplane, type DeriveEvent } from "../src/bus"
import { anonName } from "../src/lib/http"
import { bearer, json, publishAs, quotaApp, TEST_TOKEN } from "./helpers"

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
