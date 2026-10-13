import { execFile } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { newId } from "@derive/core"
import { sessionApi, sessionCommand } from "@derive-to/cli/sessions"
import { SignJWT } from "jose"
import { describe, expect, it, vi } from "vitest"
import {
  JobClient,
  jobDrainPass,
  loadJobRunnerConfig,
  runOneJob,
  serveJob,
} from "../../../packages/cli/src/job-runner.js"
import type { AppDeps } from "../src/context"
import { purgeUserDataAndSyncSeats } from "../src/lib/account"
import type { ModelTurn } from "../src/lib/agent-loop"
import { signCapabilityToken } from "../src/lib/capability-token"
import { encryptSecret } from "../src/lib/crypto"
import { advanceGraph, graphAware, graphPass } from "../src/lib/job-graph"
import { machineDepsFrom, machinePass } from "../src/lib/job-machine"
import { HELD_FOR_BUDGET, jobTick, OWNER_LEFT } from "../src/lib/jobs"
import { catalogOf } from "../src/lib/model-catalog"
import { as, bearer, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// THE AGENT MODEL, through the surface people and runners use: an agent is created, asked,
// pulled, reported on, followed up, answered, scheduled, paused, and fenced.

const owner: TestUser = { id: "u_job_own", email: "jobown@derive.test", name: "Owner" }
const ed: TestUser = { id: "u_job_ed", email: "jobed@derive.test", name: "Ed" }
const outsider: TestUser = { id: "u_job_out", email: "jobout@derive.test", name: "Outsider" }

type App = ReturnType<typeof makeAuthedApp>["app"]

const setup = async (name: string, deps: Partial<AppDeps> = {}) => {
  const made = makeAuthedApp(name, [owner, ed, outsider], "editor", {
    deps: { encryptionKey: "test-encryption-key", ...deps },
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

  it("a retired work token (dkrun_, dksess_, dkwfr_) resolves to nobody, even when well signed", async () => {
    const { app } = await setup("jobs-retired-tokens")
    const a = await createAgent(app)
    const job = (await (await ask(app, ed.email, a.id, "for a")).json()) as { id: string }
    const exp = Date.now() + 10 * 60_000
    for (const [prefix, domain] of [
      ["dkrun_", "derive-run-token:"],
      ["dksess_", "derive-session-token:"],
      ["dkwfr_", "derive-workflow-token:"],
    ]) {
      // Signed exactly as the retired lanes minted them, with the deployment's own key.
      const token = `${prefix}${await signCapabilityToken(domain ?? "", "test-encryption-key", [job.id, a.id, "default"], exp)}`
      // Anonymous: refused at the door for a write, and nothing to see for a read.
      expect([401, 403]).toContain(
        (await app.request(`/v1/agents/${a.id}/pull`, jsonAs(bearer(token), {}))).status,
      )
      expect([401, 404]).toContain(
        (await app.request(`/v1/jobs/${job.id}`, { headers: bearer(token) })).status,
      )
    }
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

  it("a runner never holds more of an agent's jobs than its concurrency cap", async () => {
    const { app } = await setup("jobs-concurrency")
    const a = await createAgent(app, { max_concurrency: 2 })
    for (const n of [1, 2, 3]) await ask(app, ed.email, a.id, `job ${n}`)
    const first = await pull(app, a)
    expect(first).toHaveLength(2)
    expect(await pull(app, a)).toEqual([])
    const [done] = first
    if (!done) throw new Error("nothing pulled")
    await report(app, a.token, done.id, { started_at: done.started_at, status: "succeeded" })
    // One slot freed: exactly one more job.
    expect(await pull(app, a)).toHaveLength(1)
  })

  it("a workspace whose agent-write switch cannot be read hands a runner nothing", async () => {
    const { app, meta } = await setup("jobs-brake-closed")
    const a = await createAgent(app)
    await ask(app, ed.email, a.id, "while the settings are unreadable")
    const broken = vi.spyOn(meta, "getOrgSettings").mockRejectedValue(new Error("db down"))
    try {
      expect(await pull(app, a)).toEqual([])
    } finally {
      broken.mockRestore()
    }
    expect(await pull(app, a)).toHaveLength(1)
  })

  it("an imported paper's hidden managed agent cannot be asked or mentioned", async () => {
    const { app, meta } = await setup("jobs-managed")
    const hidden = await meta.createAgent({
      id: "ag_paper_hidden",
      org_id: "default",
      name: "arXiv:2401.00001",
      token: "hash_not_handed_out",
      role: "editor",
      created_by: owner.id,
      managed: 1,
    })
    const asked = await ask(app, owner.email, hidden.id, "Do something")
    expect(asked.status).toBe(404)
    expect(await meta.listJobs({ orgId: "default", agentId: hidden.id })).toEqual([])
    const visible = await createAgent(app, { name: "arXiv helper" })
    const dir = (await (
      await app.request("/v1/users?query=arxiv", { headers: as(owner.email) })
    ).json()) as { users: { id: string }[] }
    expect(dir.users.map((u) => u.id)).toContain(visible.id)
    expect(dir.users.map((u) => u.id)).not.toContain(hidden.id)
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

describe("jobs: the agents list the home screen reads", () => {
  it("carries each agent's schedules and when it last had work, and its creator can replace its key", async () => {
    const { app } = await setup("jobs-list-shape")
    const quiet = await createAgent(app)
    const busy = (await (
      await app.request(
        "/v1/agents",
        jsonAs(as(ed.email), {
          name: "Nightly",
          schedule: { cron: "0 3 * * *", instruction: "Tidy" },
        }),
      )
    ).json()) as { id: string }
    await ask(app, ed.email, busy.id, "Now")
    const list = (await (await app.request("/v1/agents", { headers: as(ed.email) })).json()) as {
      agents: { id: string; triggers: { cron: string }[]; last_job_at: string | null }[]
    }
    const byId = new Map(list.agents.map((a) => [a.id, a]))
    expect(byId.get(busy.id)?.triggers.map((t) => t.cron)).toEqual(["0 3 * * *"])
    expect(byId.get(busy.id)?.last_job_at).toBeTruthy()
    expect(byId.get(quiet.id)).toMatchObject({ triggers: [], last_job_at: null })
    // Ed made "Nightly": Ed replaces its key; Ed cannot replace the owner's agent's.
    const mine = await app.request(`/v1/agents/${busy.id}/rotate`, jsonAs(as(ed.email), {}))
    expect(mine.status).toBe(200)
    const theirs = await app.request(`/v1/agents/${quiet.id}/rotate`, jsonAs(as(ed.email), {}))
    expect(theirs.status).toBe(404)
  })

  it("names each agent's instructions page, on the list, an edit, and a key rotation", async () => {
    const { app } = await setup("jobs-list-instructions")
    const page = (await (
      await publishAs(app, "<h1>Brief</h1>", { title: "Brief" }, as(owner.email))
    ).json()) as { short_id: string }
    const briefed = await createAgent(app, { instructions_short_id: page.short_id })
    const bare = await createAgent(app)
    const list = (await (await app.request("/v1/agents", { headers: as(ed.email) })).json()) as {
      agents: { id: string; instructions_short_id: string | null }[]
    }
    const byId = new Map(list.agents.map((a) => [a.id, a]))
    expect(byId.get(briefed.id)?.instructions_short_id).toBe(page.short_id)
    expect(byId.get(bare.id)?.instructions_short_id).toBeNull()
    const edited = (await (
      await app.request(`/v1/agents/${briefed.id}`, {
        ...jsonAs(as(owner.email), { description: "Reads the brief" }),
        method: "PATCH",
      })
    ).json()) as { instructions_short_id: string | null }
    expect(edited).toMatchObject({ instructions_short_id: page.short_id })
    const rotated = (await (
      await app.request(`/v1/agents/${briefed.id}/rotate`, jsonAs(as(owner.email), {}))
    ).json()) as { instructions_short_id: string | null }
    expect(rotated).toMatchObject({ instructions_short_id: page.short_id })
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

  it("an agent's environment names only secrets its creator may give it, and its jobs get the values", async () => {
    const { app } = await setup("jobs-env-bind")
    const secret = async (email: string, value: string) => {
      const res = await app.request(
        "/v1/connections",
        jsonAs(as(email), { kind: "secret", toolkit: "environment", secret: value }),
      )
      expect(res.status).toBe(201)
      return ((await res.json()) as { id: string }).id
    }
    const edsKey = await secret(ed.email, "eds-own-fixture")
    const ownersKey = await secret(owner.email, "reporting-db-fixture")
    // A teammate's personal secret is refused on create and on edit.
    const made = await app.request(
      "/v1/agents",
      jsonAs(as(owner.email), { name: "Reporter", environment: { DB_URL: edsKey } }),
    )
    expect(made.status).toBe(400)
    const agent = await createAgent(app, { environment: { DB_URL: ownersKey } })
    const edit = await app.request(`/v1/agents/${agent.id}`, {
      ...jsonAs(as(owner.email), { environment: { DB_URL: edsKey } }),
      method: "PATCH",
    })
    expect(edit.status).toBe(400)
    const shown = (await (
      await app.request(`/v1/agents/${agent.id}`, { headers: as(owner.email) })
    ).json()) as { environment: Record<string, string> }
    expect(shown.environment).toEqual({ DB_URL: ownersKey })
    expect(JSON.stringify(shown)).not.toContain("reporting-db-fixture")
    // The value only ever leaves through a running job's claim.
    expect((await ask(app, owner.email, agent.id, "report")).status).toBe(201)
    const [job] = await pull(app, agent)
    if (!job) throw new Error("no job pulled")
    const env = await app.request(`/v1/jobs/${job.id}/environment`, {
      headers: { ...bearer(agent.token), "x-derive-claim": job.started_at },
    })
    expect(await env.json()).toEqual({ environment: { DB_URL: "reporting-db-fixture" } })
    const cleared = await app.request(`/v1/agents/${agent.id}`, {
      ...jsonAs(as(owner.email), { environment: {} }),
      method: "PATCH",
    })
    expect(((await cleared.json()) as { environment: Record<string, string> }).environment).toEqual(
      {},
    )
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

  it("the inbox lists the jobs you asked and your agents' jobs, not a teammate's", async () => {
    const { app } = await setup("jobs-mine")
    const ownerAgent = await createAgent(app)
    const edAgent = (await (
      await app.request("/v1/agents", jsonAs(as(ed.email), { name: "Ed's helper" }))
    ).json()) as { id: string }
    const edAsked = (await (await ask(app, ed.email, ownerAgent.id, "Ed asks")).json()) as {
      id: string
    }
    const ownerAsked = (await (
      await ask(app, owner.email, ownerAgent.id, "Owner asks")
    ).json()) as {
      id: string
    }
    const onEds = (await (await ask(app, owner.email, edAgent.id, "On Ed's agent")).json()) as {
      id: string
    }
    const ids = async (email: string) =>
      (
        (await (await app.request("/v1/jobs?mine=1", { headers: as(email) })).json()) as {
          jobs: { id: string }[]
        }
      ).jobs
        .map((j) => j.id)
        .sort()
    // Ed: the job he asked, and the one on the agent he made. Not the owner's own ask.
    expect(await ids(ed.email)).toEqual([edAsked.id, onEds.id].sort())
    // A workspace owner manages every agent, so every job is theirs to act on.
    expect(await ids(owner.email)).toEqual([edAsked.id, ownerAsked.id, onEds.id].sort())
  })

  it("asking about a page needs a page the asker can read, in the agent's workspace", async () => {
    const { app } = await setup("jobs-subject")
    const agent = await createAgent(app)
    const privatePage = (await (
      await publishAs(
        app,
        "# Owner only",
        { workspace_access: "none", link_role: "none" },
        as(owner.email),
      )
    ).json()) as { short_id: string }
    const edsPage = (await (await publishAs(app, "# Ed's page", {}, as(ed.email))).json()) as {
      short_id: string
    }
    const about = (id: string) =>
      ask(app, ed.email, agent.id, "What is missing?", { subject: { kind: "artifact", id } })
    expect((await about(privatePage.short_id)).status).toBe(404)
    expect((await about("nosuchpage")).status).toBe(404)
    const ok = await about(edsPage.short_id)
    expect(ok.status).toBe(201)
    expect(((await ok.json()) as { subject: unknown }).subject).toEqual({
      kind: "artifact",
      id: edsPage.short_id,
    })
  })

  it("a report page finds the job it reports on, and only in its own workspace", async () => {
    const { app } = await setup("jobs-report-lookup")
    const agent = await createAgent(app)
    const job = (await (await ask(app, ed.email, agent.id, "Write it up")).json()) as {
      id: string
    }
    const [p] = await pull(app, agent)
    const page = (await (await publishAs(app, "# Report", {}, bearer(agent.token))).json()) as {
      short_id: string
    }
    const settled = await report(app, agent.token, job.id, {
      started_at: p?.started_at ?? null,
      status: "succeeded",
      report_short_id: page.short_id,
    })
    expect(settled.status).toBe(200)
    const found = (await (
      await app.request(`/v1/jobs?report=${page.short_id}`, { headers: as(ed.email) })
    ).json()) as { jobs: { id: string; report_short_id: string }[] }
    expect(found.jobs.map((j) => j.id)).toEqual([job.id])
    expect(found.jobs[0]?.report_short_id).toBe(page.short_id)
    const other = (await (await publishAs(app, "# Not a report", {}, as(ed.email))).json()) as {
      short_id: string
    }
    const none = (await (
      await app.request(`/v1/jobs?report=${other.short_id}`, { headers: as(ed.email) })
    ).json()) as { jobs: unknown[] }
    expect(none.jobs).toEqual([])
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

describe("jobs: interrupted native saves", () => {
  it("refuses retry when the commit result is unknown", async () => {
    const { app, meta } = await setup("jobs-unknown-save")
    const job = await meta.createJob({
      id: newId("job"),
      org_id: "default",
      agent_id: "derive",
      kind: "ask",
      instruction: "Save a plan",
      asked_by: ed.id,
      attended: 1,
      meta_json: JSON.stringify({ via: "chat", saving: true }),
    })
    await meta.updateJob(job.id, { status: "lost" })
    const response = await app.request(`/v1/jobs/${job.id}/retry`, jsonAs(as(ed.email), {}))
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("save was interrupted")
    expect((await meta.getJob(job.id))?.status).toBe("lost")
    expect(await meta.listJobMessages(job.id)).toHaveLength(0)
  })
})

describe("jobs: the built-in Derive, asked from a page", () => {
  /** A model that reads the page the prompt names, then answers from what the read returned. */
  const pageReader = () =>
    catalogOf([
      {
        id: "m1",
        label: "M1",
        isDefault: true,
        build:
          () =>
          async (input: {
            system: string
            messages: { role: string; content: unknown }[]
          }): Promise<ModelTurn> => {
            const last = input.messages.at(-1)?.content
            if (input.messages.at(-1)?.role === "tool")
              return {
                text: JSON.stringify(last).includes("billed annually")
                  ? "It says seats are billed annually."
                  : "I could not read it.",
                toolUses: [],
                costUsd: 0.001,
              }
            const shortId = /Scope: artifact (\w+),/.exec(input.system)?.[1] ?? ""
            return {
              text: "",
              toolUses: [{ id: "t1", name: "read", input: { short_id: shortId } }],
              costUsd: 0.001,
            }
          },
      },
    ])

  it("answers on a job only the asker sees, about the page, and a follow-up is another turn on it", async () => {
    const { app } = await setup("jobs-derive-page", { models: pageReader() })
    const ws = (await (await app.request("/v1/workspace", { headers: as(ed.email) })).json()) as {
      assistant: boolean
    }
    expect(ws.assistant).toBe(true)
    const page = (await (
      await publishAs(app, "# Pricing\n\nSeats are billed annually.", {}, as(owner.email))
    ).json()) as { short_id: string }

    const res = await ask(app, ed.email, "derive", "What does this say about seats?", {
      subject: { kind: "artifact", id: page.short_id },
    })
    expect(res.status).toBe(201)
    const job = (await res.json()) as { id: string; agent_id: string; subject: unknown }
    expect(job.agent_id).toBe("derive")
    expect(job.subject).toEqual({ kind: "artifact", id: page.short_id })

    const read = (who: string) => app.request(`/v1/jobs/${job.id}`, { headers: as(who) })
    const mine = (await (await read(ed.email)).json()) as {
      status: string
      cost_micro_usd: number | null
      messages: { author_kind: string; body_md: string }[]
    }
    expect(mine.status).toBe("succeeded")
    expect(mine.cost_micro_usd).toBeGreaterThan(0)
    expect(mine.messages.map((m) => [m.author_kind, m.body_md])).toEqual([
      ["asker", "What does this say about seats?"],
      ["agent", "It says seats are billed annually."],
    ])
    // Read with the asker's permissions, so nobody else sees it, the workspace owner included.
    expect((await read(owner.email)).status).toBe(404)
    const listed = (await (await app.request("/v1/jobs", { headers: as(owner.email) })).json()) as {
      jobs: { id: string }[]
    }
    expect(listed.jobs.map((j) => j.id)).not.toContain(job.id)

    // A follow-up runs another turn on the same job; a teammate cannot write to it.
    const follow = (who: string) =>
      app.request(`/v1/jobs/${job.id}/messages`, jsonAs(as(who), { body_md: "And monthly?" }))
    expect((await follow(owner.email)).status).toBe(404)
    expect((await follow(ed.email)).status).toBe(200)
    const after = (await (await read(ed.email)).json()) as {
      status: string
      messages: { author_kind: string; body_md: string }[]
    }
    expect(after.status).toBe("succeeded")
    expect(after.messages.map((m) => m.author_kind)).toEqual(["asker", "agent", "asker", "agent"])
  })

  it("a page ask that publishes links the version it made, and a page's asks list by subject", async () => {
    // Revises the page the prompt names, then says so.
    const reviser = catalogOf([
      {
        id: "m1",
        label: "M1",
        isDefault: true,
        build:
          () =>
          async (input: { system: string; messages: unknown[] }): Promise<ModelTurn> => {
            if (input.messages.length > 1)
              return { text: "Added an owner.", toolUses: [], costUsd: 0.001 }
            const shortId = /Scope: artifact (\w+),/.exec(input.system)?.[1] ?? ""
            return {
              text: "",
              toolUses: [
                {
                  id: "t1",
                  name: "publish",
                  input: { short_id: shortId, base_version: 1, content: "# Plan\n\nOwner: Ed." },
                },
              ],
              costUsd: 0.001,
            }
          },
      },
    ])
    const { app } = await setup("jobs-derive-publish", { models: reviser })
    const page = (await (await publishAs(app, "# Plan", {}, as(ed.email))).json()) as {
      short_id: string
    }
    const other = (await (await publishAs(app, "# Other", {}, as(ed.email))).json()) as {
      short_id: string
    }
    const job = (await (
      await ask(app, ed.email, "derive", "Give it an owner", {
        subject: { kind: "artifact", id: page.short_id },
      })
    ).json()) as { id: string }
    const done = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
    ).json()) as { status: string; result: { effects?: unknown[] } }
    expect(done.status).toBe("succeeded")
    expect(done.result.effects).toEqual([
      expect.objectContaining({ kind: "page", ref: page.short_id, version: 2 }),
    ])

    // The asker finds the page's conversation by its subject; nobody else does.
    const about = async (who: string, shortId: string, limit = 50) =>
      (
        (await (
          await app.request(`/v1/jobs?subject=${shortId}&limit=${limit}`, { headers: as(who) })
        ).json()) as { jobs: { id: string; asked_by: string }[] }
      ).jobs
    expect((await about(ed.email, page.short_id)).map((j) => j.id)).toEqual([job.id])
    expect(await about(ed.email, other.short_id)).toEqual([])
    expect(await about(owner.email, page.short_id)).toEqual([])

    // The subject lists the caller's own asks only, so a busy page cannot crowd yours out:
    // the owner (who manages every agent) asks a workspace agent about it many times, and the
    // newest of Ed's own is still the one he gets back, while the owner never gets Ed's.
    const agent = await createAgent(app)
    for (let i = 0; i < 21; i++)
      expect(
        (
          await ask(app, owner.email, agent.id, `Check ${i}`, {
            subject: { kind: "artifact", id: page.short_id },
          })
        ).status,
      ).toBe(201)
    expect((await about(ed.email, page.short_id, 1)).map((j) => j.id)).toEqual([job.id])
    const owners = await about(owner.email, page.short_id)
    expect(owners).toHaveLength(21)
    expect(owners.every((j) => j.asked_by === owner.id)).toBe(true)
  })

  it("is not found for a page the asker cannot read, and refuses plainly with no model", async () => {
    const { app } = await setup("jobs-derive-private", { models: pageReader() })
    const privatePage = (await (
      await publishAs(
        app,
        "# Owner only",
        { workspace_access: "none", link_role: "none" },
        as(owner.email),
      )
    ).json()) as { short_id: string }
    const about = (id: string) =>
      ask(app, ed.email, "derive", "Summarize it", { subject: { kind: "artifact", id } })
    expect((await about(privatePage.short_id)).status).toBe(404)
    expect((await about("nosuchpage")).status).toBe(404)
    expect((await ask(app, ed.email, "derive", "Summarize it")).status).toBe(201)
    const jobs = (await (await app.request("/v1/jobs", { headers: as(ed.email) })).json()) as {
      jobs: unknown[]
    }
    expect(jobs.jobs).toHaveLength(1)

    const bare = await setup("jobs-derive-no-model")
    const edsPage = (await (await publishAs(bare.app, "# Ed's", {}, as(ed.email))).json()) as {
      short_id: string
    }
    const ws = (await (
      await bare.app.request("/v1/workspace", { headers: as(ed.email) })
    ).json()) as { assistant: boolean }
    expect(ws.assistant).toBe(false)
    const refused = await ask(bare.app, ed.email, "derive", "Summarize it", {
      subject: { kind: "artifact", id: edsPage.short_id },
    })
    expect(refused.status).toBe(503)
    expect(((await refused.json()) as { error: string }).error).toMatch(/No model is configured/)
  })

  it("is asked by a person, not an agent's token, and a follow-up needs the page still readable", async () => {
    const { app } = await setup("jobs-derive-who", { models: pageReader() })
    // Ed's own agent: its token acts for Ed, the asker, so only the token check refuses it.
    const made = await app.request(
      "/v1/agents",
      jsonAs(as(ed.email), { name: "Ed's helper", role: "editor" }),
    )
    expect(made.status).toBe(201)
    const agent = (await made.json()) as { id: string; token: string }
    const page = (await (
      await publishAs(app, "# Pricing\n\nSeats are billed annually.", {}, as(owner.email))
    ).json()) as { short_id: string }
    const subject = { kind: "artifact", id: page.short_id }
    const byToken = await app.request(
      "/v1/jobs",
      jsonAs(bearer(agent.token), { agent_id: "derive", instruction: "Summarize", subject }),
    )
    expect(byToken.status).toBe(404)

    const job = (await (
      await ask(app, ed.email, "derive", "What about seats?", { subject })
    ).json()) as { id: string }
    const write = (headers: Record<string, string>) =>
      app.request(`/v1/jobs/${job.id}/messages`, jsonAs(headers, { body_md: "And monthly?" }))
    expect((await write(bearer(agent.token))).status).toBe(404)

    // The owner locks the page away from the workspace: Ed's follow-up is not read on his behalf.
    const locked = await app.request(
      `/v1/artifacts/${page.short_id}/access`,
      jsonAs(as(owner.email), { workspaceAccess: "none", linkRole: "none" }, "PATCH"),
    )
    expect(locked.status).toBe(200)
    expect((await write(as(ed.email))).status).toBe(404)
    const after = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
    ).json()) as { messages: unknown[] }
    expect(after.messages).toHaveLength(2)
  })

  it("a follow-up waits for the running turn, and a turn past its budget settles failed and says so", async () => {
    // A model that holds its first answer until the test lets it go.
    let release: () => void = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    const slow = catalogOf([
      {
        id: "m1",
        label: "M1",
        isDefault: true,
        build: () => async (): Promise<ModelTurn> => {
          await held
          return { text: "Done.", toolUses: [], costUsd: 0.001 }
        },
      },
    ])
    // Served after the response, as the deploys do, so the test can act while the turn runs.
    const { app } = await setup("jobs-derive-running", { models: slow, detachAfterResponse: true })
    const page = (await (await publishAs(app, "# Plan", {}, as(ed.email))).json()) as {
      short_id: string
    }
    const job = (await (
      await ask(app, ed.email, "derive", "What is missing?", {
        subject: { kind: "artifact", id: page.short_id },
      })
    ).json()) as { id: string; status: string }
    expect(job.status).toBe("running")
    const again = await app.request(
      `/v1/jobs/${job.id}/messages`,
      jsonAs(as(ed.email), { body_md: "Also this?" }),
    )
    expect(again.status).toBe(409)
    release()
    await vi.waitFor(async () => {
      const now = (await (
        await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
      ).json()) as { status: string }
      expect(now.status).toBe("succeeded")
    })

    // Reads the page (a call that comes back and costs), then never answers the second call.
    const stalls = catalogOf([
      {
        id: "m1",
        label: "M1",
        isDefault: true,
        build:
          () =>
          async (input: { system: string; messages: unknown[] }): Promise<ModelTurn> => {
            if (input.messages.length > 1) return new Promise<ModelTurn>(() => {})
            const shortId = /Scope: artifact (\w+),/.exec(input.system)?.[1] ?? ""
            return {
              text: "",
              toolUses: [{ id: "t1", name: "read", input: { short_id: shortId } }],
              costUsd: 0.002,
            }
          },
      },
    ])
    const budgeted = await setup("jobs-derive-budget", {
      models: stalls,
      attendedTurnBudgetMs: 50,
    })
    const plan = (await (await publishAs(budgeted.app, "# Plan", {}, as(ed.email))).json()) as {
      short_id: string
    }
    const late = (await (
      await ask(budgeted.app, ed.email, "derive", "Read all of it", {
        subject: { kind: "artifact", id: plan.short_id },
      })
    ).json()) as { id: string }
    const settled = (await (
      await budgeted.app.request(`/v1/jobs/${late.id}`, { headers: as(ed.email) })
    ).json()) as {
      status: string
      cost_micro_usd: number | null
      messages: { author_kind: string; body_md: string }[]
    }
    expect(settled.status).toBe("failed")
    expect(settled.cost_micro_usd).toBeGreaterThan(0)
    expect(settled.messages.at(-1)?.body_md).toMatch(/took too long to answer in one go/)
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

  it("a schedule that asks again closes its earlier unanswered ask and counts the asks", async () => {
    const { app, meta } = await setup("jobs-supersede")
    const created = await app.request(
      "/v1/agents",
      jsonAs(as(owner.email), {
        name: "Sweep",
        role: "editor",
        schedule: { cron: "0 9 * * *", tz: "UTC", instruction: "Sweep and ask before any ban" },
      }),
    )
    const a = (await created.json()) as { id: string; token: string }
    // A runner claims a window only once it has arrived, so the clock moves with the mornings.
    const day = new Date(Date.now() + 2 * 86_400_000)
    const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 9, 30))
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(at)
      await jobTick({ meta }, at)
      const [first] = await pull(app, a)
      await report(app, a.token, first?.id ?? "", {
        started_at: first?.started_at ?? null,
        status: "needs_you",
        needs: { kind: "escalation", question: "Ban R?", options: ["Ban", "Clear"] },
      })
      // The next morning runs even though yesterday's question is open, and asks again.
      const next = new Date(at.getTime() + 86_400_000)
      vi.setSystemTime(next)
      await jobTick({ meta }, next)
      const [second] = await pull(app, a)
      expect(second?.id).toBeTruthy()
      expect(second?.id).not.toBe(first?.id)
      await report(app, a.token, second?.id ?? "", {
        started_at: second?.started_at ?? null,
        status: "needs_you",
        needs: { kind: "escalation", question: "Ban R? (again)", options: ["Ban", "Clear"] },
      })
      const jobs = (await (
        await app.request(`/v1/jobs?agent=${a.id}`, { headers: as(owner.email) })
      ).json()) as {
        jobs: {
          id: string
          status: string
          needs: { asked_times?: number; first_asked_at?: string } | null
          result: { superseded_by?: string }
        }[]
      }
      const open = jobs.jobs.filter((j) => j.status === "needs_you")
      expect(open.map((j) => j.id)).toEqual([second?.id])
      expect(open[0]?.needs?.asked_times).toBe(2)
      expect(open[0]?.needs?.first_asked_at).toBeTruthy()
      const closed = jobs.jobs.find((j) => j.id === first?.id)
      expect(closed).toMatchObject({ status: "cancelled", result: { superseded_by: second?.id } })
      // A run that fails with only a message still leaves its reason on the row.
      const answered = await app.request(
        `/v1/jobs/${second?.id}/answer`,
        jsonAs(as(owner.email), { option: "Clear" }),
      )
      expect(answered.status).toBe(200)
      const [third] = await pull(app, a)
      await report(app, a.token, third?.id ?? "", {
        started_at: third?.started_at ?? null,
        status: "failed",
        body_md: "The machine for this job failed to start.\nDetails follow.",
        retryable: false,
      })
      const failed = (await (
        await app.request(`/v1/jobs/${third?.id}`, { headers: as(owner.email) })
      ).json()) as { result: { failure?: { reason: string } } }
      expect(failed.result.failure?.reason).toBe("The machine for this job failed to start.")
    } finally {
      vi.useRealTimers()
    }
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

  it("a job whose lease lapses on every one of its three attempts is lost, not retried again", async () => {
    const { app, meta } = await setup("jobs-lost")
    const a = await createAgent(app)
    const job = (await (await ask(app, ed.email, a.id, "flaky")).json()) as { id: string }
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await pull(app, a))[0]?.id).toBe(job.id)
      await jobTick({ meta }, new Date(Date.now() + 2 * 60 * 60_000))
    }
    const lost = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
    ).json()) as { status: string; finished_at: string | null }
    expect(lost.status).toBe("lost")
    expect(lost.finished_at).toBeTruthy()
    expect(await pull(app, a)).toEqual([])
  })
})

describe("jobs: telling people", () => {
  type Bell = { kind: string; preview: string; thread_id: string; comment_id: string }
  const bells = async (app: App, email: string) =>
    (
      (await (await app.request("/v1/notifications", { headers: as(email) })).json()) as {
        notifications: Bell[]
      }
    ).notifications.filter((n) => n.kind === "job")
  const outbox = async (meta: ReturnType<typeof makeAuthedApp>["meta"]) => {
    const far = new Date(Date.now() + 10_000_000).toISOString()
    return meta.claimDueDeliveries(far, 200, far)
  }

  it("needs_you tells the asker and the agent's manager once, by bell, email and webhook", async () => {
    const { app, meta } = await setup("jobs-tell-needs")
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      emailNotifications: true,
    })
    await meta.setUserNotificationPref({
      id: "unp-jobs-tell-ed",
      org_id: "default",
      user_id: ed.id,
      prefs: JSON.stringify({ reviewEmail: true }),
      created_at: new Date().toISOString(),
    })
    await meta.createWebhook({
      id: "wh_jobs_tell",
      org_id: "default",
      url: "http://example.com/hook",
      secret: "s",
      kind: "generic",
      events: "job.needs_you,job.finished",
    })
    // A hook on every event predates job events: it does not start receiving them.
    await meta.createWebhook({
      id: "wh_jobs_star",
      org_id: "default",
      url: "http://example.com/all",
      secret: "s",
      kind: "generic",
      events: "*",
    })
    const a = await createAgent(app)
    const job = (await (await ask(app, ed.email, a.id, "Send the update")).json()) as {
      id: string
    }
    const [p] = await pull(app, a)
    const waits = {
      started_at: p?.started_at ?? null,
      status: "needs_you",
      needs: { kind: "effect", question: "Send to 14 people?", options: ["Send", "Skip"] },
    }
    expect((await report(app, a.token, job.id, waits)).status).toBe(200)
    // Sent again, the settle lands nowhere and tells nobody twice.
    expect((await report(app, a.token, job.id, waits)).status).toBe(409)
    for (const who of [ed, owner]) {
      const mine = await bells(app, who.email)
      expect(mine).toHaveLength(1)
      expect(mine[0]).toMatchObject({ thread_id: a.id, comment_id: job.id })
      expect(mine[0]?.preview).toContain("Send to 14 people?")
    }
    const sent = await outbox(meta)
    // Email only for the person who opted in; one webhook delivery for the workspace.
    expect(sent.filter((d) => d.kind === "email" && d.event_type === "job.needs_you")).toHaveLength(
      1,
    )
    const hooks = sent.filter((d) => d.webhook_id === "wh_jobs_tell")
    expect(hooks.map((d) => d.event_type)).toEqual(["job.needs_you"])
    expect(sent.filter((d) => d.webhook_id === "wh_jobs_star")).toEqual([])
    expect(JSON.parse(hooks[0]?.payload ?? "{}")).toMatchObject({
      event: "job.needs_you",
      job: { id: job.id, status: "needs_you", question: "Send to 14 people?" },
    })
  })

  it("finished tells the asker once, even across a retry, and not the manager", async () => {
    const { app } = await setup("jobs-tell-finished")
    const a = await createAgent(app)
    const job = (await (await ask(app, ed.email, a.id, "flaky")).json()) as { id: string }
    const [p1] = await pull(app, a)
    await report(app, a.token, job.id, {
      started_at: p1?.started_at ?? null,
      status: "failed",
      retryable: true,
    })
    // Back in the queue for another attempt: not finished, so nobody is told.
    expect(await bells(app, ed.email)).toHaveLength(0)
    const [p2] = await pull(app, a)
    const done = { started_at: p2?.started_at ?? null, status: "succeeded", body_md: "Done." }
    expect((await report(app, a.token, job.id, done)).status).toBe(200)
    expect((await report(app, a.token, job.id, done)).status).toBe(409)
    const mine = await bells(app, ed.email)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.preview).toContain("finished")
    expect(await bells(app, owner.email)).toHaveLength(0)
    // Cancelling your own job tells you nothing.
    const other = (await (await ask(app, ed.email, a.id, "never mind")).json()) as { id: string }
    await app.request(`/v1/jobs/${other.id}/cancel`, jsonAs(as(ed.email), {}))
    expect(await bells(app, ed.email)).toHaveLength(1)
  })

  it("a scheduled job, which nobody asked, tells the agent's creator", async () => {
    const { app, meta } = await setup("jobs-tell-scheduled")
    const created = await app.request(
      "/v1/agents",
      jsonAs(as(owner.email), {
        name: "Weekly digest",
        role: "editor",
        schedule: { cron: "0 9 * * *", tz: "UTC", instruction: "Write the weekly digest" },
      }),
    )
    const a = (await created.json()) as { id: string; token: string }
    const day = new Date(Date.now() + 2 * 86_400_000)
    const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 9, 30))
    await jobTick({ meta }, at)
    const [job] = await meta.listJobs({ orgId: "default", agentId: a.id })
    if (!job) throw new Error("no scheduled job")
    const claimed = await meta.claimJob(
      job.id,
      new Date(Date.now() + 60_000).toISOString(),
      new Date().toISOString(),
    )
    expect(
      (
        await report(app, a.token, job.id, {
          started_at: claimed?.started_at ?? null,
          status: "succeeded",
        })
      ).status,
    ).toBe(200)
    expect(await bells(app, owner.email)).toHaveLength(1)
    expect(await bells(app, ed.email)).toHaveLength(0)
  })

  it("interrupts are for asked work, and a burst on one agent is one message", async () => {
    const { app, meta } = await setup("jobs-tell-interrupts")
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      emailNotifications: true,
    })
    for (const u of [owner, ed])
      await meta.setUserNotificationPref({
        id: `unp-jobs-int-${u.id}`,
        org_id: "default",
        user_id: u.id,
        prefs: JSON.stringify({ reviewEmail: true }),
        created_at: new Date().toISOString(),
      })
    const a = await createAgent(app)
    // Three of Ed's asks fail in one pass: three bells, one email.
    const ids: string[] = []
    for (const n of [1, 2, 3])
      ids.push(((await (await ask(app, ed.email, a.id, `job ${n}`)).json()) as { id: string }).id)
    for (const id of ids) {
      const claimed = await meta.claimJob(
        id,
        new Date(Date.now() + 60_000).toISOString(),
        new Date().toISOString(),
      )
      await report(app, a.token, id, { started_at: claimed?.started_at ?? null, status: "failed" })
    }
    expect(await bells(app, ed.email)).toHaveLength(3)

    // A schedule's routine result rings its creator's bell and sends nothing louder.
    const job = await meta.createJob({
      id: newId("job"),
      org_id: "default",
      agent_id: a.id,
      kind: "scheduled",
      instruction: "nightly",
    })
    const claimed = await meta.claimJob(
      job.id,
      new Date(Date.now() + 60_000).toISOString(),
      new Date().toISOString(),
    )
    await report(app, a.token, job.id, {
      started_at: claimed?.started_at ?? null,
      status: "succeeded",
    })
    expect(await bells(app, owner.email)).toHaveLength(1)
    // One email in all: Ed's, for the burst. None for the schedule's owner.
    const emails = (await outbox(meta)).filter((d) => d.kind === "email")
    expect(emails.map((d) => JSON.parse(d.payload).to)).toEqual([ed.email])
  })

  it("every question is its own email, even two from one agent in the same minute", async () => {
    const { app, meta } = await setup("jobs-tell-questions")
    await meta.setOrgSettings("default", {
      ...(await meta.getOrgSettings("default")),
      emailNotifications: true,
    })
    await meta.setUserNotificationPref({
      id: "unp-jobs-q-ed",
      org_id: "default",
      user_id: ed.id,
      prefs: JSON.stringify({ reviewEmail: true }),
      created_at: new Date().toISOString(),
    })
    const a = await createAgent(app)
    const asked = async (instruction: string) =>
      ((await (await ask(app, ed.email, a.id, instruction)).json()) as { id: string }).id
    const waits = async (id: string, question: string) => {
      const claimed = await meta.claimJob(
        id,
        new Date(Date.now() + 60_000).toISOString(),
        new Date().toISOString(),
      )
      await report(app, a.token, id, {
        started_at: claimed?.started_at ?? null,
        status: "needs_you",
        needs: { kind: "decision", question },
      })
    }
    const first = await asked("Pick a plan")
    await waits(first, "Monthly or yearly?")
    await waits(await asked("Pick a region"), "EU or US?")
    // Answered, it asks again: a new question, so a new email too.
    await app.request(`/v1/jobs/${first}/answer`, jsonAs(as(ed.email), { text: "Monthly" }))
    await waits(first, "Which card?")
    const emails = (await outbox(meta)).filter(
      (d) => d.kind === "email" && d.event_type === "job.needs_you",
    )
    expect(emails.map((d) => JSON.parse(d.payload).text.split("\n")[2])).toEqual(
      expect.arrayContaining(["Monthly or yearly?", "EU or US?", "Which card?"]),
    )
    expect(emails).toHaveLength(3)
  })

  it("a graph's step that needs a person tells the graph's asker and manager", async () => {
    const { app, meta } = await setup("jobs-tell-step")
    const graphAgent = await createAgent(app)
    const stepAgent = await createAgent(app)
    const graph = await meta.createJob({
      id: newId("job"),
      org_id: "default",
      agent_id: graphAgent.id,
      kind: "graph",
      instruction: "Ship the release",
      asked_by: ed.id,
    })
    const step = await meta.createJob({
      id: newId("job"),
      org_id: "default",
      agent_id: stepAgent.id,
      kind: "node",
      instruction: "Check the changelog",
      asked_by: ed.id,
      parent_id: graph.id,
      node_id: "check",
    })
    const [p] = await pull(app, stepAgent)
    expect(p?.id).toBe(step.id)
    await report(app, stepAgent.token, step.id, {
      started_at: p?.started_at ?? null,
      status: "needs_you",
      needs: { kind: "decision", question: "Include the beta notes?" },
    })
    for (const who of [ed, owner]) {
      const mine = (await bells(app, who.email)).filter((b) => b.preview.startsWith("needs you"))
      expect(mine).toHaveLength(1)
      expect(mine[0]).toMatchObject({ thread_id: graphAgent.id, comment_id: graph.id })
      expect(mine[0]?.preview).toContain("Include the beta notes?")
    }
  })

  it("needs_you tells the agent's creator only while they may still manage it", async () => {
    const { app, meta } = await setup("jobs-tell-demoted")
    const made = await app.request("/v1/agents", jsonAs(as(ed.email), { name: "Ed's helper" }))
    expect(made.status).toBe(201)
    const a = (await made.json()) as { id: string; token: string }
    const seat = await meta.getMembership("default", ed.id)
    if (!seat) throw new Error("no seat")
    await meta.setMembership({ id: seat.id, org_id: "default", user_id: ed.id, role: "viewer" })
    const job = (await (await ask(app, owner.email, a.id, "Which one?")).json()) as { id: string }
    const [p] = await pull(app, a)
    await report(app, a.token, job.id, {
      started_at: p?.started_at ?? null,
      status: "needs_you",
      needs: { kind: "decision", question: "Left or right?" },
    })
    expect(await bells(app, owner.email)).toHaveLength(1)
    expect(await bells(app, ed.email)).toHaveLength(0)
  })

  it("a report page a runner attaches becomes private to the workspace", async () => {
    const { app, meta } = await setup("jobs-tell-report-private")
    const a = await createAgent(app)
    const job = (await (await ask(app, ed.email, a.id, "Write it up")).json()) as { id: string }
    const [p] = await pull(app, a)
    // An older runner publishes with the workspace's defaults, or wider.
    const page = (await (
      await publishAs(app, "# Report", { link_role: "viewer" }, bearer(a.token))
    ).json()) as { short_id: string }
    await report(app, a.token, job.id, {
      started_at: p?.started_at ?? null,
      status: "succeeded",
      report_short_id: page.short_id,
    })
    expect(await meta.getByShortId(page.short_id)).toMatchObject({
      workspace_access: "member",
      link_role: "none",
      listed: "none",
    })
  })

  it("the boot payload carries how many jobs wait on you", async () => {
    const { app } = await setup("jobs-tell-boot")
    const a = await createAgent(app)
    const count = async (email: string) =>
      (
        (await (await app.request("/v1/bootstrap", { headers: as(email) })).json()) as {
          needs_you: number
        }
      ).needs_you
    const job = (await (await ask(app, ed.email, a.id, "Which plan?")).json()) as { id: string }
    expect(await count(ed.email)).toBe(0)
    const [p] = await pull(app, a)
    await report(app, a.token, job.id, {
      started_at: p?.started_at ?? null,
      status: "needs_you",
      needs: { kind: "decision", question: "Monthly or yearly?" },
    })
    // The asker, and the owner who manages every agent.
    expect(await count(ed.email)).toBe(1)
    expect(await count(owner.email)).toBe(1)
    await app.request(`/v1/jobs/${job.id}/answer`, jsonAs(as(ed.email), { text: "Monthly" }))
    expect(await count(ed.email)).toBe(0)
  })
})

describe("jobs: the monthly model budget", () => {
  const limitTo = (meta: ReturnType<typeof makeAuthedApp>["meta"], monthlyMicroUsd: number) =>
    meta.createPlan({
      id: newId("plan"),
      org_id: "default",
      user_id: null,
      kind: "model",
      provider: "anthropic",
      secret_enc: "enc",
      limits: JSON.stringify({ monthlyMicroUsd }),
    })

  const lastMessage = async (meta: ReturnType<typeof makeAuthedApp>["meta"], id: string) =>
    (await meta.listJobMessages(id)).at(-1)?.body_md

  it("a workspace past its month refuses new work, and held work says why and waits", async () => {
    const { app, meta } = await setup("jobs-budget")
    const a = await createAgent(app, { schedule: { cron: "* * * * *", instruction: "Tick" } })
    const done = (await (await ask(app, ed.email, a.id, "before the limit")).json()) as {
      id: string
    }
    const [p] = await pull(app, a)
    await report(app, a.token, done.id, { started_at: p?.started_at, status: "succeeded" })
    await meta.addJobCost(done.id, 5_000)
    const waiting = (await (await ask(app, ed.email, a.id, "queued before the limit")).json()) as {
      id: string
    }
    const plan = await limitTo(meta, 1_000)

    const refused = await ask(app, ed.email, a.id, "after the limit")
    expect(refused.status).toBe(402)
    expect(((await refused.json()) as { error: string }).error).toMatch(/monthly model budget/)
    // A follow-up that would reopen a settled job is new work too.
    const followUp = await app.request(
      `/v1/jobs/${done.id}/messages`,
      jsonAs(as(ed.email), { body_md: "one more thing" }),
    )
    expect(followUp.status).toBe(402)
    // The queued job waits rather than running, and says so once however often it is pulled.
    expect(await pull(app, a)).toEqual([])
    expect(await pull(app, a)).toEqual([])
    expect(await lastMessage(meta, waiting.id)).toBe(HELD_FOR_BUDGET)
    expect(
      (await meta.listJobMessages(waiting.id)).filter((m) => m.body_md === HELD_FOR_BUDGET),
    ).toHaveLength(1)
    // A schedule window opens its job, held and saying so.
    const later = new Date(Date.now() + 2 * 60_000)
    expect((await jobTick({ meta }, later)).materialized).toBe(1)
    const [scheduled] = await meta.listJobs({
      orgId: "default",
      agentId: a.id,
      kind: ["scheduled"],
    })
    expect(scheduled?.status).toBe("queued")
    expect(await lastMessage(meta, scheduled?.id ?? "")).toBe(HELD_FOR_BUDGET)

    await meta.deletePlan(plan.id, "default")
    const [resumed] = await pull(app, a)
    expect(resumed?.id).toBe(waiting.id)
    // The note was for the people watching; the runner's transcript is only what was said.
    const said = (resumed?.messages as { body_md: string }[]).map((m) => m.body_md)
    expect(said).toEqual(["queued before the limit"])
  })

  it("a personal limit counts only the spend that bills that person", async () => {
    const { app, meta } = await setup("jobs-budget-personal")
    const owners = await createAgent(app)
    const edsAgent = (await (
      await app.request("/v1/agents", jsonAs(as(ed.email), { name: "Ed's own" }))
    ).json()) as { id: string }
    // The owner's agent spent well past what Ed allows himself.
    const big = (await (await ask(app, ed.email, owners.id, "big")).json()) as { id: string }
    await meta.addJobCost(big.id, 50_000)
    await meta.createPlan({
      id: newId("plan"),
      org_id: "default",
      user_id: ed.id,
      kind: "model",
      provider: "anthropic",
      secret_enc: "enc",
      limits: JSON.stringify({ monthlyMicroUsd: 1_000 }),
    })
    // Ed's own agent bills Ed: none of that spend was his.
    const mine = await ask(app, ed.email, edsAgent.id, "mine")
    expect(mine.status).toBe(201)
    await meta.addJobCost(((await mine.json()) as { id: string }).id, 2_000)
    // Now his own is spent; the owner's agent bills the owner, who has no limit.
    expect((await ask(app, ed.email, edsAgent.id, "again")).status).toBe(402)
    expect((await ask(app, ed.email, owners.id, "theirs")).status).toBe(201)
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

  it("a Claude token runs as what its prefix says it is, whichever kind was picked", async () => {
    const { app, meta } = await setup("jobs-accounts-kind")
    // A setup token pasted under "API key" is stored as the OAuth token it is.
    const pasted = (await (
      await app.request(
        "/v1/accounts",
        jsonAs(as(owner.email), {
          provider: "claude",
          kind: "api_key",
          secret: "sk-ant-oat01-setup-fixture",
        }),
      )
    ).json()) as { id: string; kind: string }
    expect(pasted.kind).toBe("oauth")
    await app.request(`/v1/accounts/${pasted.id}`, { method: "DELETE", headers: as(owner.email) })

    // One saved before that, under the wrong kind, reaches the runner as OAuth and is fixed.
    const stale = await meta.createAccount({
      id: newId("acct"),
      org_id: "default",
      user_id: owner.id,
      provider: "claude",
      kind: "api_key",
      secret_enc: encryptSecret("sk-ant-oat01-stale-fixture", "test-encryption-key"),
    })
    const a = await createAgent(app)
    expect((await ask(app, owner.email, a.id, "run")).status).toBe(201)
    const [job] = await pull(app, a)
    if (!job) throw new Error("no job pulled")
    const cred = await (
      await app.request(`/v1/jobs/${job.id}/account?claim=${encodeURIComponent(job.started_at)}`, {
        headers: bearer(a.token),
      })
    ).json()
    expect(cred).toMatchObject({
      credential: { kind: "oauth", value: "sk-ant-oat01-stale-fixture" },
    })
    expect((await meta.getAccount(stale.id))?.kind).toBe("oauth")
  })

  it("an account carries the name its owner gives it, and only they (or an owner, for a shared one) rename it", async () => {
    const { app } = await setup("jobs-accounts-names")
    const add = async (who: string, body: Record<string, unknown>) =>
      (await (
        await app.request(
          "/v1/accounts",
          jsonAs(as(who), { provider: "claude", kind: "oauth", ...body }),
        )
      ).json()) as { id: string; name: string | null }
    const rename = (who: string, id: string, name: string | null) =>
      app.request(`/v1/accounts/${id}`, { ...jsonAs(as(who), { name }), method: "PATCH" })
    const work = await add(ed.email, { secret: "sk-ant-oat-work-1111", name: "  Work Max  " })
    expect(work.name).toBe("Work Max")
    const shared = await add(owner.email, { secret: "sk-shared-2222", shared: true })
    expect(shared.name).toBeNull()

    const renamed = await rename(ed.email, work.id, "Automations")
    expect(((await renamed.json()) as { name: string }).name).toBe("Automations")
    // Blank clears it back to the provider name.
    expect(
      ((await (await rename(ed.email, work.id, " ")).json()) as { name: null }).name,
    ).toBeNull()
    // Not a teammate's personal account, and a shared one needs a workspace owner.
    expect((await rename(owner.email, work.id, "Mine now")).status).toBe(404)
    expect((await rename(ed.email, shared.id, "Ed's")).status).toBe(404)
    expect((await rename(owner.email, shared.id, "Team")).status).toBe(200)
  })

  it("a removed member's key stops paying for their agent's jobs", async () => {
    const { app, meta } = await setup("jobs-accounts-leaver")
    const add = async (who: string, body: Record<string, unknown>) =>
      (await (
        await app.request(
          "/v1/accounts",
          jsonAs(as(who), { provider: "claude", kind: "api_key", ...body }),
        )
      ).json()) as { id: string }
    await add(owner.email, { secret: "sk-shared-1111", shared: true })
    const edsKey = await add(ed.email, { secret: "sk-ed-secret-2222" })
    // The list carries a hint, never the secret or its ciphertext.
    const listed = await (await app.request("/v1/accounts", { headers: as(ed.email) })).text()
    expect(listed).toContain("…2222")
    expect(listed).not.toContain("sk-ed-secret")
    expect(listed).not.toContain("secret_enc")

    const edsAgent = (await (
      await app.request("/v1/agents", jsonAs(as(ed.email), { name: "Ed's helper" }))
    ).json()) as { id: string; token: string }
    await app.request(`/v1/agents/${edsAgent.id}`, {
      ...jsonAs(as(ed.email), { account_id: edsKey.id }),
      method: "PATCH",
    })
    // A teammate asks Ed's agent, and Ed asks it something too.
    const job = (await (await ask(app, owner.email, edsAgent.id, "use Ed's key")).json()) as {
      id: string
    }
    const edsAsk = (await (await ask(app, ed.email, edsAgent.id, "mine")).json()) as {
      id: string
    }
    const waiting = (await (await ask(app, owner.email, edsAgent.id, "later")).json()) as {
      id: string
    }
    const [held] = await pull(app, edsAgent)
    expect(held).toBeDefined()
    const credFor = (headers: Record<string, string>) =>
      app.request(
        `/v1/jobs/${held?.id}/account?claim=${encodeURIComponent(held?.started_at ?? "")}`,
        { headers },
      )
    expect(await (await credFor(bearer(edsAgent.token))).json()).toMatchObject({
      credential: { value: "sk-ed-secret-2222" },
      source: "agent",
    })

    expect(
      (
        await app.request(`/v1/workspace/members/${ed.id}`, {
          method: "DELETE",
          headers: as(owner.email),
        })
      ).status,
    ).toBe(204)
    expect(await meta.getAccount(edsKey.id)).toBeNull()
    // The agent's key acted for Ed, so it now authenticates nobody: no key to read, no work
    // to pull, nothing to publish.
    expect((await credFor(bearer(edsAgent.token))).status).toBe(401)
    // An anonymous write is turned away before any route (403); a read says 401.
    expect([401, 403]).toContain(
      (await app.request(`/v1/agents/${edsAgent.id}/pull`, jsonAs(bearer(edsAgent.token), {})))
        .status,
    )
    expect([401, 403]).toContain(
      (await publishAs(app, "<h1>after</h1>", { title: "After" }, bearer(edsAgent.token))).status,
    )
    // Their agent is paused. The job they asked is cancelled, and so are a teammate's jobs on
    // it, waiting or running (its runner's key is dead, so it could only lapse), each saying why.
    const agentNow = (await (
      await app.request(`/v1/agents/${edsAgent.id}`, { headers: as(owner.email) })
    ).json()) as { paused: boolean }
    expect(agentNow.paused).toBe(true)
    expect((await meta.getJob(edsAsk.id))?.status).toBe("cancelled")
    const told = (await (
      await app.request(`/v1/jobs/${waiting.id}`, { headers: as(owner.email) })
    ).json()) as { status: string; messages: { body_md: string }[] }
    expect(told.status).toBe("cancelled")
    expect(told.messages.at(-1)?.body_md).toBe(OWNER_LEFT)
    expect((await meta.getJob(job.id))?.status).toBe("cancelled")
  })

  it("a deleted account's agent keys stop working, though the agents lose their creator", async () => {
    const { app, meta } = await setup("jobs-accounts-deleted")
    const edsAgent = (await (
      await app.request("/v1/agents", jsonAs(as(ed.email), { name: "Ed's runner" }))
    ).json()) as { id: string; token: string }
    const asked = (await (await ask(app, owner.email, edsAgent.id, "go")).json()) as { id: string }
    expect((await pull(app, edsAgent))[0]?.id).toBe(asked.id)
    // The path the auth layer's delete-user hook takes.
    await purgeUserDataAndSyncSeats(meta, undefined, ed.id)
    expect(await meta.getAgent(edsAgent.id)).toMatchObject({ created_by: null })
    const key = bearer(edsAgent.token)
    expect((await app.request(`/v1/jobs/${asked.id}/work`, { headers: key })).status).toBe(401)
    expect([401, 403]).toContain(
      (await app.request(`/v1/agents/${edsAgent.id}/pull`, jsonAs(key, {}))).status,
    )
    expect([401, 403]).toContain(
      (await publishAs(app, "<h1>after</h1>", { title: "After" }, key)).status,
    )
    expect((await meta.getJob(asked.id))?.status).toBe("cancelled")
  })

  it("an agent's tools run on its creator's personal broker plan", async () => {
    const { app, meta } = await setup("jobs-broker-plan")
    const attached = await app.request(
      "/v1/plans",
      jsonAs(as(owner.email), { kind: "broker", provider: "composio", secret: "ck-owner-plan" }),
    )
    expect(attached.status).toBe(201)
    await meta.createConnection({
      id: "cn_owner_gmail",
      org_id: "default",
      user_id: owner.id,
      kind: "oauth",
      broker: "composio",
      toolkit: "gmail",
      broker_ref: "ca_owner_gmail",
      status: "active",
    })
    const a = await createAgent(app, { connection_ids: ["cn_owner_gmail"] })
    await ask(app, ed.email, a.id, "triage the inbox")
    const keys: (string | null)[] = []
    const real = globalThis.fetch
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).includes("composio.dev")) return real(url, init)
      keys.push(new Headers(init?.headers).get("x-api-key"))
      return new Response(JSON.stringify({ items: [{ name: "GMAIL_LIST", description: "" }] }), {
        headers: { "content-type": "application/json" },
      })
    })
    try {
      const [j] = await pull(app, a)
      expect((j?.tools as { ref: string }[]).map((t) => t.ref)).toContain("ca_owner_gmail")
    } finally {
      vi.unstubAllGlobals()
    }
    expect(keys).toContain("ck-owner-plan")
  })
})

describe("jobs: the CLI runner (derive runner serve --agent)", () => {
  // These cases inject model replies. Supply the harness version that preflight checks,
  // so they do not depend on a model CLI installed on the CI machine.
  const harness = join(mkdtempSync(join(tmpdir(), "derive-runner-version-")), "claude")
  writeFileSync(harness, "#!/bin/sh\nprintf '1.0.0\\n'\n")
  chmodSync(harness, 0o755)
  const runnerFor = (app: App, agent: { id: string; token: string }, extra = {}) => {
    const cfg = loadJobRunnerConfig(
      {},
      {
        agent: agent.id,
        token: agent.token,
        server: "http://derive.test",
        "claude-bin": harness,
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
    // Routine answers stay on the task, without an automatic report artifact.
    expect(done.report_short_id).toBeNull()

    // A follow-up reopens the same task.
    await app.request(
      `/v1/jobs/${job.id}/messages`,
      jsonAs(as(ed.email), { body_md: "And last week?" }),
    )
    expect(await jobDrainPass(cfg, client)).toMatchObject({ served: 1 })
    const again = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
    ).json()) as { report_short_id: string | null }
    expect(again.report_short_id).toBeNull()
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

  it("a machine check that fails ends the task before any model runs; effort reaches the harness", async () => {
    const { app } = await setup("jobs-cli-machine-check")
    const agent = await createAgent(app, {
      effort: "medium",
      sandbox: { check: "echo 'no checkout at ~/app'; exit 3" },
    })
    const shown = (await (
      await app.request(`/v1/agents/${agent.id}`, { headers: as(owner.email) })
    ).json()) as { effort: string | null; sandbox: Record<string, unknown> }
    expect(shown).toMatchObject({
      effort: "medium",
      sandbox: { check: "echo 'no checkout at ~/app'; exit 3" },
    })
    const job = (await (await ask(app, ed.email, agent.id, "Go")).json()) as { id: string }
    const { cfg, client } = runnerFor(app, agent)
    const [pulled] = (await client.pull()).jobs
    if (!pulled) throw new Error("nothing pulled")
    expect(pulled.execution).toMatchObject({ effort: "medium" })
    let modelRan = false
    const out = await serveJob(client, pulled, cfg, {
      runAgent: async () => {
        modelRan = true
        return { ok: true, answer: { body_md: "done", escalate: false } }
      },
    })
    expect(out).toBe("failed")
    expect(modelRan).toBe(false)
    const after = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
    ).json()) as { status: string; messages: { body_md: string }[] }
    expect(after.status).toBe("failed")
    expect(after.messages.at(-1)?.body_md).toContain("The machine is not ready")
    expect(after.messages.at(-1)?.body_md).toContain("no checkout at ~/app")

    // A passing check lets the same agent's next task run with its effort.
    await app.request(
      `/v1/agents/${agent.id}`,
      jsonAs(as(owner.email), { sandbox: { check: "true" } }, "PATCH"),
    )
    await ask(app, ed.email, agent.id, "Go again")
    const [next] = (await client.pull()).jobs
    if (!next) throw new Error("nothing pulled")
    let effort: unknown = null
    expect(
      await serveJob(client, next, cfg, {
        runAgent: async (_p, opts) => {
          effort = opts.effort
          return { ok: true, answer: { body_md: "done", escalate: false } }
        },
      }),
    ).toBe("succeeded")
    expect(effort).toBe("medium")
  })

  it("a report's local screenshots are staged as assets, so the published page shows them", async () => {
    const { app } = await setup("jobs-cli-report-images")
    const agent = await createAgent(app)
    await ask(app, ed.email, agent.id, "Check the page and show me")
    const cwd = mkdtempSync(join(tmpdir(), "jobs-cli-images-"))
    mkdirSync(join(cwd, "qa", "shots"), { recursive: true })
    writeFileSync(
      join(cwd, "qa", "shots", "home.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    )
    writeFileSync(
      join(cwd, "qa", "report.html"),
      '<h1>PASS</h1><img src="shots/home.png" alt="Home"><img src="https://example.test/x.png">',
    )
    const { cfg, client } = runnerFor(app, agent, { cwd })
    const [pulled] = (await client.pull()).jobs
    if (!pulled) throw new Error("nothing pulled")
    expect(
      await serveJob(client, pulled, cfg, {
        runAgent: async () => ({
          ok: true,
          answer: {
            body_md: "PASS",
            escalate: false,
            artifact: { title: "Proof", path: "qa/report.html" },
          },
        }),
      }),
    ).toBe("succeeded")
    const done = (await (
      await app.request(`/v1/jobs/${pulled.id}`, { headers: as(ed.email) })
    ).json()) as { result: { effects?: { ref: string }[] }; messages: { body_md: string }[] }
    const ref = done.result.effects?.[0]?.ref
    expect(ref).toBeTruthy()
    const page = await (
      await app.request(`/v1/artifacts/${ref}/content`, { headers: as(owner.email) })
    ).text()
    expect(page).not.toContain('src="shots/home.png"')
    expect(page).toMatch(/src="[^"]*\/blob\/[0-9a-f]{64}/)
    // Remote images are left alone.
    expect(page).toContain('src="https://example.test/x.png"')
    expect(done.messages.at(-1)?.body_md).not.toContain("could not be attached")
  })

  it("with no stored account, a laptop runner uses its own model login; opted out, it fails plainly", async () => {
    const { app } = await setup("jobs-cli-noaccount")
    const agent = await createAgent(app)
    // Default: the job runs on whatever login this machine's model CLI has, from this shell.
    const first = (await (await ask(app, ed.email, agent.id, "Go")).json()) as { id: string }
    const { cfg, client } = runnerFor(app, agent)
    const [pulled] = (await client.pull()).jobs
    if (!pulled) throw new Error("nothing pulled")
    const before = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "sk-ant-local-shell"
    let sawEnv: Record<string, string> = {}
    try {
      expect(
        await serveJob(client, pulled, cfg, {
          runAgent: async (_p, opts) => {
            sawEnv = opts.env as Record<string, string>
            return { ok: true, answer: { body_md: "done locally" } }
          },
        }),
      ).toBe("succeeded")
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = before
    }
    expect(sawEnv.ANTHROPIC_API_KEY).toBe("sk-ant-local-shell")
    expect(sawEnv.DERIVE_TOKEN).toBeUndefined()
    void first

    // Opted out, the runner refuses rather than spending the machine's login.
    const second = (await (await ask(app, ed.email, agent.id, "Again")).json()) as { id: string }
    const strict = runnerFor(app, agent, { "no-local-login": "true" })
    const [next] = (await strict.client.pull()).jobs
    if (!next) throw new Error("nothing pulled")
    expect(
      await serveJob(strict.client, next, strict.cfg, {
        runAgent: async () => ({ ok: true, answer: { body_md: "x" } }),
      }),
    ).toBe("failed")
    const after = (await (
      await app.request(`/v1/jobs/${second.id}`, { headers: as(ed.email) })
    ).json()) as { status: string; messages: { body_md: string }[] }
    expect(after.status).toBe("failed")
    expect(after.messages.at(-1)?.body_md).toMatch(/no claude-code account for this agent/)
  })

  it("gives the model its sources' tools through a shim and a job token, never the agent key", async () => {
    const { app, meta } = await setup("jobs-cli-tools")
    await meta.createConnection({
      id: "cn_owner_stripe",
      org_id: "default",
      user_id: owner.id,
      kind: "oauth",
      broker: "local",
      toolkit: "stripe",
      broker_ref: `local:stripe:${owner.id}`,
      status: "active",
    })
    const agent = await createAgent(app, { connection_ids: ["cn_owner_stripe"] })
    const job = (await (await ask(app, ed.email, agent.id, "What is MRR?")).json()) as {
      id: string
    }
    // The shim runs as its own process, as the model would run it, so the app needs a real
    // address for it to reach.
    const bridge = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on("data", (c: Buffer) => chunks.push(c))
      req.on("end", async () => {
        const r = await app.request(req.url ?? "/", {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        })
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "text/plain" })
        res.end(Buffer.from(await r.arrayBuffer()))
      })
    })
    await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r))
    const server = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`
    const cwd = mkdtempSync(join(tmpdir(), "jobs-cli-tools-"))
    try {
      const { cfg, client } = runnerFor(app, agent, { server, cwd })
      const [pulled] = (await client.pull(1)).jobs
      if (!pulled) throw new Error("nothing pulled")
      expect(pulled.id).toBe(job.id)
      // Claim the target before creating the other job. This check tests token isolation,
      // so it must not depend on queue order when both jobs share a creation timestamp.
      const other = (await (await ask(app, ed.email, agent.id, "And churn?")).json()) as {
        id: string
      }
      // The model's token is a tool token, never the runner's own kind.
      const token = pulled.tool_token ?? ""
      expect(token).toMatch(/^dkjtool_/)

      const call = (jobId: string) =>
        app.request(`/v1/jobs/${jobId}/tool`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-derive-claim": pulled.started_at,
          },
          body: JSON.stringify({ tool: "stripe.read", args: {} }),
        })
      let sawEnv: Record<string, string> = {}
      let result: unknown = null
      const out = await serveJob(client, pulled, cfg, {
        runAgent: async (_p, opts) => {
          sawEnv = opts.env as Record<string, string>
          // The model reads the tool and how to call it from its prompt, then runs the shim.
          const shim = /`node (\S+) <tool>/.exec(String(opts.systemPrompt))?.[1]
          expect(String(opts.systemPrompt)).toContain("stripe.read")
          if (!shim) throw new Error("no shim in the prompt")
          const run = await promisify(execFile)(
            process.execPath,
            [shim, "stripe.read", '{"query":"mrr"}'],
            { cwd: String(opts.cwd), env: sawEnv },
          )
          result = JSON.parse(run.stdout)
          // While it is live, the model's token reaches its own job's tool route and nothing
          // else: not another job, not the runner's routes, not MCP, not a publish.
          const key = bearer(token)
          const claim = { ...key, "x-derive-claim": pulled.started_at }
          const refused: [string, Response][] = [
            ["other job's tool", await call(other.id)],
            ["pull", await app.request(`/v1/agents/${agent.id}/pull`, jsonAs(key, {}))],
            [
              "ask",
              await app.request("/v1/jobs", jsonAs(key, { agent_id: agent.id, instruction: "x" })),
            ],
            ["read job", await app.request(`/v1/jobs/${job.id}`, { headers: key })],
            [
              "account",
              await app.request(`/v1/jobs/${job.id}/account?provider=codex`, { headers: claim }),
            ],
            [
              "environment",
              await app.request(`/v1/jobs/${job.id}/environment`, { headers: claim }),
            ],
            [
              "report",
              await app.request(
                `/v1/jobs/${job.id}/report`,
                jsonAs(key, { started_at: pulled.started_at, status: "progress" }),
              ),
            ],
            ["work", await app.request(`/v1/jobs/${job.id}/work`, { headers: key })],
            ["publish", await publishAs(app, "<h1>x</h1>", { title: "X" }, key)],
            [
              "mcp",
              await app.request("/mcp", {
                method: "POST",
                headers: {
                  ...key,
                  "content-type": "application/json",
                  accept: "application/json, text/event-stream",
                },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/call",
                  params: { name: "list_workspaces", arguments: {} },
                }),
              }),
            ],
          ]
          for (const [what, res] of refused) expect([401, 403], what).toContain(res.status)
          return { ok: true, answer: { body_md: "MRR read." } }
        },
      })
      expect(out).toBe("succeeded")
      // The call went through the job's tool route to the agent's source.
      expect(result).toMatchObject({ tool: "stripe.read", args: { query: "mrr" } })
      // The model held the tool token, and not the agent's key.
      expect(sawEnv.DERIVE_TOOL_TOKEN).toBe(token)
      expect(sawEnv.DERIVE_TOKEN).toBeUndefined()
      expect(Object.values(sawEnv)).not.toContain(agent.token)
      // The shim is gone after the job.
      expect(existsSync(join(cwd, ".derive"))).toBe(false)

      // And it dies with its job.
      expect([401, 403]).toContain((await call(job.id)).status)
    } finally {
      bridge.close()
    }
  })
})

// Cloud execution uses Postgres. The native deployed proof covers its machine lifecycle.
describe("jobs: machine availability", () => {
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

  const joinHtml = (a: string) => {
    const ids = ["split", "left", "right", "merge"]
    const edges = [
      { from: "split", to: "left", label: "always" },
      { from: "split", to: "right", label: "always" },
      { from: "left", to: "merge", label: "done" },
      { from: "right", to: "merge", label: "done" },
    ]
    const manifest = {
      schema: "derive.linked-bundle/v1",
      purpose: "Split and join",
      members: [],
      diagrams: [
        {
          id: "join",
          title: "Join",
          type: "graph",
          nodes: ids.map((id) => ({ id, label: id, note: id })),
          edges,
        },
      ],
    }
    const step = (id: string, extra = {}) => ({
      id,
      kind: "context",
      context_ref: a,
      instruction: `Do ${id}.`,
      result: id,
      ...extra,
    })
    const definition = {
      schema: "derive.workflow/v1",
      purpose: "Split and join",
      diagrams: [
        {
          id: "join",
          entry: "split",
          nodes: [
            step("split", { routing: "all" }),
            step("left"),
            step("right"),
            step("merge", { terminal: true }),
          ],
          routes: edges.map((e) => ({ from: e.from, to: e.to, when: e.label })),
          scenarios: [
            {
              id: "expected",
              kind: "expected",
              path: ["split", "left", "merge"],
              outcome: "Joined",
            },
            { id: "failure", kind: "failure", path: ["split"], outcome: "Split failed" },
          ],
        },
      ],
    }
    return `<!doctype html><html><body>${ids.map((i) => `<a href="#${i}">${i}</a>`).join("")}<script type="application/derive-facts" data-fact="bundle-manifest">${JSON.stringify(manifest)}</script><script type="application/derive-facts" data-fact="workflow-definition">${JSON.stringify(definition)}</script></body></html>`
  }

  it("opens a step where branches meet once, after both branches finish", async () => {
    const made = await setup("jobs-graph-join")
    const { app, meta } = made
    const worker = await createAgent(app, { name: "Worker", max_concurrency: 3 })
    const page = (await (
      await publishAs(app, joinHtml(worker.id), { title: "Join flow" }, as(owner.email))
    ).json()) as { short_id: string }
    const graph = await createAgent(app, { name: "Join", instructions_short_id: page.short_id })
    const deps = graphAware({ meta, blobs: made.ctx.blobs })
    const asked = (await (await ask(app, ed.email, graph.id, "Go")).json()) as { id: string }
    await graphPass(deps)
    const done = async (j: { id: string; started_at: string }) =>
      app.request(
        `/v1/jobs/${j.id}/report`,
        jsonAs(bearer(worker.token), {
          started_at: j.started_at,
          status: "succeeded",
          body_md: "ok",
        }),
      )
    const [split] = await pull(app, worker)
    if (!split) throw new Error("no split")
    await done(split)
    const branches = await pull(app, worker)
    expect(branches.map((b) => b.node_id).sort()).toEqual(["left", "right"])
    const [first, second] = branches
    if (!first || !second) throw new Error("no branches")
    await done(first)
    // One branch in: the join waits.
    expect(await pull(app, worker)).toEqual([])
    await done(second)
    await graphPass(deps)
    const merge = await pull(app, worker)
    expect(merge.map((m) => m.node_id)).toEqual(["merge"])
    await done(merge[0] as { id: string; started_at: string })
    await graphPass(deps)
    expect((await meta.getJob(asked.id))?.status).toBe("succeeded")
    const kids = await meta.listJobs({ orgId: "default", parentId: asked.id, limit: 50 })
    expect(kids.filter((k) => k.node_id === "merge")).toHaveLength(1)
  })

  it("two passes racing on one graph open each step once", async () => {
    const made = await setup("jobs-graph-race")
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
    const graph = await createAgent(app, { name: "Race", instructions_short_id: page.short_id })
    const deps = graphAware({ meta, blobs: made.ctx.blobs })
    const asked = (await (await ask(app, ed.email, graph.id, "Go")).json()) as { id: string }
    const stale = await meta.getJob(asked.id)
    if (!stale) throw new Error("no graph")
    await Promise.all([advanceGraph(deps, stale), advanceGraph(deps, stale), graphPass(deps)])
    const kids = await meta.listJobs({ orgId: "default", parentId: asked.id, limit: 50 })
    expect(kids.map((k) => k.node_id)).toEqual(["draft"])
    expect((await meta.getJob(asked.id))?.status).toBe("running")
  })

  it("a message at a decision step that is not a decision leaves the graph waiting", async () => {
    const made = await setup("jobs-graph-chat")
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
    const graph = await createAgent(app, { name: "Chat", instructions_short_id: page.short_id })
    const deps = graphAware({ meta, blobs: made.ctx.blobs })
    const asked = (await (await ask(app, ed.email, graph.id, "Go")).json()) as { id: string }
    await graphPass(deps)
    const [j] = await pull(app, writer)
    if (!j) throw new Error("no draft")
    await app.request(
      `/v1/jobs/${j.id}/report`,
      jsonAs(bearer(writer.token), { started_at: j.started_at, status: "succeeded", body_md: "x" }),
    )
    expect((await meta.getJob(asked.id))?.status).toBe("needs_you")
    await app.request(
      `/v1/jobs/${asked.id}/messages`,
      jsonAs(as(ed.email), { body_md: "hold on, checking" }),
    )
    await graphPass(deps)
    expect((await meta.getJob(asked.id))?.status).toBe("needs_you")
    expect(await meta.listJobs({ orgId: "default", parentId: asked.id, limit: 50 })).toHaveLength(1)
  })

  it("a step where a longer branch meets a shorter one waits for the longer", async () => {
    const made = await setup("jobs-graph-uneven")
    const { app, meta } = made
    const worker = await createAgent(app, { name: "Worker", max_concurrency: 4 })
    // split → left → merge, and split → long → right → merge
    const html = joinHtml(worker.id)
      .replaceAll(
        '{"from":"split","to":"right","label":"always"}',
        '{"from":"split","to":"long","label":"always"},{"from":"long","to":"right","label":"then"}',
      )
      .replaceAll(
        '{"from":"split","to":"right","when":"always"}',
        '{"from":"split","to":"long","when":"always"},{"from":"long","to":"right","when":"then"}',
      )
      .replace(
        '"nodes":[{"id":"split"',
        '"nodes":[{"id":"long","label":"long","note":"long"},{"id":"split"',
      )
      .replace(
        '{"id":"left","kind":"context"',
        `{"id":"long","kind":"context","context_ref":"${worker.id}","instruction":"Do long.","result":"long"},{"id":"left","kind":"context"`,
      )
      .replace('<a href="#split">', '<a href="#long">long</a><a href="#split">')
    const page = (await (
      await publishAs(app, html, { title: "Uneven" }, as(owner.email))
    ).json()) as { short_id: string }
    const graph = await createAgent(app, { name: "Uneven", instructions_short_id: page.short_id })
    const deps = graphAware({ meta, blobs: made.ctx.blobs })
    const asked = (await (await ask(app, ed.email, graph.id, "Go")).json()) as { id: string }
    expect((await meta.getJob(asked.id))?.kind).toBe("graph")
    await graphPass(deps)
    const done = (j: { id: string; started_at: string }) =>
      app.request(
        `/v1/jobs/${j.id}/report`,
        jsonAs(bearer(worker.token), {
          started_at: j.started_at,
          status: "succeeded",
          body_md: "ok",
        }),
      )
    const byNode = async () => {
      const got = await pull(app, worker)
      return new Map(got.map((j) => [j.node_id as string, j]))
    }
    let open = await byNode()
    await done(open.get("split") as { id: string; started_at: string })
    open = await byNode()
    expect([...open.keys()].sort()).toEqual(["left", "long"])
    await done(open.get("left") as { id: string; started_at: string })
    // Left arrived at merge, but the long branch can still reach it: merge waits.
    await done(open.get("long") as { id: string; started_at: string })
    open = await byNode()
    expect([...open.keys()]).toEqual(["right"])
    await done(open.get("right") as { id: string; started_at: string })
    open = await byNode()
    expect([...open.keys()]).toEqual(["merge"])
    await done(open.get("merge") as { id: string; started_at: string })
    expect((await meta.getJob(asked.id))?.status).toBe("succeeded")
  })

  it("a pass right after a step settles never counts that step's successor as a second try", async () => {
    const made = await setup("jobs-graph-race2")
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
    const graph = await createAgent(app, { name: "Race2", instructions_short_id: page.short_id })
    const deps = graphAware({ meta, blobs: made.ctx.blobs })
    const asked = (await (await ask(app, ed.email, graph.id, "Go")).json()) as { id: string }
    await graphPass(deps)
    const [j] = await pull(app, writer)
    if (!j) throw new Error("no draft")
    const stale = await meta.getJob(asked.id)
    await app.request(
      `/v1/jobs/${j.id}/report`,
      jsonAs(bearer(writer.token), { started_at: j.started_at, status: "succeeded", body_md: "x" }),
    )
    await Promise.all([graphPass(deps), stale ? advanceGraph(deps, stale) : null])
    expect((await meta.getJob(asked.id))?.status).toBe("needs_you")
    // An answer that names no route is not a decision: still waiting, question intact.
    await app.request(
      `/v1/jobs/${asked.id}/messages`,
      jsonAs(as(ed.email), { body_md: "Decision: maybe" }),
    )
    await graphPass(deps)
    const still = await meta.getJob(asked.id)
    expect(still?.status).toBe("needs_you")
    expect(JSON.parse(still?.needs_json ?? "{}")).toMatchObject({ question: "Ship it?" })
  })

  it("a step whose budget is used up waits, says so, and opens once the limit lifts", async () => {
    const made = await setup("jobs-graph-budget")
    const { app, meta } = made
    const writer = await createAgent(app, { name: "Writer" })
    await createAgent(app, { name: "Publisher" })
    const page = (await (
      await publishAs(app, graphHtml(writer.id, "Publisher"), { title: "Flow" }, as(owner.email))
    ).json()) as { short_id: string }
    const graph = await createAgent(app, { name: "Flow", instructions_short_id: page.short_id })
    const asked = (await (await ask(app, ed.email, graph.id, "Go")).json()) as { id: string }
    // The budget runs out after the graph was asked, before its first step opens.
    await meta.addJobCost(asked.id, 5_000)
    const plan = await meta.createPlan({
      id: newId("plan"),
      org_id: "default",
      user_id: null,
      kind: "model",
      provider: "anthropic",
      secret_enc: "enc",
      limits: JSON.stringify({ monthlyMicroUsd: 1_000 }),
    })
    const deps = graphAware({ meta, blobs: made.ctx.blobs })
    await graphPass(deps)
    expect(await meta.listJobs({ orgId: "default", agentId: writer.id })).toEqual([])
    expect((await meta.listJobMessages(asked.id)).at(-1)?.body_md).toBe(HELD_FOR_BUDGET)
    expect((await meta.getJob(asked.id))?.status).not.toBe("failed")
    await meta.deletePlan(plan.id, "default")
    await graphPass(deps)
    // The graph holds each pass for a short window; let it lapse.
    for (
      let i = 0;
      i < 3 && !(await meta.listJobs({ orgId: "default", agentId: writer.id })).length;
      i++
    ) {
      const g = await meta.getJob(asked.id)
      await meta.updateJob(asked.id, {
        meta_json: JSON.stringify({
          ...JSON.parse(g?.meta_json ?? "{}"),
          graph: { ...JSON.parse(g?.meta_json ?? "{}").graph, pass_until: undefined },
        }),
      })
      await graphPass(deps)
    }
    expect(await meta.listJobs({ orgId: "default", agentId: writer.id })).toHaveLength(1)
  })

  it("a step naming an imported paper's hidden agent is not run by it", async () => {
    const made = await setup("jobs-graph-managed")
    const { app, meta } = made
    const hidden = await meta.createAgent({
      id: "ag_graph_hidden",
      org_id: "default",
      name: "arXiv:2401.00002",
      token: "hash_not_handed_out_2",
      role: "editor",
      created_by: owner.id,
      managed: 1,
    })
    await createAgent(app, { name: "Publisher" })
    const page = (await (
      await publishAs(app, graphHtml(hidden.id, "Publisher"), { title: "Flow" }, as(owner.email))
    ).json()) as { short_id: string }
    const graph = await createAgent(app, { name: "Flow", instructions_short_id: page.short_id })
    const asked = (await (await ask(app, ed.email, graph.id, "Go")).json()) as { id: string }
    await graphPass(graphAware({ meta, blobs: made.ctx.blobs }))
    expect(await meta.listJobs({ orgId: "default", agentId: hidden.id })).toEqual([])
    expect((await meta.getJob(asked.id))?.status).toBe("failed")
    const last = (await meta.listJobMessages(asked.id)).at(-1)?.body_md
    expect(last).toMatch(/not an agent here/)
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

// Derive machines need the Postgres execution store; `pnpm test:pg` runs these.
describe.runIf(process.env.DERIVE_TEST_DB === "pg")("jobs: Derive machines on boat.dev", () => {
  /** boat.dev as the BoatClient sees it: sandboxes that come up, stop, resume, and run the
   *  launched runner as a detached command whose state the test drives. */
  const fakeBoat = () => {
    const boxes = new Map<
      string,
      { state: string; stopped: boolean; archiveAt: number; env?: Record<string, string> }
    >()
    // The runner's state per launch, keyed by its operation directory, as the runner's marker is.
    const launches = new Map<string, { box: string; state: "running" | "exited" }>()
    const operation = (command: string) => /operations\/([a-f0-9]{64})/.exec(command)?.[1] ?? ""
    const calls: string[] = []
    let next = 0
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = url.pathname.replace("/api/v1", "")
      const method = init?.method ?? "GET"
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (path === "/me") return json({ user: { id: "boat-user" } })
      if (path === "/sandboxes" && method === "POST") {
        const id = `bx_${++next}`
        boxes.set(id, {
          state: "idle",
          stopped: false,
          archiveAt: Date.now() + (body.ttlSeconds ?? 1800) * 1000,
        })
        calls.push(`create ${id} ${body.from ?? "-"} ${body.type}`)
        return json({ sandbox: { id, state: "provisioned" } })
      }
      const [, , id, action] = path.split("/")
      const box = id ? boxes.get(id) : undefined
      if (!id || !box) return new Response("{}", { status: 404 })
      const sandbox = () => ({
        id,
        state: box.stopped ? "archived" : box.state,
        setupStatus: "done",
        hydrated: true,
        archiveAfter: new Date(box.archiveAt).toISOString(),
        ...(box.stopped ? { stop: { id: `stop-${id}`, status: "completed" } } : {}),
      })
      if (!action) return json({ sandbox: sandbox() })
      if (action === "stop") {
        calls.push(`stop ${id}`)
        box.stopped = true
        return json({})
      }
      if (action === "resume") {
        calls.push(`resume ${id}`)
        box.stopped = false
        // boat.dev starts the stop timer when the resume finishes, a little after it was asked.
        box.archiveAt = Date.now() + (body.ttlSeconds + 20) * 1000
        return json({})
      }
      if (action === "files") {
        box.env = JSON.parse(body.content)
        return json({ success: true })
      }
      if (action === "commands") {
        if (body.detached) {
          launches.set(operation(body.command), { box: id, state: "running" })
          return json({ processId: 1, success: true })
        }
        return json({
          success: true,
          stdout: body.command.includes("claim")
            ? (launches.get(operation(body.command))?.state ?? "starting")
            : "",
        })
      }
      if (action === "usage")
        return json({ sandboxId: id, seconds: 30, dollars: 0.0006, running: false })
      if (action === "sshkey") {
        calls.push(`sshkey ${id} ${body.key.split(" ")[0]}`)
        return json({
          success: true,
          machineIp: "203.0.113.10",
          sshUser: "user",
          hostKey: "ssh-ed25519 AAAAhost",
        })
      }
      return new Response("{}", { status: 404 })
    }) as typeof fetch
    /** The runner process on a sandbox finished (its newest launch). */
    const exit = (id: string) => {
      const last = [...launches.values()].filter((l) => l.box === id).at(-1)
      if (last) last.state = "exited"
    }
    return { fetcher, boxes, calls, exit }
  }

  const SESSION_UUID = "0b6f2a1e-3c4d-4e5f-8a9b-0c1d2e3f4a5b"
  const harness = join(mkdtempSync(join(tmpdir(), "derive-machine-codex-")), "codex")
  writeFileSync(harness, "#!/bin/sh\nprintf 'codex-cli 0.162.1\\n'\n")
  chmodSync(harness, 0o755)

  const cloudSetup = async (name: string, limits = { global: 100, workspace: 20 }) => {
    const boat = fakeBoat()
    const runtime = {
      provider: "boat" as const,
      apiUrl: "https://boat.dev/api/v1",
      runnerPath: "/opt/derive/bin/derive.js",
      limits,
    }
    const made = await setup(name, {
      runtime,
      runtimeFetch: boat.fetcher,
      baseUrl: "http://derive.test",
    })
    const { app, meta } = made
    expect(
      (
        await app.request(
          "/v1/runtime/connection",
          jsonAs(as(owner.email), { api_key: "boat_key_0001234", provider: "boat" }, "PUT"),
        )
      ).status,
    ).toBe(200)
    await app.request(
      "/v1/accounts",
      jsonAs(as(owner.email), {
        provider: "codex",
        kind: "api_key",
        secret: "sk-codex-0001234",
        shared: true,
      }),
    )
    const deps = machineDepsFrom(meta, {
      secret: "test-encryption-key",
      server: "http://derive.test",
      config: runtime,
      fetcher: boat.fetcher,
    })
    if (!deps) throw new Error("no machine deps")
    const pass = () => machinePass(deps, { maxRequests: 400, maxTransitions: 200 })
    /** Run passes until the job's machine reaches `phase` (or fail after a few). */
    const until = async (jobId: string, phase: string) => {
      for (let i = 0; i < 8; i++) {
        if ((await meta.getJob(jobId))?.machine_phase === phase) return
        await pass()
      }
      expect((await meta.getJob(jobId))?.machine_phase).toBe(phase)
    }
    /** Act as the runner the machine launched: claim the job with its token and report. */
    const runTurn = async (
      sandboxId: string,
      answer: string,
      runSession?: (opts: {
        args: string[]
        env: Record<string, string>
        cwd: string
      }) => Promise<string>,
    ) => {
      const env = boat.boxes.get(sandboxId)?.env
      if (!env) throw new Error(`nothing launched on ${sandboxId}`)
      const cfg = {
        ...loadJobRunnerConfig(
          {},
          {
            token: env.DERIVE_TOKEN ?? "",
            agent: "from-job",
            server: "http://derive.test",
            "agent-bin": harness,
          },
        ),
        localLogin: false,
        jobId: env.DERIVE_JOB_ID ?? "",
      }
      const client = new JobClient(cfg, (url, init) => Promise.resolve(app.request(url, init)))
      const out = await runOneJob(cfg, client, {
        // A model turn as Codex leaves it: an answer plus its session file in CODEX_HOME,
        // which the runner checkpoints so the next turn continues the conversation.
        runAgent: async (
          _p: unknown,
          opts: { env: Record<string, string>; meter: { sessionId?: string } },
        ) => {
          const day = join(opts.env.CODEX_HOME ?? "", "sessions", "2026", "10", "13")
          mkdirSync(day, { recursive: true })
          writeFileSync(
            join(day, `rollout-1-${sandboxId}-thread.jsonl`),
            `{"answer":"${answer}"}\n`,
          )
          opts.meter.sessionId = `${sandboxId}-thread`
          return { ok: true, answer: { body_md: answer, escalate: false } }
        },
        // An interactive harness leaves its own session file, named by the id it chose.
        ...(runSession
          ? {
              runSession: async (opts: {
                args: string[]
                env: Record<string, string>
                cwd: string
              }) => {
                const day = join(opts.env.CODEX_HOME ?? "", "sessions", "2026", "10", "13")
                mkdirSync(day, { recursive: true })
                writeFileSync(
                  join(day, `rollout-2026-10-13T00-00-00-${SESSION_UUID}.jsonl`),
                  "{}\n",
                )
                return runSession(opts)
              },
            }
          : {}),
      })
      boat.exit(sandboxId)
      return out
    }
    return { ...made, boat, pass, until, runTurn }
  }

  it("a fresh agent gives each task its own machine: parallel, parked between turns, resumed, retired on stop", async () => {
    const { app, meta, boat, until, runTurn } = await cloudSetup("jobs-machine-own")
    const agent = await createAgent(app, {
      machine: "derive",
      provider: "codex",
      sandbox: { snapshot: "team-image", size: "large", fresh: true },
    })
    const a = (await (await ask(app, ed.email, agent.id, "Fix the inbox copy")).json()) as {
      id: string
    }
    const b = (await (await ask(app, ed.email, agent.id, "Bump the bundler")).json()) as {
      id: string
    }
    await until(a.id, "running")
    await until(b.id, "running")
    // Two tasks on one agent run at once, each on its own large machine from the snapshot.
    expect(boat.calls.filter((c) => c.startsWith("create"))).toEqual([
      "create bx_1 team-image large",
      "create bx_2 team-image large",
    ])
    const jobA = await meta.getJob(a.id)
    const jobB = await meta.getJob(b.id)
    expect([jobA?.machine_phase, jobB?.machine_phase]).toEqual(["running", "running"])
    const sandboxOf = (job: typeof jobA) => JSON.parse(job?.machine_json ?? "{}").own.sandbox_id
    const boxA = sandboxOf(jobA)
    const boxB = sandboxOf(jobB)

    expect(await runTurn(boxA, "Inbox copy fixed")).toBe("succeeded")
    expect(await runTurn(boxB, "Bundler bumped")).toBe("succeeded")
    await until(a.id, "parked")
    await until(b.id, "parked")
    // Finished turns park their machines: stopped, files kept, no compute held.
    expect((await meta.getJob(a.id))?.machine_phase).toBe("parked")
    expect(boat.boxes.get(boxA)?.stopped).toBe(true)

    // A follow-up resumes the same machine instead of building a new one.
    await app.request(
      `/v1/jobs/${a.id}/messages`,
      jsonAs(as(ed.email), { body_md: "Also the empty state" }),
    )
    await until(a.id, "running")
    expect(boat.calls).toContain(`resume ${boxA}`)
    expect(boat.calls.filter((c) => c.startsWith("create"))).toHaveLength(2)
    expect(await runTurn(boxA, "Empty state too")).toBe("succeeded")
    await until(a.id, "parked")

    // Stopping a task for good retires its parked machine.
    await app.request(`/v1/jobs/${b.id}/cancel`, { method: "POST", headers: as(ed.email) })
    await until(b.id, "released")
    const usage = JSON.parse((await meta.getJob(a.id))?.result_json ?? "{}").compute
    expect(usage).toHaveLength(2)
  })

  it("an interactive session runs the native harness, parks when idle, and only its starter attaches", async () => {
    const { app, meta, boat, until, runTurn } = await cloudSetup("jobs-machine-session")
    // A session gets its own machine even on an agent that keeps files.
    const agent = await createAgent(app, { machine: "derive", provider: "codex", effort: "medium" })
    const res = await app.request(
      "/v1/jobs",
      jsonAs(as(ed.email), {
        agent_id: agent.id,
        instruction: "Tidy the inbox empty state",
        session: true,
      }),
    )
    const job = (await res.json()) as { id: string }
    await until(job.id, "running")
    const box = JSON.parse((await meta.getJob(job.id))?.machine_json ?? "{}").own.sandbox_id
    const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOx3 ed@laptop"
    const attach = (who: string) =>
      app.request(`/v1/jobs/${job.id}/attach`, jsonAs(as(who), { public_key: key }))

    // Only the person who started the session gets a shell on its machine.
    expect((await attach(owner.email)).status).toBe(403)
    const opened = await attach(ed.email)
    expect(opened.status).toBe(200)
    expect(await opened.json()).toEqual({
      host: "203.0.113.10",
      port: 22,
      user: "user",
      host_key: "ssh-ed25519 AAAAhost",
      tmux_session: "derive",
    })

    // The runner starts the harness interactively with the task's model and effort.
    let first: string[] = []
    let home: Record<string, string> = {}
    await runTurn(box, "", async ({ args, env, cwd }) => {
      first = args
      // The private model home answers the interactive harness's first-run questions.
      home = {
        auth: readFileSync(join(env.CODEX_HOME ?? "", "auth.json"), "utf8"),
        config: readFileSync(join(env.CODEX_HOME ?? "", "config.toml"), "utf8"),
        agents: readFileSync(join(env.CODEX_HOME ?? "", "AGENTS.md"), "utf8"),
        cwd,
      }
      return "idle"
    })
    expect(JSON.parse(home.auth ?? "{}")).toEqual({ OPENAI_API_KEY: "sk-codex-0001234" })
    expect(home.config).toContain(`[projects.${JSON.stringify(home.cwd)}]\ntrust_level = "trusted"`)
    expect(first.slice(0, 5)).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "gpt-6-luna",
      "-c",
      'model_reasoning_effort="medium"',
    ])
    // The person sees the task as the first message; the instructions ride AGENTS.md.
    expect(first.at(-1)).toBe("Tidy the inbox empty state")
    expect(home.agents).toContain("Derive")
    await until(job.id, "parked")
    expect((await meta.listJobMessages(job.id)).at(-1)?.body_md).toContain("Session paused")
    expect((await attach(ed.email)).status).toBe(409)
    // `derive ls` lists it as a paused session.
    const printed: string[] = []
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((line) => void printed.push(String(line)))
    const cli = sessionApi({
      server: "http://derive.test",
      token: null,
      workspaceId: null,
      fetcher: (url: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(
          app.request(String(url), {
            ...init,
            headers: { ...(init?.headers as Record<string, string>), ...as(ed.email) },
          }),
        ),
    })
    expect(await sessionCommand("ls", [], {}, cli)).toBe(0)
    log.mockRestore()
    expect(printed.join("\n")).toMatch(
      new RegExp(`${job.id.slice(-6)}\\s+.+?\\s+codex\\s+session\\s+-\\s+paused`),
    )

    // Reopening resumes the same conversation on the same machine without a new message.
    await app.request(
      `/v1/jobs/${job.id}/messages`,
      jsonAs(as(ed.email), { body_md: "Resume the session." }),
    )
    await until(job.id, "running")
    expect(boat.calls).toContain(`resume ${box}`)
    let second: string[] = []
    await runTurn(box, "", async ({ args }) => {
      second = args
      return "exited"
    })
    expect(second[0]).toBe("resume")
    expect(second.at(-1)).toBe(SESSION_UUID)
  })

  it("a code task carries its repository, and fails plainly with no GitHub connection for it", async () => {
    const { app, meta, until, runTurn } = await cloudSetup("jobs-machine-repo")
    const agent = await createAgent(app, { machine: "derive", provider: "codex" })
    const res = await app.request(
      "/v1/jobs",
      jsonAs(as(ed.email), {
        agent_id: agent.id,
        instruction: "Fix the flaky test",
        repo: "acme-dev/widgets@main",
      }),
    )
    const job = (await res.json()) as { id: string; task: { repo: string } }
    expect(job.task.repo).toBe("acme-dev/widgets@main")
    await until(job.id, "running")
    // The runner asks for the repository's token before any model runs, and is told why not.
    expect(await runTurn("bx_1", "unused")).toBe("failed")
    const failed = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
    ).json()) as {
      result: { failure: { reason: string; retryable: boolean } }
    }
    expect(failed.result.failure).toEqual({
      reason: "Bind a GitHub connection for acme-dev to this agent to work in acme-dev/widgets.",
      retryable: false,
    })
    // A repository is only for cloud agents.
    const local = await createAgent(app, { provider: "codex" })
    const refused = await app.request(
      "/v1/jobs",
      jsonAs(as(ed.email), { agent_id: local.id, instruction: "x", repo: "acme-dev/widgets" }),
    )
    expect(refused.status).toBe(400)
  })

  it("an interrupting follow-up ends the running turn and runs next; a plain one waits", async () => {
    const { app, meta, boat, pass, until } = await cloudSetup("jobs-machine-interrupt")
    const agent = await createAgent(app, { machine: "derive", provider: "codex" })
    const job = (await (await ask(app, ed.email, agent.id, "Refactor the parser")).json()) as {
      id: string
    }
    await until(job.id, "running")
    const machineTurn = async () =>
      JSON.parse((await meta.getJob(job.id))?.machine_json ?? "{}").turn as string
    const first = await machineTurn()
    const say = (body_md: string, interrupt?: boolean) =>
      app.request(
        `/v1/jobs/${job.id}/messages`,
        jsonAs(as(ed.email), { body_md, ...(interrupt ? { interrupt } : {}) }),
      )
    // A plain follow-up waits for the turn in progress.
    expect(((await (await say("Also add tests")).json()) as { status: string }).status).toBe(
      "running",
    )
    // An interrupting one ends its claim at once: the task is queued again.
    const after = (await (await say("Stop, use the old API", true)).json()) as {
      status: string
      lease_until: string | null
    }
    expect(after).toMatchObject({ status: "queued", lease_until: null })
    // The runner finds its claim gone and exits; the machine then starts the next turn.
    boat.exit("bx_1")
    for (let i = 0; i < 6 && (await machineTurn()) === first; i++) await pass()
    await until(job.id, "running")
    expect(await machineTurn()).not.toBe(first)
    expect((await meta.getJob(job.id))?.status).toBe("running")
  })

  it("the workspace machine limit holds the next task until a machine frees", async () => {
    const { app, meta, pass, runTurn, boat } = await cloudSetup("jobs-machine-limit", {
      global: 100,
      workspace: 1,
    })
    const agent = await createAgent(app, {
      machine: "derive",
      provider: "codex",
      sandbox: { fresh: true },
    })
    const a = (await (await ask(app, ed.email, agent.id, "One")).json()) as { id: string }
    const b = (await (await ask(app, ed.email, agent.id, "Two")).json()) as { id: string }
    for (let i = 0; i < 4; i++) await pass()
    expect((await meta.getJob(a.id))?.machine_phase).toBe("running")
    expect((await meta.getJob(b.id))?.status).toBe("queued")
    await runTurn("bx_1", "done")
    for (let i = 0; i < 4; i++) await pass()
    // A parked machine holds no compute, so the waiting task starts.
    expect((await meta.getJob(a.id))?.machine_phase).toBe("parked")
    expect((await meta.getJob(b.id))?.machine_phase).toBe("running")
    expect(boat.calls.filter((c) => c.startsWith("create"))).toHaveLength(2)
  })
})
