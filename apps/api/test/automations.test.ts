import { describe, expect, it } from "vitest"
import { as, bearer, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// WP5/WP6 — automations + runs, the generic agent-work primitive. An owner defines an
// automation (agent + trigger + instruction); "run now" enqueues a run; the agent claims
// the queued run, finishes it, and the workspace ledger lists it. A "living doc refresh" is
// just an automation with a doc ref, run on demand — the same path a schedule/webhook takes.
describe("automations + runs", () => {
  const owner: TestUser = { id: "u_auto_own", email: "autoown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_auto_mem", email: "automem@derive.test", name: "Member" }
  const { app } = makeAuthedApp("automations", [owner, member], "commenter")

  let n = 0
  const mintAgent = async () => {
    n += 1
    const res = await app.request("/v1/agents", jsonAs(as(owner.email), { name: `Runner ${n}` }))
    return (await res.json()) as { id: string; token: string }
  }
  const createAutomation = (agentId: string, over: object = {}) =>
    app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        agentId,
        trigger: { kind: "manual" },
        instruction: "keep the roadmap current",
        ...over,
      }),
    )

  it("an owner defines an automation; the agent must be in the workspace", async () => {
    const agent = await mintAgent()
    const bad = await createAutomation("ag_elsewhere")
    expect(bad.status).toBe(400)

    const ok = await createAutomation(agent.id, {
      trigger: { kind: "schedule", cron: "0 9 * * 1", tz: "America/Los_Angeles" },
      refs: ["art_123"],
    })
    expect(ok.status).toBe(201)
    const rec = await ok.json()
    expect(rec).toMatchObject({ agent_id: agent.id, enabled: true })
    expect(rec.trigger).toMatchObject({ kind: "schedule", cron: "0 9 * * 1" })
    // A bare string ref is artifact shorthand; the API stores and returns CANONICAL selectors.
    expect(rec.refs).toEqual([{ kind: "artifact", id: "art_123" }])
  })

  it("refs are selectors: bare strings, collections, and tags all normalize; junk is rejected", async () => {
    const agent = await mintAgent()
    const ok = await createAutomation(agent.id, {
      refs: [
        "art_9",
        { kind: "collection", id: "col_1" },
        { kind: "tag", tag: "weekly-health" },
        "art_9", // duplicate — deduped on normalize
      ],
    })
    expect(ok.status).toBe(201)
    const rec = await ok.json()
    expect(rec.refs).toEqual([
      { kind: "artifact", id: "art_9" },
      { kind: "collection", id: "col_1" },
      { kind: "tag", tag: "weekly-health" },
    ])
    // Write mode rides ON the target: only the explicit publish opt-in is stored;
    // mode:"propose" is the default and normalizes away (canonical minimal form).
    const moded = await (
      await createAutomation(agent.id, {
        refs: [
          { kind: "artifact", id: "art_pub", mode: "publish" },
          { kind: "artifact", id: "art_prop", mode: "propose" },
        ],
      })
    ).json()
    expect(moded.refs).toEqual([
      { kind: "artifact", id: "art_pub", mode: "publish" },
      { kind: "artifact", id: "art_prop" },
    ])
    // The claim payload hands the executor the SAME canonical targets.
    await app.request(`/v1/automations/${rec.id}/run`, { method: "POST", headers: as(owner.email) })
    const claimed = await (
      await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    ).json()
    const mine = claimed.runs.find((r: { automation_id: string }) => r.automation_id === rec.id)
    expect(mine.targets).toEqual(rec.refs)

    const junk = await createAutomation(agent.id, { refs: [{ kind: "nope", id: "x" }] })
    expect(junk.status).toBe(400)
  })

  it("defining requires manage; a commenter-seat member can't", async () => {
    const agent = await mintAgent()
    const denied = await app.request(
      "/v1/automations",
      jsonAs(as(member.email), {
        agentId: agent.id,
        trigger: { kind: "manual" },
        instruction: "x",
      }),
    )
    expect([403, 404]).toContain(denied.status)
  })

  it("run now → the agent claims the queued run → finishes it → it's in the ledger", async () => {
    const agent = await mintAgent()
    const created = await (await createAutomation(agent.id)).json()

    // Run now: enqueue a run (the "refresh please" verb).
    const runRes = await app.request(`/v1/automations/${created.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(runRes.status).toBe(201)
    const { id: runId, status } = await runRes.json()
    expect(status).toBe("queued")

    // The agent claims it — flipped to running, carrying its automation definition.
    const claimed = await (
      await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    ).json()
    const mine = claimed.runs.find((r: { id: string }) => r.id === runId)
    expect(mine).toBeTruthy()
    // The claim hands the executor everything it needs: the instruction + resolved gate inputs.
    // Automation runs propose by default; write mode will ride per-target in refs.
    expect(mine.instruction).toBe("keep the roadmap current")
    // The wallet key rides the claim: Run-now stamps the clicker as the initiator, so
    // the executor bills THEIR plan (a schedule/event enqueue leaves it null).
    expect(mine.initiated_by).toBe("u_auto_own")
    expect(mine.flags).toMatchObject({ agentKillswitch: expect.any(Boolean) })
    // Claimed once: a second poll gets nothing.
    const again = await (
      await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    ).json()
    expect(again.runs.find((r: { id: string }) => r.id === runId)).toBeFalsy()

    // Finish it with a cost + result meta.
    const fin = await app.request(`/v1/agent/runs/${runId}/finish`, {
      ...jsonAs(bearer(agent.token), {
        status: "succeeded",
        cost_micro_usd: 900,
        meta: { outcome: "published" },
      }),
      method: "POST",
    })
    expect(fin.status).toBe(200)

    // The workspace ledger shows it (admin view).
    const ledger = await (
      await app.request("/v1/workspace/runs", { headers: as(owner.email) })
    ).json()
    const row = ledger.runs.find((r: { id: string }) => r.id === runId)
    expect(row?.status).toBe("succeeded")
    expect(row?.cost_micro_usd).toBe(900)
  })

  it("a disabled automation takes no new runs, and its stale queued runs cancel at claim", async () => {
    const agent = await mintAgent()
    const disabled = await (await createAutomation(agent.id, { enabled: false })).json()
    // Run-now refuses a disabled automation outright.
    const refused = await app.request(`/v1/automations/${disabled.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(refused.status).toBe(400)

    // A run enqueued while enabled, claimed after the automation is deleted, must be
    // cancelled server-side — never handed to the executor as an empty task. Deleting
    // cancels queued runs directly, so exercise the claim-side guard with a run whose
    // automation is disabled: enqueue first (enabled), then flip by recreating state via
    // delete: the queued run is purged, and the claim returns nothing.
    const live = await (await createAutomation(agent.id)).json()
    await app.request(`/v1/automations/${live.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    await app.request(`/v1/automations/${live.id}`, {
      method: "DELETE",
      headers: as(owner.email),
    })
    const claimed = await (
      await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    ).json()
    expect(
      claimed.runs.filter((r: { automation_id: string }) => r.automation_id === live.id),
    ).toHaveLength(0)
  })

  it("PATCH edits in place: instruction, refs (normalized), pause/resume; org + role scoped", async () => {
    const agent = await mintAgent()
    const created = await (await createAutomation(agent.id)).json()

    const edited = await (
      await app.request(`/v1/automations/${created.id}`, {
        ...jsonAs(as(owner.email), {
          instruction: "keep the CHANGELOG current",
          refs: [{ kind: "artifact", id: "art_x", mode: "publish" }, "art_y"],
        }),
        method: "PATCH",
      })
    ).json()
    expect(edited.instruction).toBe("keep the CHANGELOG current")
    expect(edited.refs).toEqual([
      { kind: "artifact", id: "art_x", mode: "publish" },
      { kind: "artifact", id: "art_y" },
    ])
    // Untouched fields survive a partial patch.
    expect(edited.trigger).toMatchObject({ kind: "manual" })
    expect(edited.enabled).toBe(true)

    // Pause: run-now refuses; resume: it enqueues again.
    await app.request(`/v1/automations/${created.id}`, {
      ...jsonAs(as(owner.email), { enabled: false }),
      method: "PATCH",
    })
    const refused = await app.request(`/v1/automations/${created.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(refused.status).toBe(400)
    await app.request(`/v1/automations/${created.id}`, {
      ...jsonAs(as(owner.email), { enabled: true }),
      method: "PATCH",
    })
    const ok = await app.request(`/v1/automations/${created.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    expect(ok.status).toBe(201)

    // A commenter seat can't edit.
    const denied = await app.request(`/v1/automations/${created.id}`, {
      ...jsonAs(as(member.email), { instruction: "hijack" }),
      method: "PATCH",
    })
    expect([403, 404]).toContain(denied.status)
  })

  it("run-now needs a write role: a commenter-seat member can't force a run", async () => {
    const agent = await mintAgent()
    const created = await (await createAutomation(agent.id)).json()
    const denied = await app.request(`/v1/automations/${created.id}/run`, {
      method: "POST",
      headers: as(member.email),
    })
    expect([403, 404]).toContain(denied.status)
  })

  it("an agent records an ad-hoc finished run; org + agent come from the bearer", async () => {
    const agent = await mintAgent()
    const res = await app.request(
      "/v1/agent/runs",
      jsonAs(bearer(agent.token), { reason: "mention", meta: { outcome: "answered" } }),
    )
    expect(res.status).toBe(201)
    const anon = await app.request("/v1/agent/runs", {
      ...jsonAs({}, { reason: "mention" }),
      method: "POST",
    })
    expect([401, 403]).toContain(anon.status)
  })
})

// The end of "pick an agent", automation lane (mirrors contexts #525): creating an
// automation without an agentId auto-mints a MANAGED agent — its own Derive access,
// named from the instruction, token returned exactly once — and that agent drives the
// whole run loop: Run now enqueues, the minted bearer claims, initiated_by rides along.
describe("automations: auto-minted managed agents", () => {
  const owner: TestUser = { id: "u_ama_own", email: "amaown@derive.test", name: "Owner" }
  const { app } = makeAuthedApp("automations-managed", [owner], "editor")

  it("create without agentId mints a managed agent; its token claims the run", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    const created = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        trigger: { kind: "manual" },
        instruction: "keep the weekly ship report current",
      }),
    )
    expect(created.status).toBe(201)
    const auto = await created.json()
    expect(auto.agent_id).toBeTruthy()
    expect(auto.agent_token).toMatch(/^dk_agt_/)

    // The roster row: managed, named from the instruction, attributed to the creator.
    const roster = (await (await app.request("/v1/agents", { headers: as(owner.email) })).json())
      .agents
    const minted = roster.find((a: { id: string }) => a.id === auto.agent_id)
    expect(minted).toMatchObject({ managed: true, role: "editor" })
    expect(minted.name).toContain("keep the weekly ship report")
    // The token never appears anywhere again.
    expect(JSON.stringify(roster)).not.toContain(auto.agent_token)

    // Before anything ever polls for runs, the list is honest: no executor.
    const before = (
      await (await app.request("/v1/automations", { headers: as(owner.email) })).json()
    ).automations.find((x: { id: string }) => x.id === auto.id)
    expect(before.executor_seen_at).toBeNull()

    // The loop: Run now → the MINTED agent's bearer claims its own run.
    const run = await (
      await app.request(`/v1/automations/${auto.id}/run`, {
        method: "POST",
        headers: as(owner.email),
      })
    ).json()
    const claimed = await (
      await app.request("/v1/agent/runs/claim", { headers: bearer(auto.agent_token) })
    ).json()
    const mine = claimed.runs.find((r: { id: string }) => r.id === run.id)
    expect(mine).toBeTruthy()
    expect(mine.instruction).toBe("keep the weekly ship report current")
    expect(mine.initiated_by).toBe("u_ama_own")

    // Honesty surface: before any claim the list said "no executor" (null); the
    // claim above stamped the runs-lane heartbeat, so the row now reads live.
    const after = (
      await (await app.request("/v1/automations", { headers: as(owner.email) })).json()
    ).automations.find((x: { id: string }) => x.id === auto.id)
    expect(after.executor_seen_at).toBeTruthy()
  })

  it("an instruction colliding with an existing agent name mints under a suffix", async () => {
    await app.request("/v1/agents", jsonAs(as(owner.email), { name: "watch the dashboards" }))
    const created = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        trigger: { kind: "manual" },
        instruction: "watch the dashboards",
      }),
    )
    expect(created.status).toBe(201)
    const auto = await created.json()
    const roster = (await (await app.request("/v1/agents", { headers: as(owner.email) })).json())
      .agents
    const minted = roster.find((a: { id: string }) => a.id === auto.agent_id)
    expect(minted.managed).toBe(true)
    expect(minted.name).toMatch(/^watch the dashboards .{4}$/)
  })

  it("an explicit agentId still works and returns no token", async () => {
    const ag = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Service Runner" }))
    ).json()
    const created = await (
      await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          agentId: ag.id,
          trigger: { kind: "manual" },
          instruction: "run as the service agent",
        }),
      )
    ).json()
    expect(created.agent_id).toBe(ag.id)
    expect(created.agent_token).toBeUndefined()
  })
})
