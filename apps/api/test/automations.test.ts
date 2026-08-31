import { generateKeyPairSync } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { encryptSecret } from "../src/lib/crypto"
import { upsertGithubConnection } from "../src/lib/github-connection"
import {
  as,
  bearer,
  connectPoolPlan,
  jsonAs,
  makeAuthedApp,
  publishAs,
  type TestUser,
} from "./helpers"

const { privateKey: GITHUB_APP_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})

afterEach(() => vi.unstubAllGlobals())

// Automations + runs — the generic agent-work primitive. An owner defines an
// automation (agent + trigger + instruction); "run now" enqueues a run; the agent claims
// the queued run, finishes it, and the workspace ledger lists it. A "living doc refresh" is
// just an automation with a doc ref, run on demand — the same path a schedule/webhook takes.
describe("automations + runs", () => {
  const owner: TestUser = { id: "u_auto_own", email: "autoown@derive.test", name: "Owner" }
  const member: TestUser = { id: "u_auto_mem", email: "automem@derive.test", name: "Member" }
  const { app, meta } = makeAuthedApp("automations", [owner, member], "commenter")
  const { app: badPokeApp, meta: badPokeMeta } = makeAuthedApp(
    "automations-bad-poke",
    [owner],
    "commenter",
    {
      deps: {
        pokeRun: () => {
          throw new Error("queue unavailable")
        },
      },
    },
  )

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

  it("dispatches GitHub Actions directly without a model plan or executor", async () => {
    const key = "direct-github-actions-key"
    const direct = makeAuthedApp("automations-direct-github", [owner], "editor", {
      noPlan: true,
      deps: { encryptionKey: key },
    })
    await direct.meta.setGithubApp({
      id: "default",
      app_id: "553",
      slug: "derive-test",
      client_id: "Iv1.test",
      client_secret: encryptSecret("client-secret", key),
      private_key: encryptSecret(GITHUB_APP_PEM, key),
      created_at: new Date().toISOString(),
    })
    const connection = await upsertGithubConnection(direct.meta, {
      orgId: "default",
      userId: owner.id,
      installationId: "99004",
      accountLogin: "Niftory",
    })
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const href = String(url)
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ url: href, body })
        if (href.includes("/app/installations/99004/access_tokens"))
          return new Response(
            JSON.stringify({
              token: "github-actions-token",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
            { status: 201 },
          )
        return new Response(
          JSON.stringify({
            workflow_run_id: 7788,
            html_url: "https://github.com/Niftory/sift/actions/runs/7788",
          }),
          { status: 200 },
        )
      }),
    )

    const unsafe = await direct.app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        trigger: {
          kind: "manual",
          action: {
            kind: "github_workflow",
            owner: "Niftory",
            repo: "sift",
            workflow: "release.yml",
            ref: "main",
          },
        },
        instruction: "Run a workflow",
        connectionIds: [connection.id],
      }),
    )
    expect(unsafe.status).toBe(400)
    expect(calls).toEqual([])

    const created = await direct.app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        trigger: {
          kind: "manual",
          action: {
            kind: "github_workflow",
            owner: "Niftory",
            repo: "sift",
            workflow: "derive-docs-refresh.yml",
            ref: "main",
            inputs: { source_sha: "abc123" },
          },
        },
        instruction: "Run Niftory/sift · derive-docs-refresh.yml",
        refs: ["artifact-proof"],
        connectionIds: [connection.id],
        runNow: true,
      }),
    )
    expect(created.status).toBe(201)
    const automation = (await created.json()) as {
      id: string
      agent_token?: string
      refs?: unknown
      run_id?: string
      run_status?: string
    }
    expect(automation.agent_token).toBeUndefined()
    expect(automation.refs).toEqual([{ kind: "artifact", id: "artifact-proof" }])
    expect(automation).toMatchObject({
      run_id: expect.stringMatching(/^run_/),
      run_status: "succeeded",
    })

    const dispatched = await direct.app.request(
      `/v1/automations/${automation.id}/run`,
      jsonAs(as(owner.email), {}),
    )
    expect(dispatched.status).toBe(201)
    expect(await dispatched.json()).toMatchObject({ status: "succeeded" })
    expect(calls).toEqual([
      {
        url: expect.stringContaining("/app/installations/99004/access_tokens"),
        body: { permissions: { actions: "write", metadata: "read" }, repositories: ["sift"] },
      },
      {
        url: "https://api.github.com/repos/Niftory/sift/actions/workflows/derive-docs-refresh.yml/dispatches",
        body: { ref: "main", inputs: { source_sha: "abc123" } },
      },
      {
        url: "https://api.github.com/repos/Niftory/sift/actions/workflows/derive-docs-refresh.yml/dispatches",
        body: { ref: "main", inputs: { source_sha: "abc123" } },
      },
    ])
    const [run] = await direct.meta.listRuns("default")
    expect(run).toMatchObject({ status: "succeeded", automation_id: automation.id })
    expect(JSON.parse(run?.meta ?? "{}")).toMatchObject({
      outcome: "dispatched",
      response: { workflow_run_id: 7788 },
      github_action: {
        run_id: "7788",
        url: "https://github.com/Niftory/sift/actions/runs/7788",
      },
    })
  })

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
    // The claim hands the executor everything it needs: the instruction, targets, tools.
    expect(mine.instruction).toBe("keep the roadmap current")
    // The wallet key rides the claim: Run-now stamps the clicker as the initiator, so
    // the executor bills THEIR plan (a schedule/event enqueue leaves it null).
    expect(mine.initiated_by).toBe("u_auto_own")
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

  it("snapshots Codex onto the run, so a later automation edit cannot reroute accepted work", async () => {
    const agent = await mintAgent()
    await connectPoolPlan(meta, "default", "codex")
    const created = await (await createAutomation(agent.id, { provider: "codex" })).json()
    expect(created.provider).toBe("codex")

    const queued = await (
      await app.request(`/v1/automations/${created.id}/run`, {
        method: "POST",
        headers: as(owner.email),
      })
    ).json()
    await app.request(`/v1/automations/${created.id}`, {
      ...jsonAs(as(owner.email), { provider: "claude-code" }),
      method: "PATCH",
    })

    const claimed = await (
      await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    ).json()
    const run = claimed.runs.find((r: { id: string }) => r.id === queued.id)
    expect(run.execution).toEqual({
      version: 1,
      provider: "codex",
      location: "hosted",
      model: null,
    })
  })

  it("create-and-run atomically queues the first Codex proof without exposing a standing token", async () => {
    await connectPoolPlan(meta, "default", "codex")
    const res = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        trigger: { kind: "manual" },
        instruction: "prove the hosted Codex path",
        provider: "codex",
        runNow: true,
      }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ provider: "codex", run_status: "queued" })
    expect(body.run_id).toMatch(/^run_/)
    expect(body.agent_token).toBeUndefined()
    expect(JSON.parse((await meta.getRun(body.run_id))?.meta ?? "{}").execution.provider).toBe(
      "codex",
    )
  })

  it("keeps an atomic create-and-run when the best-effort dispatch nudge is unavailable", async () => {
    await connectPoolPlan(badPokeMeta, "default", "codex")
    const res = await badPokeApp.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        trigger: { kind: "manual" },
        instruction: "queue durably even when the nudge is down",
        provider: "codex",
        runNow: true,
      }),
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.run_status).toBe("queued")
    expect((await badPokeMeta.getRun(body.run_id))?.status).toBe("queued")
  })

  it("binds complex runs to a context and lets an edit remove that methodology", async () => {
    await connectPoolPlan(meta, "default", "codex")
    const manifest = await publishAs(
      app,
      "# Release method\n\nInspect the repository and apply the release checklist.",
      { title: "Release method" },
      as(owner.email),
    )
    const manifestId = ((await manifest.json()) as { short_id: string }).short_id
    const contextRes = await app.request(
      "/v1/contexts",
      jsonAs(as(owner.email), { name: "Release operator", manifest_short_id: manifestId }),
    )
    expect(contextRes.status).toBe(201)
    const context = (await contextRes.json()) as {
      id: string
      agent_id: string
      agent_token: string
    }

    const createdRes = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        contextId: context.id,
        trigger: { kind: "manual" },
        instruction: "prepare this week's release artifact",
        provider: "codex",
      }),
    )
    expect(createdRes.status).toBe(201)
    const created = await createdRes.json()
    expect(created).toMatchObject({ context_id: context.id, agent_id: context.agent_id })

    await app.request(`/v1/automations/${created.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    const claimed = await (
      await app.request("/v1/agent/runs/claim", { headers: bearer(context.agent_token) })
    ).json()
    const run = claimed.runs.find(
      (candidate: { automation_id: string }) => candidate.automation_id === created.id,
    )
    expect(run).toMatchObject({ context_id: context.id, execution: { provider: "codex" } })

    const unbound = await (
      await app.request(`/v1/automations/${created.id}`, {
        ...jsonAs(as(owner.email), { contextId: null }),
        method: "PATCH",
      })
    ).json()
    expect(unbound.context_id).toBeNull()
    expect(unbound.agent_id).toBe(context.agent_id)
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

  it("the agentWrites switch stops the claim at the door — runs wait, un-leased", async () => {
    // The one brake, enforced server-side where it cannot be bypassed by an executor: with
    // agents switched off, the claim returns nothing — no lease, no model spend, no draft to
    // lose. The run stays queued and fires when the switch comes back on.
    const agent = await mintAgent()
    const created = await (await createAutomation(agent.id)).json()
    const runRes = await app.request(`/v1/automations/${created.id}/run`, {
      method: "POST",
      headers: as(owner.email),
    })
    const { id: runId } = (await runRes.json()) as { id: string }

    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      agentWrites: false,
    })
    const paused = await (
      await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    ).json()
    expect(paused.runs).toEqual([])

    // Flip it back: the SAME run is claimable — nothing was failed or dropped.
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      agentWrites: true,
    })
    const resumed = await (
      await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    ).json()
    expect(resumed.runs.some((r: { id: string }) => r.id === runId)).toBe(true)
  })

  it("PATCH edits in place: instruction, refs (normalized), pause/resume; org + role scoped", async () => {
    const agent = await mintAgent()
    const created = await (await createAutomation(agent.id)).json()

    const edited = await (
      await app.request(`/v1/automations/${created.id}`, {
        ...jsonAs(as(owner.email), {
          instruction: "keep the CHANGELOG current",
          refs: [{ kind: "artifact", id: "art_x" }, "art_y"],
        }),
        method: "PATCH",
      })
    ).json()
    expect(edited.instruction).toBe("keep the CHANGELOG current")
    expect(edited.refs).toEqual([
      { kind: "artifact", id: "art_x" },
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
})

// WO1 — the fire URL (the "webhook kick" the run queue was built for). An external system
// POSTs to a per-automation secret URL; the body becomes run input, and a burst of fires
// coalesces into one queued run carrying every payload. Authed by the secret alone.
describe("automations: fire URL (webhook kick)", () => {
  const owner: TestUser = { id: "u_fire_own", email: "fireown@derive.test", name: "Owner" }
  const { app } = makeAuthedApp("automations-fire", [owner], "commenter")

  let n = 0
  const mintAgent = async () => {
    n += 1
    const res = await app.request("/v1/agents", jsonAs(as(owner.email), { name: `Runner ${n}` }))
    return (await res.json()) as { id: string; token: string }
  }
  const createWebhookAutomation = async (over: object = {}) => {
    const agent = await mintAgent()
    const res = await app.request(
      "/v1/automations",
      jsonAs(as(owner.email), {
        agentId: agent.id,
        trigger: { kind: "event", on: "webhook" },
        instruction: "fold the payload into the changelog",
        ...over,
      }),
    )
    return { agent, body: (await res.json()) as Record<string, unknown> }
  }
  const fire = (id: string, secret: string | undefined, body: string) =>
    app.request(`/v1/automations/${id}/fire`, {
      method: "POST",
      headers: {
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        "content-type": "application/json",
      },
      body,
    })
  const ledger = async () => {
    const res = await app.request("/v1/workspace/runs", { headers: as(owner.email) })
    return ((await res.json()) as { runs: { id: string; reason: string; meta: string | null }[] })
      .runs
  }

  it("mints a fire secret once on create; the secret is never readable again", async () => {
    const { body } = await createWebhookAutomation()
    expect(body.fire_secret).toMatch(/^dfire_/)
    expect(body.fire_url).toBe(`/v1/automations/${body.id}/fire`)
    expect(body.has_fire_url).toBe(true)
    // The stored hash never surfaces on read; the raw secret is gone after this response.
    expect((body.trigger as Record<string, unknown>).secret_hash).toBeUndefined()
    const listed = (await (
      await app.request("/v1/automations", { headers: as(owner.email) })
    ).json()) as { automations: Record<string, unknown>[] }
    const mine = listed.automations.find((x) => x.id === body.id)
    expect(mine?.has_fire_url).toBe(true)
    expect(mine?.fire_secret).toBeUndefined()
    expect((mine?.trigger as Record<string, unknown>).secret_hash).toBeUndefined()
  })

  it("a valid secret fires a run; the payload rides into the run", async () => {
    const { body } = await createWebhookAutomation()
    const res = await fire(
      body.id as string,
      body.fire_secret as string,
      JSON.stringify({ release: "v2.4.0" }),
    )
    expect(res.status).toBe(202)
    const out = (await res.json()) as { id: string; status: string; coalesced: boolean }
    expect(out).toMatchObject({ status: "queued", coalesced: false })
    const row = (await ledger()).find((r) => r.id === out.id)
    expect(row?.reason).toBe("fire")
    expect(JSON.parse(row?.meta ?? "{}").payloads).toEqual([{ release: "v2.4.0" }])
  })

  it("the payload reaches the EXECUTOR, not just the run row", async () => {
    // The seam nothing covered, and which was broken the whole time: payloads were validated,
    // capped, coalesced and CAS-appended onto the run, and then the claim response never
    // returned them — so a webhook-triggered run executed with no idea what had fired it.
    // Asserting the row proves storage; only this proves DELIVERY.
    const { agent, body } = await createWebhookAutomation()
    await fire(body.id as string, body.fire_secret as string, JSON.stringify({ release: "v9" }))
    const claim = await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    expect(claim.status).toBe(200)
    const { runs } = (await claim.json()) as {
      runs: { automation_id: string; payloads: unknown[] }[]
    }
    expect(runs.find((r) => r.automation_id === body.id)?.payloads).toEqual([{ release: "v9" }])
  })

  it("a burst coalesces: many fires fold into one run carrying every payload", async () => {
    const { body } = await createWebhookAutomation()
    const ids = new Set<string>()
    for (let i = 0; i < 10; i += 1) {
      const out = (await (
        await fire(body.id as string, body.fire_secret as string, JSON.stringify({ i }))
      ).json()) as { id: string }
      ids.add(out.id)
    }
    // All ten folded into ONE queued run.
    expect(ids.size).toBe(1)
    const runId = [...ids][0]
    const row = (await ledger()).find((r) => r.id === runId)
    const payloads = JSON.parse(row?.meta ?? "{}").payloads as { i: number }[]
    expect(payloads).toHaveLength(10)
    expect(payloads.map((p) => p.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it("a fire after the run is claimed starts a fresh run (never folds into a running run)", async () => {
    const { agent, body } = await createWebhookAutomation()
    const first = (await (
      await fire(body.id as string, body.fire_secret as string, JSON.stringify({ a: 1 }))
    ).json()) as { id: string }
    // Claim it → running; the next fire cannot fold into a run that has left the queue.
    await app.request("/v1/agent/runs/claim", { headers: bearer(agent.token) })
    const second = (await (
      await fire(body.id as string, body.fire_secret as string, JSON.stringify({ a: 2 }))
    ).json()) as { id: string; coalesced: boolean }
    expect(second.id).not.toBe(first.id)
    expect(second.coalesced).toBe(false)
  })

  it("a bad secret is 401; a missing or non-webhook automation is 404", async () => {
    const { body } = await createWebhookAutomation()
    expect((await fire(body.id as string, "dfire_wrong", "{}")).status).toBe(401)
    expect((await fire(body.id as string, undefined, "{}")).status).toBe(401)
    expect((await fire("auto_nope", "dfire_x", "{}")).status).toBe(404)
    // A non-webhook automation has no fire URL → 404, never revealing its trigger kind.
    const agent = await mintAgent()
    const manual = (await (
      await app.request(
        "/v1/automations",
        jsonAs(as(owner.email), {
          agentId: agent.id,
          trigger: { kind: "manual" },
          instruction: "x",
        }),
      )
    ).json()) as { id: string; has_fire_url: boolean }
    expect(manual.has_fire_url).toBe(false)
    expect((await fire(manual.id, "dfire_x", "{}")).status).toBe(404)
  })

  it("a disabled automation refuses fires; empty, invalid, and oversized bodies are handled", async () => {
    const { body: off } = await createWebhookAutomation({ enabled: false })
    expect((await fire(off.id as string, off.fire_secret as string, "{}")).status).toBe(400)

    const { body: live } = await createWebhookAutomation()
    // An empty body fires with an empty payload.
    expect((await fire(live.id as string, live.fire_secret as string, "")).status).toBe(202)
    // Invalid JSON is rejected before it can reach the queue.
    expect((await fire(live.id as string, live.fire_secret as string, "{not json")).status).toBe(
      400,
    )
    // An over-cap body is rejected.
    const huge = JSON.stringify({ big: "x".repeat(70_000) })
    expect((await fire(live.id as string, live.fire_secret as string, huge)).status).toBe(413)
  })
})
