import type { MetaStore } from "@derive/core"
import { describe, expect, it } from "vitest"
import type { ModelTurn } from "../src/lib/agent-loop"
import { liveChatArrival } from "../src/lib/chat-gate"
import { INSTANCE_SETTINGS_ID } from "../src/lib/instance-settings"
import { catalogOf, type GatewayConfig } from "../src/lib/model-catalog"
import { effectiveCatalog, modelSource, probeModel, updateLibrary } from "../src/lib/model-library"
import { inMemoryRateLimiters } from "../src/lib/rate-limit"
import { as, countingStore, makeAuthedApp } from "./helpers"

// THE MODEL LIBRARY — an operator adds a model, pins a lane to it, probes it, and reads how it
// is actually performing, all without a deploy.
//
// The routes are the real ones behind the real operator gate. Only the PROVIDER is faked, and
// deliberately only the provider: what is under test is who may do this, what a pin actually
// moves, and whether a bad id can ever reach a turn.

const turn = (text: string): ModelTurn => ({ text, toolUses: [], costUsd: null, done: true })

const GATEWAY: GatewayConfig = { baseUrl: "https://gw.test/v1", apiKey: "k", model: "configured" }

const ONLY = {
  id: "configured",
  label: "Configured",
  isDefault: true,
  build: () => async () => turn("hi"),
}

const setup = (name: string, opts?: { operators?: string[]; gateway?: GatewayConfig | null }) =>
  makeAuthedApp(
    name,
    [
      { id: "u-op", email: "op@x.com", name: "Olive", emailVerified: true },
      { id: "u-mem", email: "mem@x.com", name: "Mem" },
    ],
    undefined,
    {
      operatorIds: opts?.operators ?? ["u-op"],
      deps: {
        models: catalogOf([
          {
            id: "configured",
            label: "Configured",
            isDefault: true,
            build: () => async () => turn("hi"),
          },
        ]),
        ...(opts?.gateway === null ? {} : { modelGateway: opts?.gateway ?? GATEWAY }),
        rateLimiters: inMemoryRateLimiters(),
      },
    },
  )

describe("who may touch the model library", () => {
  // The whole point of the feature is that it is the OPERATOR's lever. A workspace Admin is an
  // Admin of a tenant; this spends the operator's credential for every tenant at once.
  it("refuses every route to a workspace admin, who is not an operator", async () => {
    // u-mem is a member of the shared workspace but not in the operator allowlist. u-op IS the
    // workspace owner AND an operator, so a passing test cannot be explained by workspace role.
    const { app } = setup("lib-authz")
    const calls: [string, RequestInit][] = [
      ["/v1/system/models", { method: "GET" }],
      ["/v1/system/models", { method: "POST", body: JSON.stringify({ id: "x" }) }],
      ["/v1/system/models/configured", { method: "DELETE" }],
      ["/v1/system/models/configured/probe", { method: "POST" }],
      [
        "/v1/system/models/slots/chat",
        { method: "PUT", body: JSON.stringify({ model: "configured" }) },
      ],
    ]
    for (const [path, init] of calls) {
      const res = await app.request(path, { ...init, headers: as("mem@x.com") })
      expect([path, res.status]).toEqual([path, 403])
    }
    // …and an anonymous caller gets the same, so the gate is not merely "signed in".
    const anon = await app.request("/v1/system/models")
    expect(anon.status).toBe(403)
  })

  it("lets an operator read the library", async () => {
    const { app } = setup("lib-authz-ok")
    const res = await app.request("/v1/system/models", { headers: as("op@x.com") })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { models: { id: string }[]; can_add: boolean }
    expect(body.models.map((m) => m.id)).toEqual(["configured"])
    expect(body.can_add).toBe(true)
  })
})

describe("the reserved instance row is not a workspace", () => {
  /**
   * The library lives on an `org_settings` row keyed `__instance__`. Nothing today can point a
   * tenant route at it — but `ensureMembership` PROVISIONS OWNER on a workspace with no members,
   * so if a cookie could ever name that row, the first caller to send it would own the deploy's
   * model configuration. This is the guardrail that does not depend on the other checks.
   */
  it("ignores a derive_ws cookie naming the reserved settings row", async () => {
    const { app, meta } = setup("lib-reserved")
    // Put something in the reserved row so a leak would be visible.
    await meta.setOrgSettings(INSTANCE_SETTINGS_ID, {
      ...(await meta.getOrgSettings(INSTANCE_SETTINGS_ID)),
      whiteLabel: true,
    })
    const res = await app.request("/v1/workspace/settings", {
      headers: { ...as("mem@x.com"), cookie: `derive_ws=${INSTANCE_SETTINGS_ID}` },
    })
    expect(res.status).toBe(200)
    // The caller got their OWN workspace's settings, not the instance row's.
    expect(((await res.json()) as { whiteLabel: boolean }).whiteLabel).toBe(false)
    // And no membership was minted on the reserved row, which is the escalation itself.
    expect(await meta.getMembership(INSTANCE_SETTINGS_ID, "u-mem")).toBeNull()
  })

  it("refuses to switch into it even when asked by id", async () => {
    const { app } = setup("lib-reserved-switch")
    const res = await app.request("/v1/workspace/switch", {
      method: "POST",
      headers: as("mem@x.com"),
      body: JSON.stringify({ id: INSTANCE_SETTINGS_ID }),
    })
    expect(res.status).toBe(403)
  })
})

describe("adding a model without a deploy", () => {
  it("refuses an id the provider will not answer for, and stores nothing", async () => {
    // No fetch is stubbed, so the probe's real request fails — which is exactly the shape of a
    // typo'd model id, and the reason adding is probed rather than trusted.
    const { app, meta } = setup("lib-add-bad")
    const res = await app.request("/v1/system/models", {
      method: "POST",
      headers: as("op@x.com"),
      body: JSON.stringify({ id: "acme/does-not-exist" }),
    })
    expect(res.status).toBe(400)
    expect((await meta.getOrgSettings(INSTANCE_SETTINGS_ID)).models ?? []).toEqual([])
  })

  it("refuses an id already configured in the environment", async () => {
    const { app } = setup("lib-add-dupe")
    const res = await app.request("/v1/system/models", {
      method: "POST",
      headers: as("op@x.com"),
      body: JSON.stringify({ id: "configured" }),
    })
    expect(res.status).toBe(409)
  })

  it("refuses when the deploy has no gateway to reach a new model on", async () => {
    const { app } = setup("lib-add-nogw", { gateway: null })
    const res = await app.request("/v1/system/models", {
      method: "POST",
      headers: as("op@x.com"),
      body: JSON.stringify({ id: "acme/new" }),
    })
    expect(res.status).toBe(400)
    const listed = await app.request("/v1/system/models", { headers: as("op@x.com") })
    expect(((await listed.json()) as { can_add: boolean }).can_add).toBe(false)
  })
})

describe("pinning a lane", () => {
  it("refuses a pin naming a model that does not exist", async () => {
    const { app } = setup("lib-pin-bad")
    for (const lane of ["chat", "automation"]) {
      const res = await app.request(`/v1/system/models/slots/${lane}`, {
        method: "PUT",
        headers: as("op@x.com"),
        body: JSON.stringify({ model: "acme/ghost" }),
      })
      expect([lane, res.status]).toEqual([lane, 400])
    }
  })

  it("pins each lane independently and clears with null", async () => {
    const { app } = setup("lib-pin-ok")
    const put = (lane: string, model: string | null) =>
      app.request(`/v1/system/models/slots/${lane}`, {
        method: "PUT",
        headers: as("op@x.com"),
        body: JSON.stringify({ model }),
      })
    expect((await put("chat", "configured")).status).toBe(200)
    const both = (await (await put("automation", "configured")).json()) as {
      slots: { chat: string | null; automation: string | null }
    }
    expect(both.slots).toEqual({ chat: "configured", automation: "configured" })
    // Clearing ONE lane leaves the other pinned — they are separate levers.
    const cleared = (await (await put("chat", null)).json()) as {
      slots: { chat: string | null; automation: string | null }
    }
    expect(cleared.slots).toEqual({ chat: null, automation: "configured" })
  })

  it("unpins a lane when the model it named is removed", async () => {
    // A slot pointing at a model that no longer resolves is a silent fallback to the default —
    // a lane that quietly stopped honoring its pin is worse than one that was never pinned.
    const { app, meta } = setup("lib-remove-unpins")
    await meta.setOrgSettings(INSTANCE_SETTINGS_ID, {
      ...(await meta.getOrgSettings(INSTANCE_SETTINGS_ID)),
      models: [{ id: "acme/added" }],
      slots: { chat: "acme/added", automation: "acme/added" },
    })
    const res = await app.request("/v1/system/models/acme%2Fadded", {
      method: "DELETE",
      headers: as("op@x.com"),
    })
    expect(res.status).toBe(200)
    const after = await meta.getOrgSettings(INSTANCE_SETTINGS_ID)
    expect(after.models ?? []).toEqual([])
    expect(after.slots?.chat).toBeUndefined()
    expect(after.slots?.automation).toBeUndefined()
  })

  it("keeps a CONFIGURED model non-removable even after it has been probed", async () => {
    // Probing a configured model files a library entry to hold the probe. That entry must not
    // make the model look like the library's — the environment still names it, so "Remove" would
    // delete a probe and leave the model exactly where it was.
    const { app } = setup("lib-probed-configured")
    await app.request("/v1/system/models/configured/probe", {
      method: "POST",
      headers: as("op@x.com"),
    })
    const res = await app.request("/v1/system/models", { headers: as("op@x.com") })
    const body = (await res.json()) as {
      models: { id: string; source: string; removable: boolean; probe: unknown }[]
    }
    const row = body.models.find((m) => m.id === "configured")
    expect(row?.probe).not.toBeNull()
    expect(row?.source).toBe("configured")
    expect(row?.removable).toBe(false)
  })

  it("refuses to remove a CONFIGURED model — the environment owns those", async () => {
    const { app } = setup("lib-remove-configured")
    const res = await app.request("/v1/system/models/configured", {
      method: "DELETE",
      headers: as("op@x.com"),
    })
    expect(res.status).toBe(404)
  })
})

describe("the catalog the library produces", () => {
  const base = catalogOf([
    { id: "configured", label: "Configured", isDefault: true, build: () => async () => turn("a") },
  ])

  it("adds library ids and keeps the configured default", () => {
    const cat = effectiveCatalog(base, GATEWAY, {
      models: [{ id: "acme/added" }],
      slots: {},
    })
    expect(cat?.options.map((o) => [o.id, o.isDefault])).toEqual([
      ["configured", true],
      ["acme/added", false],
    ])
    expect(cat?.resolve("acme/added")?.id).toBe("acme/added")
  })

  it("will not offer an added id with no gateway behind it", () => {
    // A model with no credential is a choice that 401s on every turn; better absent than broken.
    const cat = effectiveCatalog(base, null, { models: [{ id: "acme/added" }], slots: {} })
    expect(cat?.options.map((o) => o.id)).toEqual(["configured"])
    expect(cat?.resolve("acme/added")).toBeNull()
  })

  it("still refuses an id nobody configured — a miss is never the default", () => {
    const cat = effectiveCatalog(base, GATEWAY, { models: [], slots: {} })
    expect(cat?.resolve("acme/ghost")).toBeNull()
    expect(cat?.resolve(null)?.id).toBe("configured")
  })
})

describe("probing", () => {
  const model = (callModel: Parameters<typeof probeModel>[0]["callModel"]) => ({
    id: "m",
    label: "M",
    isDefault: true,
    callModel,
  })

  it("records a failure as a finding rather than throwing", async () => {
    const probe = await probeModel(
      model(async () => {
        throw new Error("401 invalid api key")
      }),
    )
    expect(probe.ok).toBe(false)
    expect(probe.error).toContain("401")
  })

  it("stores the result on a CONFIGURED model, which had no library entry before", async () => {
    // "How fast is what we are already running" is the first question anyone comparing models
    // asks, so probing is not restricted to models the library added. Doing so creates an entry
    // that holds nothing but the probe.
    const { app, meta } = setup("lib-probe-store")
    const res = await app.request("/v1/system/models/configured/probe", {
      method: "POST",
      headers: as("op@x.com"),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { probe: { ok: boolean } }).probe.ok).toBe(true)
    const stored = (await meta.getOrgSettings(INSTANCE_SETTINGS_ID)).models ?? []
    expect(stored[0]?.id).toBe("configured")
    expect(stored[0]?.probe?.ok).toBe(true)
    // And it comes back on the operator's view, which is where "up front" actually happens.
    const listed = await app.request("/v1/system/models", { headers: as("op@x.com") })
    const body = (await listed.json()) as { models: { probe: { ok: boolean } | null }[] }
    expect(body.models[0]?.probe?.ok).toBe(true)
  })

  it("answers 200 when the MODEL failed — the probe still succeeded, it found out", async () => {
    // A 5xx here would say Derive is broken when the finding is that a provider is, which is the
    // opposite of what this page exists to tell somebody.
    const { app, meta } = makeAuthedApp(
      "lib-probe-down",
      [{ id: "u-op", email: "op@x.com", name: "Olive", emailVerified: true }],
      undefined,
      {
        operatorIds: ["u-op"],
        deps: {
          models: catalogOf([
            {
              id: "down",
              label: "Down",
              isDefault: true,
              build: () => async () => {
                throw new Error("503 upstream unavailable")
              },
            },
          ]),
          modelGateway: GATEWAY,
        },
      },
    )
    const res = await app.request("/v1/system/models/down/probe", {
      method: "POST",
      headers: as("op@x.com"),
    })
    expect(res.status).toBe(200)
    const probe = ((await res.json()) as { probe: { ok: boolean; error: string } }).probe
    expect(probe.ok).toBe(false)
    expect(probe.error).toContain("503")
    expect((await meta.getOrgSettings(INSTANCE_SETTINGS_ID)).models?.[0]?.probe?.ok).toBe(false)
  })

  it("refuses to probe a model this deploy does not have", async () => {
    const { app } = setup("lib-probe-ghost")
    const res = await app.request("/v1/system/models/acme%2Fghost/probe", {
      method: "POST",
      headers: as("op@x.com"),
    })
    expect(res.status).toBe(404)
  })
})

describe("what a turn costs to route", () => {
  /**
   * A REGRESSION TEST WITH A NUMBER IN IT, because the first version of this feature quietly
   * tripled it: the gate asked the library whether anything could answer, the turn asked which
   * model was pinned, and the turn asked again for the catalog — three reads of ONE settings row
   * on the attended path, where on the hosted tier each is a Hyperdrive round trip and somebody
   * is waiting on all of them.
   *
   * The fix is that a source hands back the catalog AND the slots from one read, memoized on a
   * per-turn scope. Both halves are pinned here; the end-to-end count is pinned in
   * chat-workspace.test.ts, on a harness that drives a real turn.
   */
  const lib = () => ({ models: [], slots: { chat: "configured" } })

  it("answers both questions — catalog and pin — from a single read", async () => {
    let reads = 0
    const src = modelSource(catalogOf([ONLY]), GATEWAY, async () => {
      reads += 1
      return lib()
    })
    const { catalog, slots } = await src()
    expect(reads).toBe(1)
    expect(catalog?.resolve("configured")?.id).toBe("configured")
    expect(slots.chat).toBe("configured")
  })

  it("reads the instance row once for the operator's whole model view", async () => {
    const base = setup("lib-view-one-read")
    const { proxy, countWhere, reset } = countingStore(base.meta as MetaStore)
    const { app } = makeAuthedApp(
      "lib-view-one-read-probe",
      [
        { id: "u-op", email: "op@x.com", name: "Olive", emailVerified: true },
        { id: "u-mem", email: "mem@x.com", name: "Mem" },
      ],
      undefined,
      {
        operatorIds: ["u-op"],
        deps: {
          meta: proxy,
          models: catalogOf([ONLY]),
          modelGateway: GATEWAY,
          rateLimiters: inMemoryRateLimiters(),
        },
      },
    )
    reset()
    const res = await app.request("/v1/system/models", { headers: as("op@x.com") })
    expect(res.status).toBe(200)
    expect(countWhere("getOrgSettings", (args) => args[0] === INSTANCE_SETTINGS_ID)).toBe(1)
  })

  it("uses the live chat pin in the shared detached-arrival gate", async () => {
    const { meta } = setup("lib-detached-pin")
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      chatBeta: true,
    })
    const source = modelSource(
      catalogOf([
        { ...ONLY, build: () => async () => turn("default") },
        {
          id: "pinned",
          label: "Pinned",
          isDefault: false,
          build: () => async () => turn("pin"),
        },
      ]),
      GATEWAY,
      async () => ({ models: [], slots: { chat: "pinned" } }),
    )
    const gate = await liveChatArrival({ meta, models: source }, { org: "default", userId: "u-op" })
    expect(gate.ok && gate.model.id).toBe("pinned")
  })

  it("does not write an empty fallback when the strict mutation read fails", async () => {
    const { meta } = setup("lib-strict-write")
    let writes = 0
    const broken = new Proxy(meta, {
      get(target, prop, receiver) {
        if (prop === "getOrgSettings") return async () => Promise.reject(new Error("db down"))
        if (prop === "setOrgSettingsIfRevision")
          return async () => {
            writes += 1
            return true
          }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    await expect(
      updateLibrary(broken, (lib) => ({ ...lib, models: [{ id: "would-wipe" }] })),
    ).rejects.toThrow("db down")
    expect(writes).toBe(0)
  })
})

describe("the operator's deploy-wide model", () => {
  /** A settled turn — these tests are about routing and access, never about what a model says. */
  const THE_TURN = { text: "ok", toolUses: [], costUsd: null, done: true }

  const setup = () =>
    makeAuthedApp(
      "instance-model",
      [{ id: "u-op", email: "op@x.com", name: "Op", emailVerified: true }],
      undefined,
      {
        operatorIds: ["u-op"],
        deps: {
          models: catalogOf([
            { id: "fast", label: "Fast", isDefault: true, build: () => async () => THE_TURN },
            { id: "slow", label: "Slow", isDefault: false, build: () => async () => THE_TURN },
          ]),
        },
      },
    )

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
