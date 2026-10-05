import { execFile } from "node:child_process"
import { existsSync, mkdtempSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { newId } from "@derive/core"
import { describe, expect, it, vi } from "vitest"
import {
  JobClient,
  jobDrainPass,
  loadJobRunnerConfig,
  loadOneJobConfig,
  runOneJob,
  serveJob,
} from "../../../packages/cli/src/job-runner.js"
import type { AppDeps } from "../src/context"
import { purgeUserDataAndSyncSeats } from "../src/lib/account"
import type { ModelTurn } from "../src/lib/agent-loop"
import { signCapabilityToken } from "../src/lib/capability-token"
import { advanceGraph, graphAware, graphPass } from "../src/lib/job-graph"
import { machinePass, machineWorkspaces } from "../src/lib/job-machine"
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
    const edsKey = await secret(ed.email, "eds-own-fixture") // gitleaks:allow test fixture
    const ownersKey = await secret(owner.email, "reporting-db-fixture") // gitleaks:allow test fixture
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
    ).json()) as { environment: Record<string, string>; environment_names: string[] }
    expect(shown.environment).toEqual({ DB_URL: ownersKey })
    expect(JSON.stringify(shown)).not.toContain("reporting-db-fixture")
    // A running job reads the value through its claim, and only there.
    expect((await ask(app, owner.email, agent.id, "report")).status).toBe(201)
    const [job] = await pull(app, agent)
    if (!job) throw new Error("no job pulled")
    const env = await app.request(`/v1/jobs/${job.id}/environment`, {
      headers: { ...bearer(agent.token), "x-derive-claim": job.started_at },
    })
    expect(await env.json()).toEqual({ environment: { DB_URL: "reporting-db-fixture" } })
    // {} clears it.
    const cleared = await app.request(`/v1/agents/${agent.id}`, {
      ...jsonAs(as(owner.email), { environment: {} }),
      method: "PATCH",
    })
    expect(((await cleared.json()) as { environment_names: string[] }).environment_names).toEqual(
      [],
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
    expect(held?.id).toBe(job.id)
    const credFor = (headers: Record<string, string>) =>
      app.request(
        `/v1/jobs/${job.id}/account?claim=${encodeURIComponent(held?.started_at ?? "")}`,
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

  it("makes the report private to the workspace, and a person's comment on it reopens the job", async () => {
    const { app } = await setup("jobs-cli-report-private")
    const agent = await createAgent(app)
    const job = (await (await ask(app, ed.email, agent.id, "Count the signups")).json()) as {
      id: string
    }
    const { cfg, client } = runnerFor(app, agent, { mock: "true" })
    expect(await jobDrainPass(cfg, client)).toMatchObject({ served: 1 })
    const done = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
    ).json()) as { status: string; report_short_id: string }
    expect(done.status).toBe("succeeded")
    const page = (await (
      await app.request(`/v1/artifacts/${done.report_short_id}`, { headers: as(ed.email) })
    ).json()) as { workspace_access: string; link_role: string; listed: string }
    expect(page).toMatchObject({ workspace_access: "member", link_role: "none", listed: "none" })

    // The asker comments in the report's margin: the job reopens with that as the next turn.
    const commented = await app.request(
      `/v1/artifacts/${done.report_short_id}/comments`,
      jsonAs(as(ed.email), { body_md: "Split it by plan too." }),
    )
    expect(commented.status).toBe(201)
    const reopened = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
    ).json()) as { status: string; messages: { author_kind: string; body_md: string }[] }
    expect(reopened.status).toBe("queued")
    expect(reopened.messages.at(-1)).toMatchObject({
      author_kind: "asker",
      body_md: "Split it by plan too.",
    })
    // The runner's next turn rewrites the same report.
    expect(await jobDrainPass(cfg, client)).toMatchObject({ served: 1 })
    const again = (await (
      await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })
    ).json()) as { status: string; report_short_id: string }
    expect(again).toMatchObject({ status: "succeeded", report_short_id: done.report_short_id })

    // A reply rides its thread, and a comment that @mentions the agent reaches it through its
    // inbox: neither also reopens the job, which would set the agent to the same work twice.
    const thread = ((await commented.json()) as { thread_id: string }).thread_id
    await app.request(
      `/v1/artifacts/${done.report_short_id}/comments`,
      jsonAs(as(ed.email), { body_md: "Thanks.", thread_id: thread }),
    )
    await app.request(
      `/v1/artifacts/${done.report_short_id}/comments`,
      jsonAs(as(ed.email), {
        body_md: "@agent one more pass",
        mentions: [{ id: agent.id, name: "agent" }],
      }),
    )
    expect(
      (
        (await (await app.request(`/v1/jobs/${job.id}`, { headers: as(ed.email) })).json()) as {
          status: string
        }
      ).status,
    ).toBe("succeeded")
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

  it("a workspace past its monthly budget brings up no machine until the limit lifts", async () => {
    const m = await machineApp("jobs-machine-budget")
    const job = (await (await ask(m.app, ed.email, m.agent.id, "Go")).json()) as { id: string }
    await m.meta.addJobCost(job.id, 5_000)
    const plan = await m.meta.createPlan({
      id: newId("plan"),
      org_id: "default",
      user_id: null,
      kind: "model",
      provider: "anthropic",
      secret_enc: "enc",
      limits: JSON.stringify({ monthlyMicroUsd: 1_000 }),
    })
    for (let i = 0; i < 4; i++) await machinePass(m.deps)
    expect(m.ortam.sandboxes.size).toBe(0)
    expect((await m.meta.getJob(job.id))?.status).toBe("queued")
    const said = (await m.meta.listJobMessages(job.id)).map((x) => x.body_md)
    expect(said.filter((b) => b === HELD_FOR_BUDGET)).toHaveLength(1)
    await m.meta.deletePlan(plan.id, "default")
    await m.passUntil(() => m.ortam.launches.length > 0)
    expect(m.ortam.launches).toHaveLength(1)
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
