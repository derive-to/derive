import { describe, expect, it } from "vitest"
import { LocalBroker, makeBroker } from "../src/index"

describe("LocalBroker", () => {
  it("auto-authorizes a connection bound to a stable per-user ref", async () => {
    const b = new LocalBroker()
    const r = await b.connect({ orgId: "o", userId: "u1", toolkit: "gmail" })
    expect(r.status).toBe("active")
    expect(r.ref).toBe("local:gmail:u1")
  })

  it("toolsFor is least-privilege: only the passed refs' toolkits", async () => {
    const b = new LocalBroker()
    const tools = await b.toolsFor(["local:gmail:u1"])
    expect(tools.map((t) => t.name).sort()).toEqual(["gmail.read", "gmail.write"])
    // A ref you did NOT pass contributes nothing.
    expect(tools.some((t) => t.name.startsWith("stripe"))).toBe(false)
  })

  it("execute returns a deterministic result", async () => {
    const b = new LocalBroker()
    const out = (await b.execute({
      ref: "local:gmail:u1",
      tool: "gmail.read",
      args: { q: "x" },
    })) as { ok: boolean }
    expect(out.ok).toBe(true)
  })

  it("makeBroker falls back to LocalBroker without a real composio plan", () => {
    expect(makeBroker(null).provider).toBe("local")
    // Empty key → still local (can't reach the vendor).
    expect(makeBroker({ provider: "composio", key: "" }).provider).toBe("local")
    expect(makeBroker({ provider: "composio", key: "k" }).provider).toBe("composio")
  })
})
