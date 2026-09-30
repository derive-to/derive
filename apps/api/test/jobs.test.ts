import { describe, expect, it } from "vitest"
import {
  JobClient,
  jobDrainPass,
  loadJobRunnerConfig,
  serveJob,
} from "../../../packages/cli/src/job-runner.js"
import { jobTick } from "../src/lib/jobs"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// THE AGENT MODEL, through the surface people and runners use: an agent is created, asked,
// pulled, reported on, followed up, answered, scheduled, paused, and fenced.

const owner: TestUser = { id: "u_job_own", email: "jobown@derive.test", name: "Owner" }
const ed: TestUser = { id: "u_job_ed", email: "jobed@derive.test", name: "Ed" }
const outsider: TestUser = { id: "u_job_out", email: "jobout@derive.test", name: "Outsider" }

type App = ReturnType<typeof makeAuthedApp>["app"]

const setup = async (name: string, opts: { noPlan?: boolean } = {}) => {
  const made = makeAuthedApp(name, [owner, ed, outsider], "editor", {
    deps: { encryptionKey: "test-encryption-key" },
    ...opts,
  })
  const { app, meta } = made
  await app.request("/v1/me", { headers: as(owner.email) })
  await app.request("/v1/me", { headers: as(ed.email) })
  // The outsider signs in but holds no seat in this workspace.
  await app.request("/v1/me", { headers: as(outsider.email) })
  await meta.removeMembership("default", outsider.id).catch(() => {})
  return made
}

const createAgent = async (app: App, body: Record<string, unknown> = {}) => {
  const res = await app.request(
    "/v1/agents",
    jsonAs(as(owner.email), {
      name: `Analytics ${Math.random().toString(36).slice(2, 7)}`,
      role: "editor",
      ...body,
    }),
  )
  expect(res.status).toBe(201)
  return (await res.json()) as {
    id: string
    token: string
    runner_command: string | null
    machine: string
  }
}

const ask = (
  app: App,
  who: string,
  agentId: string,
  instruction: string,
  extra: Record<string, unknown> = {},
) => app.request("/v1/jobs", jsonAs(as(who), { agent_id: agentId, instruction, ...extra }))

const pull = async (app: App, agent: { id: string; token: string }) => {
  const res = await app.request(`/v1/agents/${agent.id}/pull`, jsonAs(bearer(agent.token), {}))
  expect(res.status).toBe(200)
  return (
    (await res.json()) as {
      jobs: Array<Record<string, unknown> & { id: string; started_at: string }>
    }
  ).jobs
}

const report = (app: App, token: string, jobId: string, body: Record<string, unknown>) =>
  app.request(`/v1/jobs/${jobId}/report`, jsonAs(bearer(token), body))

describe("jobs: ask, pull, report", () => {
  it("an agent on the owner's machine is created with the command that runs it", async () => {
    const { app } = await setup("jobs-create")
    const a = await createAgent(app)
    expect(a.machine).toBe("owner")
    expect(a.runner_command).toContain(`--agent ${a.id}`)
    expect(a.runner_command).toContain(a.token)
    // A commenter-grade seat cannot create one.
    const { app: app2 } = makeAuthedApp("jobs-create-c", [owner, ed], "commenter")
    await app2.request("/v1/me", { headers: as(owner.email) })
    await app2.request("/v1/me", { headers: as(ed.email) })
    expect((await app2.request("/v1/agents", jsonAs(as(ed.email), { name: "Nope" }))).status).toBe(
      403,
    )
  })

  it("a member asks; the runner pulls it with its transcript and instructions; the report settles it", async () => {
    const { app } = await setup("jobs-loop")
    const manifest = (await (
      await publishAs(
        app,
        "<h1>Analytics</h1><p>Answer data questions.</p>",
        { title: "Analytics" },
        as(owner.email),
      )
    ).json()) as { short_id: string }
    const a = await createAgent(app, { instructions_short_id: manifest.short_id })
    const asked = await ask(app, ed.email, a.id, "How many active orgs had sessions yesterday?")
    expect(asked.status).toBe(201)
    const job = (await asked.json()) as {
      id: string
      status: string
      messages: { body_md: string }[]
    }
    expect(job.status).toBe("queued")
    expect(job.messages.map((m) => m.body_md)).toEqual([
      "How many active orgs had sessions yesterday?",
    ])

    const [pulled] = await pull(app, a)
    if (!pulled) throw new Error("nothing pulled")
    expect(pulled.id).toBe(job.id)
    expect(pulled.status).toBe("running")
    expect((pulled.instructions as { body_md: string }).body_md).toContain("Answer data questions.")
    expect(await pull(app, a)).toEqual([]) // claimed once

    // A settle naming the wrong claim lands nowhere.
    expect(
      (
        await report(app, a.token, job.id, {
          started_at: "1999-01-01T00:00:00.000Z",
          status: "succeeded",
        })
      ).status,
    ).toBe(409)
    const ok = await report(app, a.token, job.id, {
      started_at: pulled.started_at,
      status: "succeeded",
      body_md: "357 orgs.",
      cost_micro_usd: 1200,
      result: { effects: [{ kind: "page", label: "Active orgs", ref: manifest.short_id }] },
    })
    expect(ok.status).toBe(200)
    const detail = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(owner.email) })
    ).json()) as {
      status: string
      cost_micro_usd: number
      result: { effects: unknown[] }
      messages: { author_kind: string; body_md: string }[]
    }
    expect(detail.status).toBe("succeeded")
    expect(detail.cost_micro_usd).toBe(1200)
    expect(detail.result.effects).toHaveLength(1)
    expect(detail.messages.map((m) => m.author_kind)).toEqual(["asker", "agent"])
  })

  it("a follow-up reopens a settled job with its transcript; the runner sees both turns", async () => {
    const { app } = await setup("jobs-followup")
    const a = await createAgent(app)
    const job = (await (await ask(app, ed.email, a.id, "first question")).json()) as { id: string }
    const [p1] = await pull(app, a)
    await report(app, a.token, job.id, {
      started_at: p1?.started_at ?? null,
      status: "succeeded",
      body_md: "first answer",
    })
    const again = await app.request(
      `/v1/jobs/${job.id}/messages`,
      jsonAs(as(ed.email), { body_md: "and yesterday?" }),
    )
    expect(((await again.json()) as { status: string }).status).toBe("queued")
    const [p2] = await pull(app, a)
    expect(p2?.id).toBe(job.id)
    expect((p2?.messages as { body_md: string }[]).map((m) => m.body_md)).toEqual([
      "first question",
      "first answer",
      "and yesterday?",
    ])
  })

  it("needs_you waits on a person; the answer must be an authored option and reopens the job", async () => {
    const { app } = await setup("jobs-needs")
    const a = await createAgent(app)
    const job = (await (await ask(app, ed.email, a.id, "send the September update")).json()) as {
      id: string
    }
    const [p] = await pull(app, a)
    await report(app, a.token, job.id, {
      started_at: p?.started_at ?? null,
      status: "needs_you",
      needs: { kind: "effect", question: "Send to 14 customers?", options: ["Send", "Skip"] },
    })
    const waiting = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
    ).json()) as {
      status: string
      needs: { options: string[] }
    }
    expect(waiting.status).toBe("needs_you")
    expect(waiting.needs.options).toEqual(["Send", "Skip"])
    expect(
      (await app.request(`/v1/jobs/${job.id}/answer`, jsonAs(as(ed.email), { option: "Maybe" })))
        .status,
    ).toBe(400)
    const answered = await app.request(
      `/v1/jobs/${job.id}/answer`,
      jsonAs(as(ed.email), { option: "Send" }),
    )
    expect(((await answered.json()) as { status: string }).status).toBe("queued")
    const [again] = await pull(app, a)
    expect((again?.messages as { body_md: string }[]).at(-1)?.body_md).toContain("Decision: Send")
  })

  it("a retryable failure requeues within the attempt cap; a plain failure settles and can be retried", async () => {
    const { app } = await setup("jobs-retry")
    const a = await createAgent(app)
    const job = (await (await ask(app, ed.email, a.id, "flaky")).json()) as { id: string }
    const [p1] = await pull(app, a)
    await report(app, a.token, job.id, {
      started_at: p1?.started_at ?? null,
      status: "failed",
      retryable: true,
      cost_micro_usd: 100,
    })
    const [p2] = await pull(app, a)
    expect(p2?.attempt).toBe(1)
    await report(app, a.token, job.id, {
      started_at: p2?.started_at ?? null,
      status: "failed",
      cost_micro_usd: 100,
    })
    const failed = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
    ).json()) as {
      status: string
      cost_micro_usd: number
    }
    expect(failed.status).toBe("failed")
    expect(failed.cost_micro_usd).toBe(200) // cost accumulates across attempts
    expect(
      (
        (await (
          await app.request(`/v1/jobs/${job.id}/retry`, jsonAs(as(ed.email), {}))
        ).json()) as { status: string }
      ).status,
    ).toBe("queued")
  })

  it("a dedupe key returns the open job instead of opening a second one", async () => {
    const { app } = await setup("jobs-dedupe")
    const a = await createAgent(app)
    const first = await ask(app, ed.email, a.id, "refresh MRR", { dedupe_key: "mrr" })
    const second = await ask(app, ed.email, a.id, "refresh MRR", { dedupe_key: "mrr" })
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(((await first.json()) as { id: string }).id).toBe(
      ((await second.json()) as { id: string }).id,
    )
  })
})

describe("jobs: who may ask, see, and run", () => {
  it("an invited-only agent refuses a member who is not its creator; a non-member sees nothing", async () => {
    const { app } = await setup("jobs-access")
    const a = await createAgent(app, { ask_policy: "invited" })
    expect((await ask(app, ed.email, a.id, "hi")).status).toBe(404)
    const mine = (await (await ask(app, owner.email, a.id, "hi")).json()) as { id: string }
    expect((await app.request(`/v1/jobs/${mine.id}`, { headers: as(outsider.email) })).status).toBe(
      404,
    )
    expect((await app.request(`/v1/agents/${a.id}`, { headers: as(outsider.email) })).status).toBe(
      404,
    )
    const detail = (await (
      await app.request(`/v1/agents/${a.id}`, { headers: as(ed.email) })
    ).json()) as {
      can_ask: boolean
      can_manage: boolean
    }
    expect(detail).toMatchObject({ can_ask: false, can_manage: false })
  })

  it("a runner pulls and reports only its own agent's work", async () => {
    const { app } = await setup("jobs-fence")
    const a = await createAgent(app)
    const b = await createAgent(app)
    const job = (await (await ask(app, ed.email, a.id, "for a")).json()) as { id: string }
    expect((await app.request(`/v1/agents/${a.id}/pull`, jsonAs(bearer(b.token), {}))).status).toBe(
      403,
    )
    const [p] = await pull(app, a)
    expect(
      (
        await report(app, b.token, job.id, {
          started_at: p?.started_at ?? null,
          status: "succeeded",
        })
      ).status,
    ).toBe(404)
    // A person's session is not a runner.
    expect((await app.request(`/v1/agents/${a.id}/pull`, jsonAs(as(owner.email), {}))).status).toBe(
      401,
    )
  })

  it("a paused agent, or a workspace with agent writes off, hands a runner nothing", async () => {
    const { app, meta } = await setup("jobs-brake")
    const a = await createAgent(app)
    await ask(app, ed.email, a.id, "while paused")
    expect(
      (
        await app.request(`/v1/agents/${a.id}`, {
          ...jsonAs(as(owner.email), { paused: true }),
          method: "PATCH",
        })
      ).status,
    ).toBe(200)
    expect(await pull(app, a)).toEqual([])
    await app.request(`/v1/agents/${a.id}`, {
      ...jsonAs(as(owner.email), { paused: false }),
      method: "PATCH",
    })
    const settings = await meta.getOrgSettings("default")
    await meta.setOrgSettings("default", { ...settings, agentWrites: false })
    expect(await pull(app, a)).toEqual([])
    await meta.setOrgSettings("default", settings)
    expect(await pull(app, a)).toHaveLength(1)
  })

  it("cancelling a graph job cancels its open children", async () => {
    const { app, meta } = await setup("jobs-cancel")
    const a = await createAgent(app)
    const parent = (await (
      await ask(app, ed.email, a.id, "run the certification graph")
    ).json()) as { id: string }
    const child = await meta.createJob({
      id: "job_child_1",
      org_id: "default",
      agent_id: a.id,
      kind: "node",
      parent_id: parent.id,
      node_id: "certify",
      instruction: "certify",
    })
    expect(
      (await app.request(`/v1/jobs/${parent.id}/cancel`, jsonAs(as(ed.email), {}))).status,
    ).toBe(200)
    expect((await meta.getJob(child.id))?.status).toBe("cancelled")
  })
})

describe("jobs: schedules", () => {
  it("a schedule makes one job per window, not before it existed, and not while paused", async () => {
    const { app, meta } = await setup("jobs-schedule")
    const created = await app.request(
      "/v1/agents",
      jsonAs(as(owner.email), {
        name: "Stripe MRR",
        role: "editor",
        schedule: { cron: "0 9 * * *", tz: "UTC", instruction: "Rewrite the Stripe MRR page" },
      }),
    )
    const a = (await created.json()) as { id: string; token: string; trigger: { id: string } }
    expect(a.trigger.id).toBeTruthy()
    expect(
      (
        await app.request(
          "/v1/agents",
          jsonAs(as(owner.email), {
            name: "bad",
            schedule: { cron: "not cron", instruction: "x" },
          }),
        )
      ).status,
    ).toBe(400)
    // The 09:00 window of the day after tomorrow, twice: one job.
    const day = new Date(Date.now() + 2 * 86_400_000)
    const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 9, 30))
    await jobTick({ meta }, at)
    await jobTick({ meta }, at)
    const jobs = await meta.listJobs({ orgId: "default", agentId: a.id })
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ kind: "scheduled", instruction: "Rewrite the Stripe MRR page" })
    // Paused: the next window makes nothing.
    await app.request(`/v1/agents/${a.id}`, {
      ...jsonAs(as(owner.email), { paused: true }),
      method: "PATCH",
    })
    await jobTick({ meta }, new Date(at.getTime() + 86_400_000))
    expect(await meta.listJobs({ orgId: "default", agentId: a.id })).toHaveLength(1)
    // A schedule can be switched off and removed by its owner, not by another editor.
    expect(
      (
        await app.request(`/v1/triggers/${a.trigger.id}`, {
          ...jsonAs(as(ed.email), { enabled: false }),
          method: "PATCH",
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await app.request(`/v1/triggers/${a.trigger.id}`, {
          ...jsonAs(as(owner.email), { enabled: false }),
          method: "PATCH",
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await app.request(`/v1/triggers/${a.trigger.id}`, {
          method: "DELETE",
          headers: as(owner.email),
        })
      ).status,
    ).toBe(204)
  })

  it("a lapsed lease is reclaimed by the tick and the job runs again", async () => {
    const { app, meta } = await setup("jobs-reclaim")
    const a = await createAgent(app)
    const job = (await (await ask(app, ed.email, a.id, "long one")).json()) as { id: string }
    await pull(app, a)
    await jobTick({ meta }, new Date(Date.now() + 2 * 60 * 60_000))
    expect(await meta.getJob(job.id)).toMatchObject({ status: "queued", attempt: 1 })
    expect((await pull(app, a))[0]?.id).toBe(job.id)
  })
})

describe("jobs: which account a job runs with", () => {
  it("the asker's own account, then the workspace's shared one; an assigned account wins", async () => {
    const { app } = await setup("jobs-accounts")
    const a = await createAgent(app)
    const addAccount = async (who: string, body: Record<string, unknown>) => {
      const res = await app.request(
        "/v1/accounts",
        jsonAs(as(who), { provider: "claude", kind: "api_key", ...body }),
      )
      expect(res.status).toBe(201)
      return (await res.json()) as { id: string; hint: string }
    }
    // A shared account needs an owner.
    expect(
      (
        await app.request(
          "/v1/accounts",
          jsonAs(as(ed.email), {
            provider: "claude",
            kind: "api_key",
            secret: "sk-shared-0000",
            shared: true,
          }),
        )
      ).status,
    ).toBe(403)
    await addAccount(owner.email, { secret: "sk-shared-1111", shared: true })
    const mine = await addAccount(ed.email, { secret: "sk-ed-2222" })
    expect(mine.hint).toBe("…2222")

    const job = (await (await ask(app, ed.email, a.id, "use my key")).json()) as { id: string }
    const [p] = await pull(app, a)
    const credFor = async () =>
      (await (
        await app.request(`/v1/jobs/${job.id}/account`, { headers: bearer(a.token) })
      ).json()) as {
        credential: { value: string } | null
        source: string
      }
    expect(await credFor()).toMatchObject({ credential: { value: "sk-ed-2222" }, source: "asker" })

    // Ed disconnects theirs: the shared account covers the job.
    const accounts = (await (
      await app.request("/v1/accounts", { headers: as(ed.email) })
    ).json()) as {
      accounts: { id: string; mine: boolean; shared: boolean }[]
    }
    expect(accounts.accounts.filter((x) => x.shared)).toHaveLength(1)
    await app.request(`/v1/accounts/${mine.id}`, { method: "DELETE", headers: as(ed.email) })
    expect(await credFor()).toMatchObject({
      credential: { value: "sk-shared-1111" },
      source: "pool",
    })

    // Its manager assigns their own account; a teammate's cannot be assigned.
    const own = await addAccount(owner.email, { secret: "sk-owner-3333" })
    const edsSecond = await addAccount(ed.email, { secret: "sk-ed-4444" })
    const patch = (body: Record<string, unknown>) =>
      app.request(`/v1/agents/${a.id}`, { ...jsonAs(as(owner.email), body), method: "PATCH" })
    expect((await patch({ account_id: edsSecond.id })).status).toBe(400)
    expect((await patch({ account_id: own.id })).status).toBe(200)
    expect(await credFor()).toMatchObject({
      credential: { value: "sk-owner-3333" },
      source: "agent",
    })
    // Only the runner holding the job can read it.
    expect(
      (await app.request(`/v1/jobs/${job.id}/account`, { headers: as(owner.email) })).status,
    ).toBe(401)
    void p
  })
})

describe("jobs: the CLI runner (derive runner serve --agent)", () => {
  const runnerFor = (app: App, agent: { id: string; token: string }, extra = {}) => {
    const cfg = loadJobRunnerConfig(
      {},
      {
        agent: agent.id,
        token: agent.token,
        server: "http://derive.test",
        ...extra,
      },
    )
    return {
      cfg,
      client: new JobClient(cfg, (url, init) => Promise.resolve(app.request(url, init))),
    }
  }

  it("drains the agent's queue through pull and report", async () => {
    const { app } = await setup("jobs-cli-drain")
    const agent = await createAgent(app)
    const res = await ask(app, ed.email, agent.id, "Count the signups")
    const job = (await res.json()) as { id: string }
    const { cfg, client } = runnerFor(app, agent, { mock: "true" })
    expect(await jobDrainPass(cfg, client)).toEqual({ served: 1, failed: 0, considered: 1 })
    const done = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
    ).json()) as {
      status: string
      messages: { author_kind: string; body_md: string }[]
    }
    expect(done.status).toBe("succeeded")
    expect(done.messages.at(-1)?.author_kind).toBe("agent")
  })

  it("runs with the asker's account, and a retryable failure goes back in the queue", async () => {
    const { app } = await setup("jobs-cli-account")
    const agent = await createAgent(app)
    await app.request(
      "/v1/accounts",
      jsonAs(as(ed.email), { provider: "claude", kind: "api_key", secret: "sk-ant-ed-00001234" }),
    )
    const job = (await (await ask(app, ed.email, agent.id, "Go")).json()) as { id: string }
    const { cfg, client } = runnerFor(app, agent)
    const [pulled] = (await client.pull()).jobs
    if (!pulled) throw new Error("nothing pulled")
    let sawEnv: Record<string, string> = {}
    const out = await serveJob(client, pulled, cfg, {
      runAgent: async (_p, opts) => {
        sawEnv = opts.env as Record<string, string>
        return { ok: false, error: "provider overloaded", retryable: true }
      },
    })
    expect(out).toBe("failed")
    expect(sawEnv.ANTHROPIC_API_KEY).toBe("sk-ant-ed-00001234")
    const after = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
    ).json()) as {
      status: string
      attempt: number
    }
    expect(after).toMatchObject({ status: "queued", attempt: 1 })
  })

  it("a job with no account to run on fails with a sentence the owner can act on", async () => {
    const { app } = await setup("jobs-cli-noaccount", { noPlan: true })
    const agent = await createAgent(app)
    const job = (await (await ask(app, ed.email, agent.id, "Go")).json()) as { id: string }
    const { cfg, client } = runnerFor(app, agent)
    const [pulled] = (await client.pull()).jobs
    if (!pulled) throw new Error("nothing pulled")
    expect(
      await serveJob(client, pulled, cfg, {
        runAgent: async () => ({ ok: true, answer: { body_md: "x" } }),
      }),
    ).toBe("failed")
    const after = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
    ).json()) as {
      status: string
      messages: { body_md: string }[]
    }
    expect(after.status).toBe("failed")
    expect(after.messages.at(-1)?.body_md).toMatch(/no claude-code account for this agent/)
  })
})
