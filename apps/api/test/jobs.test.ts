import { describe, expect, it } from "vitest"
import {
  JobClient,
  jobDrainPass,
  loadJobRunnerConfig,
  loadOneJobConfig,
  runOneJob,
  serveJob,
} from "../../../packages/cli/src/job-runner.js"
import { graphAware, graphPass } from "../src/lib/job-graph"
import { machinePass, machineWorkspaces } from "../src/lib/job-machine"
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

describe("jobs: what a teammate cannot do with someone else's agent or job", () => {
  it("an agent cannot be given a teammate's personal connection", async () => {
    const { app, meta } = await setup("jobs-conn-bind")
    await meta.createConnection({
      id: "cn_ed_gmail",
      org_id: "default",
      user_id: ed.id,
      kind: "oauth",
      broker: "none",
      toolkit: "gmail",
      broker_ref: "ed_gmail",
      status: "active",
    })
    const made = await app.request(
      "/v1/agents",
      jsonAs(as(owner.email), { name: "Inbox", connection_ids: ["cn_ed_gmail"] }),
    )
    expect(made.status).toBe(400)
    const agent = await createAgent(app)
    const edit = await app.request(`/v1/agents/${agent.id}`, {
      ...jsonAs(as(owner.email), { connection_ids: ["cn_ed_gmail"] }),
      method: "PATCH",
    })
    expect(edit.status).toBe(400)
    // Ed may attach their own to an agent Ed makes.
    const edsOwn = await app.request(
      "/v1/agents",
      jsonAs(as(ed.email), { name: "Ed's inbox", connection_ids: ["cn_ed_gmail"] }),
    )
    expect(edsOwn.status).toBe(201)
  })

  it("only the asker or the agent's manager steers a job; everyone else only sees it", async () => {
    const { app } = await setup("jobs-steer")
    const agent = await createAgent(app)
    const job = (await (await ask(app, ed.email, agent.id, "Mine")).json()) as { id: string }
    // The asker may cancel their own job; on a job the owner asked, Ed only watches.
    const other = await app.request(`/v1/jobs/${job.id}/cancel`, jsonAs(as(ed.email), {}))
    expect(other.status).toBe(200)
    const again = (await (await ask(app, owner.email, agent.id, "Owner's")).json()) as {
      id: string
    }
    const byEd = await app.request(`/v1/jobs/${again.id}/cancel`, jsonAs(as(ed.email), {}))
    expect(byEd.status).toBe(403)
    const seen = await app.request(`/v1/jobs/${again.id}`, { headers: as(ed.email) })
    expect(seen.status).toBe(200)
  })

  it("a refused late report still counts what the run spent", async () => {
    const { app, meta } = await setup("jobs-late-cost")
    const agent = await createAgent(app)
    const job = (await (await ask(app, ed.email, agent.id, "Go")).json()) as { id: string }
    const [p] = await pull(app, agent)
    await app.request(`/v1/jobs/${job.id}/cancel`, jsonAs(as(ed.email), {}))
    const late = await app.request(
      `/v1/jobs/${job.id}/report`,
      jsonAs(bearer(agent.token), {
        started_at: p?.started_at,
        status: "succeeded",
        cost_micro_usd: 4200,
      }),
    )
    expect(late.status).toBe(409)
    expect(await meta.getJob(job.id)).toMatchObject({ status: "cancelled", cost_micro_usd: 4200 })

    // A settling report sent twice is counted once.
    const second = (await (await ask(app, ed.email, agent.id, "Again")).json()) as { id: string }
    const [q] = await pull(app, agent)
    const settle = () =>
      app.request(
        `/v1/jobs/${second.id}/report`,
        jsonAs(bearer(agent.token), {
          started_at: q?.started_at,
          status: "succeeded",
          cost_micro_usd: 1000,
        }),
      )
    expect((await settle()).status).toBe(200)
    expect((await settle()).status).toBe(409)
    expect((await meta.getJob(second.id))?.cost_micro_usd).toBe(1000)
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
    // While that run still waits (its runner is offline), the next window folds into it.
    await jobTick({ meta }, new Date(at.getTime() + 86_400_000))
    expect(await meta.listJobs({ orgId: "default", agentId: a.id })).toHaveLength(1)
    // Paused: the next window makes nothing.
    await app.request(`/v1/agents/${a.id}`, {
      ...jsonAs(as(owner.email), { paused: true }),
      method: "PATCH",
    })
    await meta.updateJob(jobs[0]?.id ?? "", { status: "succeeded" })
    await jobTick({ meta }, new Date(at.getTime() + 2 * 86_400_000))
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
  it("an owner-machine job never runs on a teammate's key; shared, then assigned accounts cover it", async () => {
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
        await app.request(
          `/v1/jobs/${job.id}/account?claim=${encodeURIComponent(p?.started_at ?? "")}`,
          {
            headers: bearer(a.token),
          },
        )
      ).json()) as {
        credential: { value: string } | null
        source: string
      }
    // The agent runs on its creator's machine, so Ed's own key never leaves for it: whoever
    // runs a job holds its credential. The shared account covers Ed's ask.
    expect(await credFor()).toMatchObject({
      credential: { value: "sk-shared-1111" },
      source: "pool",
    })
    const accounts = (await (
      await app.request("/v1/accounts", { headers: as(ed.email) })
    ).json()) as {
      accounts: { id: string; mine: boolean; shared: boolean }[]
    }
    expect(accounts.accounts.filter((x) => x.shared)).toHaveLength(1)
    expect(accounts.accounts.find((x) => x.mine)?.id).toBe(mine.id)

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
      report_short_id: string | null
      messages: { author_kind: string; body_md: string }[]
    }
    expect(done.status).toBe("succeeded")
    expect(done.messages.at(-1)?.author_kind).toBe("agent")
    // The job left a report page, as the agent, that the asker can read.
    expect(done.report_short_id).toBeTruthy()
    const source = async () =>
      (
        await app.request(`/v1/artifacts/${done.report_short_id}/content`, {
          headers: as(ed.email),
        })
      ).text()
    expect(await source()).toContain("## Asked\n\nCount the signups")

    // A follow-up reopens the job and rewrites the same page as a new version.
    await app.request(
      `/v1/jobs/${job.id}/messages`,
      jsonAs(as(ed.email), { body_md: "And last week?" }),
    )
    expect(await jobDrainPass(cfg, client)).toMatchObject({ served: 1 })
    const again = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
    ).json()) as { report_short_id: string | null }
    expect(again.report_short_id).toBe(done.report_short_id)
    expect(await source()).toContain("## Asked\n\nAnd last week?")
  })

  it("a report must be a page the agent made, not a teammate's", async () => {
    const { app } = await setup("jobs-report-owner")
    const agent = await createAgent(app)
    const theirs = (await (
      await publishAs(app, "# Ed's private notes", {}, as(ed.email))
    ).json()) as {
      short_id: string
    }
    const job = (await (await ask(app, ed.email, agent.id, "Go")).json()) as { id: string }
    const [p] = await pull(app, agent)
    const res = await app.request(
      `/v1/jobs/${job.id}/report`,
      jsonAs(bearer(agent.token), {
        started_at: p?.started_at,
        status: "succeeded",
        report_short_id: theirs.short_id,
      }),
    )
    expect(res.status).toBe(400)
  })

  it("runs with its creator's account, and a retryable failure goes back in the queue", async () => {
    const { app } = await setup("jobs-cli-account")
    const agent = await createAgent(app)
    await app.request(
      "/v1/accounts",
      jsonAs(as(owner.email), {
        provider: "claude",
        kind: "api_key",
        secret: "sk-ant-own-0001234",
      }),
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
    expect(sawEnv.ANTHROPIC_API_KEY).toBe("sk-ant-own-0001234")
    // The model never inherits the agent's key.
    expect(sawEnv.DERIVE_TOKEN).toBeUndefined()
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

describe("jobs: the Derive machine (one Ortam sandbox per agent)", () => {
  const config = {
    apiUrl: "https://ortam.test/v1",
    runnerPath: "/home/ortam/derive-runtime/0.8.0/node_modules/@derive-to/cli/bin/derive.js",
    runnerVersion: "0.8.0",
    pilotWorkspaceIds: new Set<string>(),
    managed: { apiKey: "integration fixture", workspaceIds: new Set(["default"]) },
  }
  /** A fake Ortam: sandboxes, operations that finish on the next read, and processes whose
   *  launch hands the test the env the runner would get. */
  const fakeOrtam = () => {
    const sandboxes = new Map<string, { id: string; state: string }>()
    const ops = new Map<string, { id: string; sandbox_id: string; kind: string; state: string }>()
    const procs = new Map<string, { id: string; status: string }>()
    const launches: Record<string, string>[] = []
    // Like Ortam, a repeated idempotency key returns the first answer, whatever happened since.
    const byKey = new Map<string, unknown>()
    const state = { failCreates: 0 }
    let n = 0
    const json = (v: unknown) =>
      new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } })
    const sandbox = (s: { id: string; state: string }) => ({
      ...s,
      version: 1,
      current_operation_id: null,
      auto_stop_after_seconds: 1200,
      agent_connections: null,
    })
    const op = (sandbox_id: string, kind: string) => {
      const o = { id: `op_${++n}`, sandbox_id, kind, state: "running" }
      ops.set(o.id, o)
      return o
    }
    const fetcher: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname.replace("/v1", "")
      const method = init?.method ?? "GET"
      const key = new Headers(init?.headers).get("Idempotency-Key")
      if (key && byKey.has(key)) return json(byKey.get(key))
      const keep = (v: unknown) => {
        if (key) byKey.set(key, v)
        return json(v)
      }
      if (path === "/auth/token")
        return json({
          token: `h.${Buffer.from(JSON.stringify({ sub: "svc", organization_id: "o" })).toString("base64url")}.s`,
        })
      if (path === "/integration") {
        const subject = new Headers(init?.headers).get("X-Ortam-Integration-Subject")
        return json({ organization_id: "o", user_id: `u:${subject}` })
      }
      if (path === "/sandboxes" && method === "POST") {
        const s = { id: `sbx_${++n}`, state: "ready" }
        sandboxes.set(s.id, s)
        const o = op(s.id, "create")
        if (state.failCreates > 0) {
          state.failCreates--
          o.state = "failed"
          s.state = "deleted"
        }
        return keep({ sandbox: sandbox(s), operation: o })
      }
      const del = path.match(/^\/sandboxes\/([^/]+)$/)
      if (del && method === "DELETE") {
        const s = sandboxes.get(decodeURIComponent(del[1] ?? ""))
        if (s) s.state = "deleted"
        return keep(op(s?.id ?? "", "delete"))
      }
      const opm = path.match(/^\/operations\/(.+)$/)
      if (opm) {
        const o = ops.get(decodeURIComponent(opm[1] ?? ""))
        if (!o) return new Response(null, { status: 404 })
        // Every operation completes by the time it is read (a failed one stays failed).
        if (o.state !== "failed") o.state = "succeeded"
        const s = sandboxes.get(o.sandbox_id)
        if (s && o.state === "succeeded")
          s.state = o.kind === "stop" ? "stopped" : o.kind === "delete" ? "deleted" : "ready"
        return json(o)
      }
      const life = path.match(/^\/sandboxes\/([^/]+)\/(resume|stop)$/)
      if (life) return keep(op(decodeURIComponent(life[1] ?? ""), life[2] ?? ""))
      const launch = path.match(/^\/sandboxes\/([^/]+)\/processes$/)
      if (launch && method === "POST") {
        const body = JSON.parse(String(init?.body)) as { env: Record<string, string> }
        launches.push(body.env)
        const p = { id: `proc_${++n}`, status: "running" }
        procs.set(p.id, p)
        return json(p)
      }
      const proc = path.match(/^\/sandboxes\/[^/]+\/processes\/([^/?]+)/)
      if (proc) return json(procs.get(decodeURIComponent(proc[1] ?? "")))
      const one = path.match(/^\/sandboxes\/([^/]+)$/)
      if (one) {
        const s = sandboxes.get(decodeURIComponent(one[1] ?? ""))
        return s ? json(sandbox(s)) : new Response(null, { status: 404 })
      }
      return new Response(null, { status: 404 })
    }
    return { fetcher, sandboxes, procs, launches, state }
  }

  it("brings up the agent's sandbox, runs the job with a job token, and stops it again", async () => {
    const made = makeAuthedApp("jobs-machine", [owner, ed, outsider], "editor", {
      deps: { encryptionKey: "test-encryption-key", runtime: config },
    })
    const { app, meta } = made
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(ed.email) })
    const created = await app.request(
      "/v1/agents",
      jsonAs(as(owner.email), { name: "Nightly digest", machine: "derive" }),
    )
    expect(created.status).toBe(201)
    const agent = (await created.json()) as { id: string; runner_command: string | null }
    expect(agent.runner_command).toBeNull()
    const job = (await (await ask(app, ed.email, agent.id, "Write the digest")).json()) as {
      id: string
    }

    const ortam = fakeOrtam()
    const deps = {
      meta,
      secret: "test-encryption-key",
      server: "http://derive.test",
      config,
      fetcher: ortam.fetcher,
    }
    // Each pass moves things one step; a handful brings the sandbox up and the job running.
    for (let i = 0; i < 12 && ortam.launches.length === 0; i++) await machinePass(deps)
    expect(ortam.launches).toHaveLength(1)
    const env = ortam.launches[0] ?? {}
    expect(env.DERIVE_TOKEN).toMatch(/^dkjob_/)
    expect(env.DERIVE_JOB_ID).toBe(job.id)

    // The job token reaches only its own job.
    const pullWithIt = await app.request(
      `/v1/agents/${agent.id}/pull`,
      jsonAs(bearer(env.DERIVE_TOKEN ?? ""), {}),
    )
    expect(pullWithIt.status).toBe(403)

    // The runner the sandbox launched: the real CLI one-job mode against the real routes.
    const cfg = loadOneJobConfig(
      { DERIVE_TOKEN: env.DERIVE_TOKEN, DERIVE_JOB_ID: env.DERIVE_JOB_ID },
      { server: "http://derive.test", mock: "true" },
    )
    const client = new JobClient(cfg, (url, init) => Promise.resolve(app.request(url, init)))
    expect(await runOneJob(cfg, client)).toBe("succeeded")
    expect((await meta.getJob(job.id))?.status).toBe("succeeded")

    // The job is done: the machine stops the sandbox and hands it back.
    for (const p of ortam.procs.values()) p.status = "exited"
    for (let i = 0; i < 6; i++) await machinePass(deps)
    expect(await meta.getJob(job.id)).toMatchObject({ machine_phase: "released" })
    expect(await meta.getAgent(agent.id)).toMatchObject({ sandbox_phase: "ready" })
    expect([...ortam.sandboxes.values()].map((s) => s.state)).toEqual(["stopped"])
    // And the finished job's token is dead.
    const after = await app.request(`/v1/jobs/${job.id}/work`, {
      headers: bearer(env.DERIVE_TOKEN ?? ""),
    })
    expect(after.status).toBe(401)
  })

  it("a runner that dies without reporting fails the job back into the queue", async () => {
    const made = makeAuthedApp("jobs-machine-dead", [owner, ed, outsider], "editor", {
      deps: { encryptionKey: "test-encryption-key", runtime: config },
    })
    const { app, meta } = made
    await app.request("/v1/me", { headers: as(owner.email) })
    const agent = (await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Flaky", machine: "derive" }))
    ).json()) as { id: string }
    const job = (await (await ask(app, owner.email, agent.id, "Go")).json()) as { id: string }
    const ortam = fakeOrtam()
    const deps = {
      meta,
      secret: "test-encryption-key",
      server: "http://derive.test",
      config,
      fetcher: ortam.fetcher,
    }
    for (let i = 0; i < 12 && ortam.launches.length === 0; i++) await machinePass(deps)
    for (const p of ortam.procs.values()) p.status = "failed"
    // The machine stops, fails the silent attempt, and the retry goes out on a fresh launch.
    for (let i = 0; i < 12 && ortam.launches.length < 2; i++) await machinePass(deps)
    expect(ortam.launches).toHaveLength(2)
    expect(await meta.getJob(job.id)).toMatchObject({ status: "running", attempt: 1 })
    const transcript = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(owner.email) })
    ).json()) as { messages: { body_md: string }[] }
    expect(transcript.messages.map((m) => m.body_md)).toContain(
      "The machine stopped before the job reported back.",
    )
  })

  const machineApp = async (name: string) => {
    const made = makeAuthedApp(name, [owner, ed, outsider], "editor", {
      deps: { encryptionKey: "test-encryption-key", runtime: config },
    })
    await made.app.request("/v1/me", { headers: as(owner.email) })
    await made.app.request("/v1/me", { headers: as(ed.email) })
    const agent = (await (
      await made.app.request(
        "/v1/agents",
        jsonAs(as(owner.email), { name: `M ${name}`, machine: "derive" }),
      )
    ).json()) as { id: string }
    const ortam = fakeOrtam()
    const deps = {
      meta: made.meta,
      secret: "test-encryption-key",
      server: "http://derive.test",
      config,
      fetcher: ortam.fetcher,
    }
    const runLaunched = async (i: number) => {
      const env = ortam.launches[i] ?? {}
      const cfg = loadOneJobConfig(
        { DERIVE_TOKEN: env.DERIVE_TOKEN, DERIVE_JOB_ID: env.DERIVE_JOB_ID },
        { server: "http://derive.test", mock: "true" },
      )
      const client = new JobClient(cfg, (url, init) => Promise.resolve(made.app.request(url, init)))
      return runOneJob(cfg, client)
    }
    const passUntil = async (done: () => boolean | Promise<boolean>, max = 16) => {
      for (let i = 0; i < max && !(await done()); i++) await machinePass(deps)
    }
    return { ...made, agent, ortam, deps, runLaunched, passUntil }
  }

  it("a reopened job gets a fresh turn on the machine, not its last turn's operations", async () => {
    const m = await machineApp("jobs-machine-reopen")
    const job = (await (await ask(m.app, ed.email, m.agent.id, "First")).json()) as { id: string }
    await m.passUntil(() => m.ortam.launches.length === 1)
    expect(await m.runLaunched(0)).toBe("succeeded")
    for (const p of m.ortam.procs.values()) p.status = "exited"
    await m.passUntil(async () => (await m.meta.getJob(job.id))?.machine_phase === "released")
    // A follow-up reopens the same job; its second turn resumes the sandbox for real.
    await m.app.request(`/v1/jobs/${job.id}/messages`, jsonAs(as(ed.email), { body_md: "Again" }))
    await m.passUntil(() => m.ortam.launches.length === 2)
    expect(m.ortam.launches).toHaveLength(2)
    expect(await m.runLaunched(1)).toBe("succeeded")
    expect(await m.meta.getJob(job.id)).toMatchObject({ status: "succeeded", attempt: 0 })
  })

  it("a sandbox that fails to come up is replaced, not asked for again by its old key", async () => {
    const m = await machineApp("jobs-machine-recreate")
    m.ortam.state.failCreates = 1
    await ask(m.app, ed.email, m.agent.id, "Go")
    await m.passUntil(async () => (await m.meta.getAgent(m.agent.id))?.sandbox_phase === "failed")
    // After the backoff, the next pass brings up a new sandbox and the job runs on it.
    const later = new Date(Date.now() + 11 * 60_000)
    const deps = { ...m.deps, now: () => later }
    for (let i = 0; i < 16 && m.ortam.launches.length === 0; i++) await machinePass(deps)
    expect(m.ortam.launches).toHaveLength(1)
    expect(m.ortam.sandboxes.size).toBe(2)
  })

  it("deleting an agent deletes its sandbox", async () => {
    const m = await machineApp("jobs-machine-delete")
    await ask(m.app, ed.email, m.agent.id, "Go")
    await m.passUntil(() => m.ortam.launches.length === 1)
    const made = makeAuthedApp("jobs-machine-delete", [owner, ed, outsider], "editor", {
      deps: {
        encryptionKey: "test-encryption-key",
        runtime: config,
        runtimeFetch: m.ortam.fetcher,
      },
    })
    const del = await made.app.request(`/v1/agents/${m.agent.id}`, {
      method: "DELETE",
      headers: as(owner.email),
    })
    expect(del.status).toBe(204)
    expect([...m.ortam.sandboxes.values()].map((s) => s.state)).toEqual(["deleted"])
  })

  it("a Derive agent's work is never pulled by another runner", async () => {
    const m = await machineApp("jobs-machine-nopull")
    await ask(m.app, ed.email, m.agent.id, "Go")
    const key = (await (
      await m.app.request(`/v1/agents/${m.agent.id}/rotate`, jsonAs(as(owner.email), {}))
    ).json()) as { token: string }
    const pulled = await m.app.request(
      `/v1/agents/${m.agent.id}/pull`,
      jsonAs(bearer(key.token), {}),
    )
    expect(((await pulled.json()) as { jobs: unknown[] }).jobs).toEqual([])
  })

  it("after a machine fails to start three times, the work waiting for it fails and says so", async () => {
    const m = await machineApp("jobs-machine-giveup")
    m.ortam.state.failCreates = 3
    const job = (await (await ask(m.app, ed.email, m.agent.id, "Go")).json()) as { id: string }
    let clock = Date.now()
    const deps = { ...m.deps, now: () => new Date(clock) }
    for (let i = 0; i < 60 && (await m.meta.getJob(job.id))?.status === "queued"; i++) {
      await machinePass(deps)
      clock += 31 * 60_000
    }
    const after = (await (
      await m.app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
    ).json()) as { status: string; messages: { body_md: string }[] }
    expect(after.status).toBe("failed")
    expect(after.messages.at(-1)?.body_md).toBe("Derive could not start a machine for this agent.")
  })

  it("waits for a sandbox runner that knows job tokens", () => {
    const at = (v: string) => ({
      ...config,
      runnerVersion: v,
      runnerPath: `/home/ortam/derive-runtime/${v}/x.js`,
    })
    expect(machineWorkspaces(at("0.7.2")).size).toBe(0)
    expect(machineWorkspaces(at("0.8.0")).has("default")).toBe(true)
    // A path ahead of what the sandbox installs would launch a runner that is not there.
    const ahead = { ...at("0.7.2"), runnerPath: "/home/ortam/derive-runtime/0.8.0/x.js" }
    expect(machineWorkspaces(ahead).size).toBe(0)
  })

  it("is refused where Derive machines are off", async () => {
    const { app } = await setup("jobs-machine-off")
    const res = await app.request(
      "/v1/agents",
      jsonAs(as(owner.email), { name: "Nope", machine: "derive" }),
    )
    expect(res.status).toBe(400)
  })
})

describe("jobs: graphs (a workflow on an agent's instructions page)", () => {
  const graphHtml = (writer: string, publisher: string) => {
    const nodes = [
      { id: "draft", label: "Draft", note: "Write the draft" },
      { id: "review", label: "Review", note: "A person decides" },
      { id: "publish", label: "Publish", note: "Publish it" },
    ]
    const edges = [
      { from: "draft", to: "review", label: "drafted" },
      { from: "review", to: "publish", label: "ship" },
      { from: "review", to: "draft", label: "revise" },
    ]
    const manifest = {
      schema: "derive.linked-bundle/v1",
      purpose: "Draft, review, publish",
      members: [],
      diagrams: [{ id: "ship", title: "Ship", type: "graph", nodes, edges }],
    }
    const definition = {
      schema: "derive.workflow/v1",
      purpose: "Draft, review, publish",
      diagrams: [
        {
          id: "ship",
          entry: "draft",
          nodes: [
            {
              id: "draft",
              kind: "context",
              context_ref: writer,
              instruction: "Write the draft.",
              result: "A draft",
            },
            {
              id: "review",
              kind: "human",
              decision: "Ship it?",
              options: ["ship", "revise"],
              resume: "Continue with the decision",
            },
            {
              id: "publish",
              kind: "context",
              context_ref: publisher,
              instruction: "Publish the draft.",
              result: "Published",
              terminal: true,
            },
          ],
          routes: [
            { from: "draft", to: "review", when: "drafted" },
            { from: "review", to: "publish", when: "ship" },
            { from: "review", to: "draft", when: "revise" },
          ],
          loops: [
            {
              id: "revise",
              nodes: ["draft", "review"],
              goal: "A draft worth shipping",
              evaluate: "The reviewer ships it",
              stop: { max_attempts: 2, human_stop: "The reviewer stops" },
            },
          ],
          scenarios: [
            {
              id: "expected",
              kind: "expected",
              path: ["draft", "review", "publish"],
              outcome: "Shipped",
            },
            { id: "failure", kind: "failure", path: ["draft"], outcome: "Draft failed" },
            {
              id: "human",
              kind: "human",
              path: ["draft", "review", "draft", "review", "publish"],
              outcome: "Revised once, then shipped",
            },
          ],
        },
      ],
    }
    return `<!doctype html><html><body><a href="#draft">Draft</a><a href="#review">Review</a><a href="#publish">Publish</a><script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify(manifest)}</script><script type="application/derive-facts" data-fact="workflow-definition">${JSON.stringify(definition)}</script></body></html>`
  }

  it("walks the graph as child jobs, waits on the person, loops back, and finishes", async () => {
    const made = await setup("jobs-graph")
    const { app, meta } = made
    const writer = await createAgent(app, { name: "Writer" })
    const publisher = await createAgent(app, { name: "Publisher" })
    const page = (await (
      await publishAs(
        app,
        graphHtml(writer.id, "Publisher"),
        { title: "Ship flow" },
        as(owner.email),
      )
    ).json()) as { short_id: string }
    const graph = await createAgent(app, {
      name: "Ship flow",
      instructions_short_id: page.short_id,
    })
    const deps = graphAware({ meta, blobs: made.ctx.blobs })

    const asked = (await (await ask(app, ed.email, graph.id, "Ship the launch note")).json()) as {
      id: string
      kind: string
    }
    expect(asked.kind).toBe("graph")
    // No runner ever takes the graph itself.
    expect(await pull(app, graph)).toEqual([])
    await graphPass(deps)

    const settle = async (agent: { id: string; token: string }, reply: string) => {
      const [j] = await pull(app, agent)
      if (!j) throw new Error(`nothing for ${agent.id}`)
      const res = await app.request(
        `/v1/jobs/${j.id}/report`,
        jsonAs(bearer(agent.token), {
          started_at: j.started_at,
          status: "succeeded",
          body_md: reply,
        }),
      )
      expect(res.status).toBe(200)
      return j
    }
    const parent = () => meta.getJob(asked.id)
    const answer = (option: string) =>
      app.request(`/v1/jobs/${asked.id}/answer`, jsonAs(as(ed.email), { option }))

    const first = await settle(writer, "Draft one.")
    expect(first).toMatchObject({ kind: "node", node_id: "draft", parent_id: asked.id })
    // The draft settled: the graph now waits on the person with the authored options.
    expect(await parent()).toMatchObject({ status: "needs_you" })
    expect(JSON.parse((await parent())?.needs_json ?? "{}")).toMatchObject({
      kind: "decision",
      question: "Ship it?",
      options: ["ship", "revise"],
    })

    expect((await answer("revise")).status).toBe(200)
    await graphPass(deps)
    await settle(writer, "Draft two.")
    expect((await answer("ship")).status).toBe(200)
    await graphPass(deps)
    await settle(publisher, "Published.")

    const done = await parent()
    expect(done?.status).toBe("succeeded")
    const route = (JSON.parse(done?.result_json ?? "{}") as { route: { node_id: string }[] }).route
    expect(route.map((r) => r.node_id)).toEqual(["draft", "review", "draft", "review", "publish"])
  })

  it("stops at the loop's limit instead of revising forever", async () => {
    const made = await setup("jobs-graph-limit")
    const { app, meta } = made
    const writer = await createAgent(app, { name: "Writer" })
    await createAgent(app, { name: "Publisher" })
    const page = (await (
      await publishAs(
        app,
        graphHtml(writer.id, "Publisher"),
        { title: "Ship flow" },
        as(owner.email),
      )
    ).json()) as { short_id: string }
    const graph = await createAgent(app, { name: "Loop", instructions_short_id: page.short_id })
    const deps = graphAware({ meta, blobs: made.ctx.blobs })
    const asked = (await (await ask(app, ed.email, graph.id, "Go")).json()) as { id: string }
    await graphPass(deps)
    for (let round = 0; round < 3; round++) {
      const [j] = await pull(app, writer)
      if (!j) break
      await app.request(
        `/v1/jobs/${j.id}/report`,
        jsonAs(bearer(writer.token), {
          started_at: j.started_at,
          status: "succeeded",
          body_md: "x",
        }),
      )
      if ((await meta.getJob(asked.id))?.status !== "needs_you") break
      await app.request(`/v1/jobs/${asked.id}/answer`, jsonAs(as(ed.email), { option: "revise" }))
      await graphPass(deps)
    }
    const done = await meta.getJob(asked.id)
    expect(done?.status).toBe("failed")
    const last = (await meta.listJobMessages(asked.id)).at(-1)?.body_md
    expect(last).toMatch(/limit of 2 tries/)
  })
})
