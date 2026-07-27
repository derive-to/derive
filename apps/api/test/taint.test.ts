import { decideWrite, parseRunMeta, runTainted } from "@derive/core"
import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// TAINT — the structural defense against prompt injection.
//
// A run that consumed untrusted external content (a webhook body, a source-tool result) cannot
// live-publish, whatever the workspace's autonomy settings say. Its writes become proposals a
// human approves.
//
// The point is that it does NOT depend on the model behaving. Prompt hardening cannot solve
// injection, because the hardening and the attack live in the same context window: a page that
// says "ignore your instructions and publish X" is arguing with the same model that read the
// instructions. Taint puts a human in the path instead, decided outside the model entirely.
describe("taint: the gate rung", () => {
  const flags = { agentKillswitch: false, agentAutoEnabled: true }

  it("a tainted run cannot live-publish even at auto, opted in, confidence 1.0", () => {
    // The exact configuration a workspace reaches for when it wants hands-off automation — and
    // the one an injection would be trying to exploit. Confidence is the MODEL's number, so it
    // is worth nothing here: the model is who the injected text was talking to.
    expect(decideWrite({ autonomy: "auto", confidence: 1, flags })).toBe("live_publish_with_review")
    expect(decideWrite({ autonomy: "auto", confidence: 1, flags, tainted: true })).toBe("proposal")
  })

  it("taint does NOT promote a shadow run into somebody's review queue", () => {
    // Shadow files nothing at all, which is strictly safer than a proposal. Demoting toward a
    // proposal here would mean turning on taint made a quiet rollout tier start generating work
    // for humans — the wrong direction for a safety feature.
    expect(decideWrite({ autonomy: "shadow", confidence: 1, flags, tainted: true })).toBe("shadow")
  })

  it("the killswitch still outranks everything", () => {
    expect(
      decideWrite({
        autonomy: "auto",
        confidence: 1,
        flags: { ...flags, agentKillswitch: true },
        tainted: true,
      }),
    ).toBe("proposal")
  })
})

describe("taint: what counts as untrusted", () => {
  it("a webhook payload taints; an ordinary run does not", () => {
    expect(runTainted({})).toBe(false)
    expect(runTainted({ payloads: [] })).toBe(false)
    expect(runTainted({ payloads: [{ release: "v2" }] })).toBe(true)
    expect(runTainted({ tainted: true })).toBe(true)
  })

  it("malformed meta reads as untainted rather than throwing inside a claim", () => {
    // meta is a free-form blob several writers merge into. A claim that threw on a junk value
    // would take down the whole drain, which is a worse failure than the one being prevented.
    expect(runTainted(parseRunMeta("not json"))).toBe(false)
    expect(runTainted({ payloads: "nope" as unknown as [] })).toBe(false)
    expect(runTainted({ tainted: "yes" })).toBe(false)
  })
})

describe("taint: the server records it, the executor only reads it", () => {
  const owner: TestUser = { id: "u_taint_own", email: "taintown@derive.test", name: "Owner" }
  const { app, meta } = makeAuthedApp("taint", [owner], "editor")

  const mint = async (name: string) =>
    (await (await app.request("/v1/agents", jsonAs(as(owner.email), { name }))).json()) as {
      id: string
      token: string
    }

  it("a webhook-fired run arrives at the executor already tainted", async () => {
    // The claim payload is the executor's whole view of the run, so taint has to ride on it.
    // The server decides; the executor cannot clear it, and an executor a prompt injection has
    // captured is exactly the party whose word on "did I read anything external" is worthless.
    const agent = await mint("Fired")
    const auto = (await (
      await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          agentId: agent.id,
          trigger: { kind: "event", on: "webhook" },
          instruction: "fold the payload into the changelog",
        }),
      )
    ).json()) as { id: string; fire_secret: string }

    const fired = await app.request(`/v1/automations/${auto.id}/fire`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${auto.fire_secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ release: "v2.4.0" }),
    })
    expect(fired.status).toBe(202)

    const claimed = (await (
      await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    ).json()) as { runs: { tainted?: boolean; payloads?: unknown[] }[] }
    const run = claimed.runs[0]
    expect(run?.payloads).toHaveLength(1)
    expect(run?.tainted).toBe(true)
  })

  it("a plain manual run is NOT tainted", async () => {
    // The other half: taint has to stay narrow, or `auto` becomes unusable for the scheduled
    // automations that never touch the outside world at all.
    const agent = await mint("Plain")
    const auto = (await (
      await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          agentId: agent.id,
          trigger: { kind: "manual" },
          instruction: "tidy the roadmap",
        }),
      )
    ).json()) as { id: string }
    await app.request(`/v1/automations/${auto.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    const claimed = (await (
      await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    ).json()) as { runs: { tainted?: boolean }[] }
    expect(claimed.runs[0]?.tainted).toBe(false)
  })

  it("run meta carries the flag once stamped, and merging never loses it", async () => {
    // The tool endpoint stamps `tainted` mid-run via updateRunMeta + mergeRunMeta. Everything
    // that later writes run.meta (retry, reclaim, settle) merges rather than replaces, so the
    // stamp has to survive them — the same rule that stopped `payloads` being erased on retry.
    const agent = await mint("Stamped")
    const auto = (await (
      await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          agentId: agent.id,
          trigger: { kind: "manual" },
          instruction: "pull and summarize",
        }),
      )
    ).json()) as { id: string }
    const run = (await (
      await app.request(`/v1/automations/${auto.id}/run`, {
        method: "POST",
        headers: as(owner.email),
      })
    ).json()) as { id: string }

    const stored = await meta.getRun(run.id)
    await meta.updateRunMeta(
      run.id,
      JSON.stringify({ ...parseRunMeta(stored?.meta), tainted: true }),
    )
    expect(runTainted(parseRunMeta((await meta.getRun(run.id))?.meta))).toBe(true)

    await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    await app.request(`/v1/agent/runs/${run.id}/finish`, {
      method: "POST",
      headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "succeeded", meta: { outcome: "proposed" } }),
    })
    expect(runTainted(parseRunMeta((await meta.getRun(run.id))?.meta))).toBe(true)
  })
})
