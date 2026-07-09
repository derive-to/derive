import { describe, expect, it } from "vitest"
import { createBus, createInProcessBackplane, Presence, type Viewer } from "../src/bus"

describe("event bus", () => {
  it("delivers published events to subscribers of that artifact only", () => {
    const bus = createBus()
    const a: unknown[] = []
    const b: unknown[] = []
    bus.subscribe("art_a", (e) => a.push(e))
    bus.subscribe("art_b", (e) => b.push(e))
    bus.publish("art_a", { type: "version.published", n: 2 })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(0)
  })

  it("stops delivering after unsubscribe", () => {
    const bus = createBus()
    const seen: unknown[] = []
    const off = bus.subscribe("x", (e) => seen.push(e))
    bus.publish("x", { type: "presence", viewers: [] })
    off()
    bus.publish("x", { type: "presence", viewers: [] })
    expect(seen).toHaveLength(1)
  })
})

describe("in-process backplane: receipt + long-poll", () => {
  it("publishWithReceipt reports how many live subscribers caught the event", async () => {
    const bp = createInProcessBackplane()
    expect(await bp.publishWithReceipt?.("ch", { type: "artifact.pushed" })).toBe(0)
    const seen: unknown[] = []
    const off1 = bp.subscribe("ch", (e) => seen.push(e))
    bp.subscribe("ch", () => {})
    expect(await bp.publishWithReceipt?.("ch", { type: "artifact.pushed" })).toBe(2)
    expect(seen).toHaveLength(1) // the receipt path still delivers
    off1()
    expect(await bp.publishWithReceipt?.("ch", { type: "artifact.pushed" })).toBe(1)
  })

  it("waitFor wakes on the first matching event and ignores other types", async () => {
    const bp = createInProcessBackplane()
    const woke = bp.waitFor?.("art_1", ["review.sent_back", "review.approved"], 5_000)
    bp.publish("art_1", { type: "comment.reacted" }) // not a wake type
    bp.publish("art_1", { type: "review.sent_back", round_id: "rr_1" })
    const e = await woke
    expect(e).toMatchObject({ type: "review.sent_back", round_id: "rr_1" })
  })

  it("waitFor resolves null on timeout with the subscription cleaned up", async () => {
    const bp = createInProcessBackplane()
    expect(await bp.waitFor?.("art_2", ["review.approved"], 20)).toBeNull()
    // The temporary subscription is gone: a later publish reaches nobody.
    expect(await bp.publishWithReceipt?.("art_2", { type: "review.approved" })).toBe(0)
  })
})

describe("presence", () => {
  const v = (id: string): Viewer => ({ id, name: id, role: "viewer" })
  it("tracks live viewers (keyed by id) and prunes stale ones past the TTL", () => {
    const p = new Presence(1000)
    expect(p.heartbeat("a", v("jess"), 0)).toEqual([v("jess")])
    expect(
      p
        .heartbeat("a", v("sam"), 500)
        .map((x) => x.id)
        .sort(),
    ).toEqual(["jess", "sam"])
    // jess last seen at 0; at t=1600 she's stale (>1000ms), sam stays
    expect(p.heartbeat("a", v("sam"), 1600)).toEqual([v("sam")])
  })

  it("upserts by id, so a viewer's later heartbeat replaces (not duplicates) the row", () => {
    const p = new Presence(1000)
    p.heartbeat("a", { id: "u1", name: "Old", role: "viewer" }, 0)
    const out = p.heartbeat("a", { id: "u1", name: "New", role: "owner" }, 100)
    expect(out).toEqual([{ id: "u1", name: "New", role: "owner" }])
  })
})
