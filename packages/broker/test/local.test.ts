import { describe, expect, it } from "vitest"
import { LocalBroker, makeBroker } from "../src/index"

describe("LocalBroker", () => {
  it("toolsFor is least-privilege: only the passed refs' toolkits", async () => {
    const b = new LocalBroker()
    const tools = await b.toolsFor(["local:gmail:u1"])
    expect(tools.map((t) => t.name).sort()).toEqual(["gmail.read", "gmail.write"])
    // A ref you did NOT pass contributes nothing.
    expect(tools.some((t) => t.name.startsWith("stripe"))).toBe(false)
  })

  it("without a plan, REFUSES by default and echoes only when asked to", () => {
    // This used to fall back to the echo stub. That is right for a fixture and wrong as a
    // default: LocalBroker.execute returns the caller's own arguments, so a production run
    // "reads Stripe", gets its arguments back, and publishes invented numbers with no error
    // anywhere. A refusal is recoverable; a convincing lie is not.
    expect(makeBroker(null).provider).toBe("none")
    expect(makeBroker(null, true).provider).toBe("local")
    // Empty key → can't reach the vendor, so the same rule applies.
    expect(makeBroker({ provider: "composio", key: "" }).provider).toBe("none")
    expect(makeBroker({ provider: "composio", key: "" }, true).provider).toBe("local")
    expect(makeBroker({ provider: "composio", key: "k" }).provider).toBe("composio")
  })

  it("a refusing broker fails loudly on connect and execute, quietly on list", async () => {
    const b = makeBroker(null)
    await expect(b.connect({ orgId: "o", userId: "u", toolkit: "stripe" })).rejects.toThrow(
      /no integration broker is configured/,
    )
    await expect(b.execute({ ref: "x", tool: "stripe.read", args: {} })).rejects.toThrow(
      /no integration broker is configured/,
    )
    // Empty, not thrown: one misconfigured source must not take down a run bound to several.
    expect(await b.toolsFor(["x"])).toEqual([])
  })
})
