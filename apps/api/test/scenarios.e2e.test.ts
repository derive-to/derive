import { drainRuns, submitRevision } from "@derive/hosted-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// The three driving scenarios (Context Kits doc), end to end with the REAL stack:
// real routes, real store, real autonomy gate, real publish handler (tags, private
// drafts, review rounds), real run queue + ledger — the executor loop (drainRuns)
// included. Only two things are stand-ins, both by design:
//   - the MODEL: runOne is injected and plays the agent (the designed test seam);
//   - the SCHEDULE TICK: "run now" enqueues, standing in for the deployment cron.
// The scheduled scenarios iterate 3 times to prove the loop compounds: values move,
// versions stack, proposals accumulate, editions land in the tag archive.

const owner: TestUser = { id: "u_scn_own", email: "scn@derive.test", name: "Owner" }
const { app } = makeAuthedApp("scenarios", [owner])

// Route the executor's HTTP straight into the in-process app: a TRUE wire-shape
// test (methods, headers, multipart bodies) without a listening socket.
const shimFetch = () =>
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    return app.request(u.pathname + u.search, init)
  })
afterEach(() => vi.unstubAllGlobals())

const publish = async (title: string, content: string, shortId?: string) => {
  const res = await publishAs(app, content, { title }, as(owner.email), shortId)
  expect(res.status).toBeLessThan(300)
  return (await res.json()) as { short_id: string }
}
const detail = async (shortId: string) =>
  (await (await app.request(`/v1/artifacts/${shortId}`, { headers: as(owner.email) })).json()) as {
    tags: string[]
    current_version: number
  }
const mintAgent = async (name: string) => {
  // Editor seat: the live-publish lane needs it (the default commenter seat is
  // propose-only — the gate's `auto` decisions would 403 at the publish handler).
  const res = await app.request("/v1/agents", jsonAs(as(owner.email), { name, role: "editor" }))
  return (await res.json()) as { id: string; token: string }
}
const createAutomation = async (body: object) => {
  const res = await app.request("/v1/automations", jsonAs(as(owner.email), body))
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}
const runNow = async (id: string) => {
  const res = await app.request(`/v1/automations/${id}/run`, {
    method: "POST",
    headers: as(owner.email),
  })
  expect(res.status).toBe(201)
}
const ledger = async () => {
  const res = await app.request("/v1/workspace/runs", { headers: as(owner.email) })
  const { runs } = (await res.json()) as {
    runs: { automation_id: string | null; status: string; meta: string | null }[]
  }
  return runs.map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }))
}
// drainRuns intentionally swallows a run's throw (best-effort per run); surface it
// here so a failing scenario names its real error instead of "finished: 0".
const drain = (token: string, runOne: NonNullable<Parameters<typeof drainRuns>[0]["runOne"]>) =>
  drainRuns({
    server: "http://derive.internal",
    agentToken: token,
    manifest: "You are this workspace's agent.",
    resolveModel: () => ({}) as never,
    runOne: async (ctx, task) => {
      try {
        await runOne(ctx, task)
      } catch (e) {
        console.error("scenario runOne failed:", e)
        throw e
      }
    },
  })

describe("scenario 1 — the automation pass: nightly test runs keep a results doc current", async () => {
  // Flip the workspace opt-in so `auto` may live-publish (always with a review round).
  await app.request("/v1/workspace/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...as(owner.email) },
    body: JSON.stringify({ agentAutoEnabled: true }),
  })

  it("three nightly iterations: freshness updates publish LIVE, tag-stamped, all in the ledger", async () => {
    shimFetch()
    const plan = await publish(
      "Test Plan",
      "# Test Plan\n\n1. pricing page links resolve\n2. api docs match the spec\n3. signup copy on brand",
    )
    // The results doc is published WITH its structure — the sample IS the spec — so
    // nightly runs only move values in place (the freshness lane).
    const results = await publish(
      "Test Results",
      "# Test Results\n\nSuite: production checks\nPassed: 0/3\nLast run: never\nNotes: nightly automation",
    )
    const agent = await mintAgent("Nightly Runner")
    const auto = await createAutomation({
      agentId: agent.id,
      trigger: { kind: "schedule", cron: "0 2 * * *", tz: "UTC" },
      instruction: `Run every check in the test plan (${plan.short_id}); update the results doc.`,
      refs: [results.short_id, { kind: "tag", tag: "test-run" }],
      route: "auto",
    })

    for (let night = 1; night <= 3; night += 1) {
      await runNow(auto.id) // the schedule tick stand-in
      const res = await drain(agent.token, async (ctx, task) => {
        // The "model": reads the plan named in the task, then refreshes the results.
        expect(task).toContain(results.short_id)
        expect(task).toContain("tagged automatically: test-run")
        const planText = await ctx.client.read(plan.short_id)
        expect(planText).toContain("pricing page links")
        await submitRevision(ctx, {
          shortId: results.short_id,
          content: `# Test Results\n\nSuite: production checks\nPassed: 3/3\nLast run: night ${night}\nNotes: nightly automation`,
          filename: "results.md",
          confidence: 0.95,
          message: `nightly run ${night}`,
        })
      })
      expect(res).toMatchObject({ claimed: 1, finished: 1, failed: 0 })
    }

    // Three nights → three LIVE versions on top of v1, stamped with the archive tag.
    const doc = await detail(results.short_id)
    expect(doc.current_version).toBe(4)
    expect(doc.tags).toContain("test-run")
    // The ledger tells the same story: 3 succeeded runs, each with exactly one
    // published write of this doc.
    const rows = (await ledger()).filter((r) => r.automation_id === auto.id)
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.status).toBe("succeeded")
      expect(r.meta.outcome).toBe("published")
      expect(r.meta.writes).toEqual([
        { short_id: results.short_id, decision: "live_publish_with_review", created: false },
      ])
    }
  })
})

describe("scenario 2 — the client walkthrough: authored page, then a freshness automation", () => {
  it("a run bumps the stale date live (v2) — the review loop rides along", async () => {
    shimFetch()
    const page = await publish(
      "Acme onboarding walkthrough",
      "<h1>Acme onboarding</h1>\n<p>Step 1: connect your account</p>\n<p>Updated: 2026-07-01</p>",
    )
    const agent = await mintAgent("Concierge")
    const auto = await createAutomation({
      agentId: agent.id,
      trigger: { kind: "manual" },
      instruction: "Verify facts and dates on the walkthrough are current.",
      refs: [page.short_id],
      route: "auto",
    })
    await runNow(auto.id)
    const res = await drain(agent.token, async (ctx) => {
      const current = await ctx.client.read(page.short_id)
      await submitRevision(ctx, {
        shortId: page.short_id,
        content: current.replace("Updated: 2026-07-01", "Updated: 2026-07-23"),
        filename: "index.html",
        confidence: 1,
        message: "date refresh",
      })
    })
    expect(res).toMatchObject({ claimed: 1, finished: 1 })
    expect((await detail(page.short_id)).current_version).toBe(2)
    const row = (await ledger()).find((r) => r.automation_id === auto.id)
    expect(row?.meta.outcome).toBe("published")
  })
})

describe("scenario 3 — customer health: weekly digest through review, editions in a tag archive", () => {
  it("three weeks: propose the digest, human approves week 1, week 2 builds on it; editions stamp into the archive", async () => {
    shimFetch()
    const health = await publish(
      "Customer Health",
      "# Customer Health\n\nAccounts: Acme, Globex\nCadence: weekly\n",
    )
    const agent = await mintAgent("Health Tracker")
    const auto = await createAutomation({
      agentId: agent.id,
      trigger: { kind: "schedule", cron: "0 9 * * 1", tz: "UTC" },
      instruction: "Run the weekly health pass: update the doc, file this week's edition.",
      refs: [health.short_id, { kind: "tag", tag: "weekly-health" }],
      route: "proposal", // the review round IS the weekly digest read
    })

    const seenByModel: string[] = []
    for (let week = 1; week <= 3; week += 1) {
      await runNow(auto.id)
      const res = await drain(agent.token, async (ctx) => {
        // Two writes in one run (budget 3): revise the living doc + file the edition.
        const current = await ctx.client.read(health.short_id)
        seenByModel.push(current)
        await submitRevision(ctx, {
          shortId: health.short_id,
          content: `${current}\n## Week ${week}\nAcme: churn risk ${week === 1 ? "flagged" : "tracking"}\n`,
          filename: "health.md",
          confidence: 0.85,
          message: `week ${week} digest`,
        })
        await submitRevision(ctx, {
          title: `Customer Health — Week ${week}`,
          content: `# Week ${week}\n\nAcme churn risk; Globex steady.`,
          filename: "week.md",
          confidence: 0.85,
          message: `week ${week} edition`,
        })
      })
      expect(res).toMatchObject({ claimed: 1, finished: 1, failed: 0 })

      // After week 1, the human approves the digest proposal — so week 2's read of the
      // living doc INCLUDES week 1. The iteration genuinely compounds through review.
      if (week === 1) {
        const list = (await (
          await app.request(`/v1/artifacts/${health.short_id}/proposals`, {
            headers: as(owner.email),
          })
        ).json()) as { proposals: { id: string; state: string }[] }
        const open = list.proposals.find((p) => p.state === "open")
        expect(open).toBeTruthy()
        const approved = await app.request(
          `/v1/artifacts/${health.short_id}/proposals/${open?.id}/approve`,
          { method: "POST", headers: as(owner.email) },
        )
        expect(approved.status).toBeLessThan(300)
      }
    }

    // Week 2 read the doc AFTER week 1's approval — the compounding assertion.
    expect(seenByModel[1]).toContain("## Week 1")
    // Weeks 2+3 digests remain open proposals (the unread digests); week 1 approved.
    const list = (await (
      await app.request(`/v1/artifacts/${health.short_id}/proposals`, {
        headers: as(owner.email),
      })
    ).json()) as { proposals: { state: string }[] }
    expect(list.proposals).toHaveLength(3)
    expect(list.proposals.filter((p) => p.state === "approved")).toHaveLength(1)
    expect(list.proposals.filter((p) => p.state === "open")).toHaveLength(2)

    // The tag archive: three private-draft editions, each stamped weekly-health at
    // creation. The living doc is NOT tagged — its writes were proposals, and stamps
    // describe LIVE state only.
    const archive = (await (
      await app.request("/v1/artifacts?tag=weekly-health", { headers: as(owner.email) })
    ).json()) as { artifacts: { short_id: string }[] }
    expect(archive.artifacts).toHaveLength(3)
    expect((await detail(health.short_id)).tags).not.toContain("weekly-health")

    // Ledger: each weekly run recorded BOTH writes — the digest proposal and the
    // created edition — with the run outcome being the most consequential write.
    const rows = (await ledger()).filter((r) => r.automation_id === auto.id)
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.meta.outcome).toBe("proposed")
      expect(r.meta.writes).toHaveLength(2)
      expect(r.meta.writes[1].created).toBe(true)
    }
  })
})
