import { newId } from "@derive/core"
import { describe, expect, it } from "vitest"
import { createInProcessBackplane, type DeriveEvent } from "../src/bus"
import { catalogOf } from "../src/lib/model-catalog"
import { TURN_TOO_LONG } from "../src/lib/turn-core"
import { as, jsonAs, makeAuthedApp, publishAs } from "./helpers"

// @derive IN A COMMENT: mention it in a thread, and the answer lands in that thread.
//
// Driven through the REAL comment route, so the mention parsing, the fan-out chokepoint, the
// gates and the turn all run — only the model is scripted.

const revision = (content: string) =>
  `<revision>${JSON.stringify({ content, filename: "doc.md", confidence: 0.95, message: "tightened" })}</revision>`

const setup = async (
  name: string,
  reply: string,
  opts: { costUsd?: number; budgetMs?: number; hang?: boolean } = {},
) => {
  const users = [
    { id: "u-own", email: "own@x.com", name: "Owner" },
    { id: "u-two", email: "two@x.com", name: "Second" },
  ]
  const backplane = createInProcessBackplane()
  const { app, meta } = makeAuthedApp(name, users, undefined, {
    deps: {
      backplane,
      attendedTurnBudgetMs: opts.budgetMs,
      models: catalogOf([
        {
          id: "m1",
          label: "M1",
          isDefault: true,
          build: () => async () => {
            if (opts.hang) await new Promise(() => {})
            return { text: reply, toolUses: [], costUsd: opts.costUsd ?? null, done: true }
          },
        },
      ]),
    },
  })
  await meta.setOrgSettings("default", {
    ...(await meta.getOrgSettings("default")),
  })
  const doc = (await (
    await publishAs(
      app,
      "# Pricing\n\nSeats are billed annually.",
      { title: "Pricing" },
      as("own@x.com"),
    )
  ).json()) as { short_id: string }
  return { app, meta, doc, backplane }
}

/** The Derive jobs a person sees as theirs: where a mention's cost is recorded. */
const deriveJobs = async (app: Awaited<ReturnType<typeof setup>>["app"], who: string) =>
  (
    (await (await app.request("/v1/jobs?mine=1", { headers: as(who) })).json()) as {
      jobs: { agent_id: string; status: string; cost_micro_usd: number | null; subject: unknown }[]
    }
  ).jobs.filter((j) => j.agent_id === "derive")

/** Comment on the doc, mentioning whoever `mentions` names, then wait for a reply to land. */
const mention = async (
  app: Awaited<ReturnType<typeof setup>>["app"],
  meta: Awaited<ReturnType<typeof setup>>["meta"],
  shortId: string,
  body: string,
  mentions: { id: string; name: string }[],
  who = "own@x.com",
) => {
  const res = await app.request(
    `/v1/artifacts/${shortId}/comments`,
    jsonAs(as(who), { body_md: body, mentions, thread_id: newId("t") }),
  )
  const created = (await res.json()) as { thread_id: string; artifact_id: string }
  for (let i = 0; i < 100; i++) {
    const all = await meta.listComments(created.artifact_id, { threadId: created.thread_id })
    if (all.some((c) => c.author_id === "derive")) return { res, created, all }
    await new Promise((r) => setTimeout(r, 20))
  }
  return {
    res,
    created,
    all: await meta.listComments(created.artifact_id, { threadId: created.thread_id }),
  }
}

const DERIVE = [{ id: "derive", name: "Derive" }]

describe("@derive in a comment thread", () => {
  it("answers in the thread, as Derive, and open pages hear the answer arrive", async () => {
    const { app, meta, doc, backplane } = await setup("cm-answer", "Annually, per the Pricing doc.")
    const artifactId = (await meta.getByShortId(doc.short_id))?.id ?? ""
    const seen: DeriveEvent[] = []
    backplane.subscribe(artifactId, (e) => seen.push(e))
    const { all } = await mention(app, meta, doc.short_id, "@derive how are seats billed?", DERIVE)
    const answer = all.at(-1)
    expect(answer?.author_id).toBe("derive")
    expect(answer?.author).toBe("Derive")
    expect(answer?.body_md).toContain("Annually")
    // Same thread — an answer to a question in a thread belongs in it, not as a new one.
    expect(answer?.thread_id).toBe(all[0]?.thread_id)
    // The answer lands after the mention's own response, so it signals on its own: one for
    // the question, one for the answer. Without the second, an open page never shows it.
    expect(seen.filter((e) => e.type === "comment.created")).toHaveLength(2)
  })

  it("counts what a mention spends toward the monthly budget", async () => {
    const { app, meta, doc } = await setup("cm-spend", "Annually.", { costUsd: 0.01 })
    await meta.createPlan({
      id: newId("plan"),
      org_id: "default",
      user_id: null,
      kind: "model",
      provider: "anthropic",
      secret_enc: "enc",
      limits: JSON.stringify({ monthlyMicroUsd: 5_000 }),
    })
    const first = await mention(app, meta, doc.short_id, "@derive how are seats billed?", DERIVE)
    expect(first.all.some((c) => c.author_id === "derive")).toBe(true)
    // The spend is on a Derive job of the asker's own, which is not a page ask.
    const [job] = await deriveJobs(app, "own@x.com")
    expect(job).toMatchObject({ status: "succeeded", cost_micro_usd: 10_000, subject: null })
    // That answer spent past the limit, so the next mention gets no turn.
    const second = await mention(app, meta, doc.short_id, "@derive and monthly?", DERIVE)
    expect(second.all.some((c) => c.author_id === "derive")).toBe(false)
  })

  it("a turn past its time budget says so in the thread rather than going silent", async () => {
    const { app, meta, doc } = await setup("cm-budget-time", "never", { hang: true, budgetMs: 50 })
    const { all } = await mention(app, meta, doc.short_id, "@derive summarize this", DERIVE)
    expect(all.at(-1)).toMatchObject({ author_id: "derive", body_md: TURN_TOO_LONG })
    const [job] = await deriveJobs(app, "own@x.com")
    expect(job?.status).toBe("failed")
  })

  it("SURFACES the change in the thread rather than publishing — mentions never write", async () => {
    const { app, meta, doc } = await setup("cm-suggest", revision("# Pricing\n\nAnnual seats."))
    const before = (await meta.getByShortId(doc.short_id))?.current_version
    const { all } = await mention(app, meta, doc.short_id, "@derive tighten this", DERIVE)
    // The document is never written from a comment — the drafted change IS the reply.
    expect((await meta.getByShortId(doc.short_id))?.current_version).toBe(before)
    const answer = all.at(-1)
    expect(answer?.author).toBe("Derive")
    expect(answer?.body_md ?? "").toContain("# Pricing")
  })

  it("never answers its own reply — the recursion guard", async () => {
    const { app, meta, doc } = await setup("cm-loop", "hello back")
    const { created, all } = await mention(app, meta, doc.short_id, "@derive hi", DERIVE)
    const first = all.filter((c) => c.author_id === "derive").length
    // A Derive-authored comment that itself named Derive would be an infinite thread; the
    // guard is authorship, so this is the shape that would loop if it were missing.
    await new Promise((r) => setTimeout(r, 150))
    const after = (
      await meta.listComments(created.artifact_id, { threadId: created.thread_id })
    ).filter((c) => c.author_id === "derive").length
    expect(after).toBe(first)
    expect(after).toBe(1)
  })
  it("stays silent once the workspace has spent its monthly model budget", async () => {
    const { app, meta, doc } = await setup("cm-budget", "should not be sent")
    // The workspace pool's monthly limit, and a job this month that already spent past it.
    await meta.createPlan({
      id: newId("plan"),
      org_id: "default",
      user_id: null,
      kind: "model",
      provider: "anthropic",
      secret_enc: "enc",
      limits: JSON.stringify({ monthlyMicroUsd: 1_000 }),
    })
    const agent = (await (
      await app.request("/v1/agents", jsonAs(as("own@x.com"), { name: "Spender" }))
    ).json()) as { id: string }
    const job = (await (
      await app.request(
        "/v1/jobs",
        jsonAs(as("own@x.com"), { agent_id: agent.id, instruction: "Spend" }),
      )
    ).json()) as { id: string }
    await meta.addJobCost(job.id, 5_000)
    const { all } = await mention(app, meta, doc.short_id, "@derive how are seats billed?", DERIVE)
    expect(all.some((c) => c.author_id === "derive")).toBe(false)
  })
})
