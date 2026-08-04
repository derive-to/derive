import { describe, expect, it } from "vitest"
import { catalogFromGateway, catalogOf } from "../src/lib/model-catalog"
import { as, makeAuthedApp } from "./helpers"

/** A settled turn — these tests are about routing and access, never about what a model says. */
const THE_TURN = { text: "ok", toolUses: [], costUsd: null, done: true }

describe("gateway extras reach the request", () => {
  const gw = (over: Record<string, unknown> = {}) => ({
    baseUrl: "https://gw.test/v1",
    apiKey: "k",
    model: "m",
    ...over,
  })

  it("offers the gateway's models, default first", () => {
    const c = catalogFromGateway(gw({ alsoModels: "second" }))
    expect(c?.options.map((o) => o.id)).toEqual(["m", "second"])
    expect(c?.options.find((o) => o.isDefault)?.id).toBe("m")
  })

  it("still returns null when nothing is configured", () => {
    expect(catalogFromGateway(null)).toBeNull()
  })

  it("never resolves an unknown id to the default", () => {
    // Answering with a different model than the one asked for is a lie about provenance.
    expect(catalogFromGateway(gw())?.resolve("gone")).toBeNull()
  })
})

describe("the operator's deploy-wide model", () => {
  const setup = () =>
    makeAuthedApp("instance-model", [{ id: "u-op", email: "op@x.com", name: "Op" }], undefined, {
      deps: {
        models: catalogOf([
          { id: "fast", label: "Fast", isDefault: true, build: () => async () => THE_TURN },
          { id: "slow", label: "Slow", isDefault: false, build: () => async () => THE_TURN },
        ]),
        superAdmins: ["op@x.com"],
      },
    })

  it("is refused to somebody who does not run the instance", async () => {
    // A workspace Admin is still not an operator: the model is the operator's credential to
    // spend, which is why this does not live in workspace settings.
    const { app } = makeAuthedApp(
      "instance-model-denied",
      [{ id: "u-mem", email: "mem@x.com", name: "Mem" }],
      undefined,
      {
        deps: {
          models: catalogOf([
            { id: "fast", label: "Fast", isDefault: true, build: () => async () => THE_TURN },
          ]),
        },
      },
    )
    expect((await app.request("/v1/system/chat-model", { headers: as("mem@x.com") })).status).toBe(
      403,
    )
    const put = await app.request("/v1/system/chat-model", {
      method: "PUT",
      headers: { ...as("mem@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ model: "fast" }),
    })
    expect(put.status).toBe(403)
  })

  it("reads back what is set, alongside what could be", async () => {
    const { app } = setup()
    const before = await (
      await app.request("/v1/system/chat-model", { headers: as("op@x.com") })
    ).json()
    expect(before.model).toBeNull() // nothing set ⇒ the configured default answers
    expect(before.options.map((o: { id: string }) => o.id)).toEqual(["fast", "slow"])

    await app.request("/v1/system/chat-model", {
      method: "PUT",
      headers: { ...as("op@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ model: "slow" }),
    })
    const after = await (
      await app.request("/v1/system/chat-model", { headers: as("op@x.com") })
    ).json()
    expect(after.model).toBe("slow")
  })

  it("clears back to the configured default", async () => {
    const { app } = setup()
    const put = (model: string | null) =>
      app.request("/v1/system/chat-model", {
        method: "PUT",
        headers: { ...as("op@x.com"), "content-type": "application/json" },
        body: JSON.stringify({ model }),
      })
    await put("slow")
    await put(null)
    const now = await (
      await app.request("/v1/system/chat-model", { headers: as("op@x.com") })
    ).json()
    expect(now.model).toBeNull()
  })

  it("refuses a model that does not exist, where somebody is looking at the answer", async () => {
    // Rather than accepting it and costing every turn on the deployment later.
    const { app } = setup()
    const res = await app.request("/v1/system/chat-model", {
      method: "PUT",
      headers: { ...as("op@x.com"), "content-type": "application/json" },
      body: JSON.stringify({ model: "not-a-model" }),
    })
    expect(res.status).toBe(400)
  })
})
