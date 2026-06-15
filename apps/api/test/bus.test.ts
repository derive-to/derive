import { describe, expect, it } from "vitest"
import { createBus, Presence, type Viewer } from "../src/bus"

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
