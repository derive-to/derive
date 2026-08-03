import { describe, expect, it } from "vitest"
import {
  catalogFromGateway,
  catalogFromGateways,
  parseGatewaysJson,
} from "../src/lib/model-catalog"

// ROUTING BETWEEN PROVIDERS, which is a different question from routing between models.
//
// One gateway serving many model ids was always supported. What was not: several gateways at
// once, each with its own credential, its own speed and its own price, all offered together so a
// person can switch mid-conversation and an operator can add a fourth without a code change.
//
// The ids are the load-bearing detail. They are stored on every answer, so they have to stay
// stable AND stay unambiguous once two providers serve a model of the same name.

const gw = (over: Partial<Parameters<typeof catalogFromGateways>[0][number]> = {}) => ({
  baseUrl: "https://gw.test/v1",
  apiKey: "k",
  model: "deepseek-v4-flash",
  ...over,
})

describe("several providers in one catalog", () => {
  it("offers every gateway's models together", () => {
    const c = catalogFromGateways([
      gw({ name: "openrouter", model: "deepseek/deepseek-v4-flash-0731" }),
      gw({ name: "makora", model: "deepseek-ai/DeepSeek-V4-Flash" }),
    ])
    expect(c?.options.map((o) => o.id)).toEqual([
      "openrouter:deepseek/deepseek-v4-flash-0731",
      "makora:deepseek-ai/DeepSeek-V4-Flash",
    ])
  })

  it("keeps the SAME model id on two providers apart", () => {
    // The case that makes namespacing necessary rather than tidy: same name, different
    // credential, different speed, different price. Collapsed, a catalog would resolve to
    // whichever happened to be declared last.
    const c = catalogFromGateways([
      gw({ name: "a", model: "deepseek-v4-flash" }),
      gw({ name: "b", model: "deepseek-v4-flash" }),
    ])
    expect(c?.options.map((o) => o.id)).toEqual(["a:deepseek-v4-flash", "b:deepseek-v4-flash"])
    // and they are distinguishable to a reader, not just to the code
    expect(c?.options.map((o) => o.label)).toEqual([
      "deepseek-v4-flash (a)",
      "deepseek-v4-flash (b)",
    ])
  })

  it("leaves the legacy gateway's ids BARE, so stored transcripts keep resolving", () => {
    // An id is written onto every answer. Re-pointing an existing one would silently rewrite
    // what the record says produced it.
    const c = catalogFromGateways([gw({ model: "deepseek-v4-flash", alsoModels: "kimi-k2" })])
    expect(c?.options.map((o) => o.id)).toEqual(["deepseek-v4-flash", "kimi-k2"])
    expect(c?.resolve("deepseek-v4-flash")?.id).toBe("deepseek-v4-flash")
  })

  it("switches the default with one variable, without reordering anything", () => {
    const c = catalogFromGateways(
      [gw({ model: "slow-one" }), gw({ name: "openrouter", model: "fast-one" })],
      "openrouter:fast-one",
    )
    expect(c?.resolve()?.id).toBe("openrouter:fast-one")
    expect(c?.options.find((o) => o.isDefault)?.id).toBe("openrouter:fast-one")
    // the others stay reachable — switching the default is not hiding the rest
    expect(c?.resolve("slow-one")?.id).toBe("slow-one")
  })

  it("ignores a default that names nothing rather than losing the catalog", () => {
    // A typo in one variable must cost the default, never the whole chat surface.
    const c = catalogFromGateways([gw({ model: "real" })], "typo:not-a-model")
    expect(c?.resolve()?.id).toBe("real")
  })

  it("still returns null when nothing is configured", () => {
    expect(catalogFromGateways([])).toBeNull()
    expect(catalogFromGateway(null)).toBeNull()
  })

  it("never resolves an unknown id to the default", () => {
    // Answering with a different model than the one asked for is a lie about provenance.
    const c = catalogFromGateways([gw({ name: "openrouter", model: "fast" })])
    expect(c?.resolve("openrouter:gone")).toBeNull()
  })
})

describe("declaring extra providers as configuration", () => {
  it("reads a list of gateways, each with its own key, models and routing", () => {
    const gws = parseGatewaysJson(
      JSON.stringify([
        {
          name: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-test",
          models: ["deepseek/deepseek-v4-flash-0731", "anthropic/claude-haiku-4.5"],
          providers: "DeepInfra,GMICloud",
        },
      ]),
    )
    expect(gws).toHaveLength(1)
    expect(gws[0]?.model).toBe("deepseek/deepseek-v4-flash-0731")
    expect(gws[0]?.alsoModels).toBe("anthropic/claude-haiku-4.5")
    expect(gws[0]?.providers).toBe("DeepInfra,GMICloud")
    // and it reaches the catalog as real, separately-addressable entries
    const c = catalogFromGateways(gws)
    expect(c?.options.map((o) => o.id)).toEqual([
      "openrouter:deepseek/deepseek-v4-flash-0731",
      "openrouter:anthropic/claude-haiku-4.5",
    ])
  })

  it("drops a half-configured gateway instead of half-breaking the catalog", () => {
    const gws = parseGatewaysJson(
      JSON.stringify([
        { name: "broken", baseUrl: "https://x/v1", models: ["m"] }, // no apiKey
        { name: "fine", baseUrl: "https://y/v1", apiKey: "k", models: ["m"] },
      ]),
    )
    expect(gws.map((g) => g.name)).toEqual(["fine"])
  })

  it("yields nothing on malformed JSON rather than taking the deploy down", () => {
    // Read at boot on a path that also serves anonymous reads; a stray comma is not a reason to
    // stop answering.
    expect(parseGatewaysJson("{not json")).toEqual([])
    expect(parseGatewaysJson(undefined)).toEqual([])
    expect(parseGatewaysJson("   ")).toEqual([])
  })
})
