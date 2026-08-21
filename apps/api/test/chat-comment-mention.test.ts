import { newId } from "@derive/core"
import { describe, expect, it } from "vitest"
import { catalogOf } from "../src/lib/model-catalog"
import { as, jsonAs, makeAuthedApp, publishAs } from "./helpers"

// @derive IN A COMMENT: mention it in a thread, and the answer lands in that thread.
//
// Driven through the REAL comment route, so the mention parsing, the fan-out chokepoint, the
// gates and the turn all run — only the model is scripted.

const revision = (content: string) =>
  `<revision>${JSON.stringify({ content, filename: "doc.md", confidence: 0.95, message: "tightened" })}</revision>`

const setup = async (name: string, reply: string, opts?: { chatBeta?: boolean }) => {
  const users = [
    { id: "u-own", email: "own@x.com", name: "Owner" },
    { id: "u-two", email: "two@x.com", name: "Second" },
  ]
  const { app, meta } = makeAuthedApp(name, users, undefined, {
    deps: {
      models: catalogOf([
        {
          id: "m1",
          label: "M1",
          isDefault: true,
          build: () => async () => ({ text: reply, toolUses: [], costUsd: null, done: true }),
        },
      ]),
    },
  })
  await meta.setOrgSettings("default", {
    ...(await meta.getOrgSettings("default")),
    chatBeta: opts?.chatBeta ?? true,
  })
  const doc = (await (
    await publishAs(
      app,
      "# Pricing\n\nSeats are billed annually.",
      { title: "Pricing" },
      as("own@x.com"),
    )
  ).json()) as { short_id: string }
  return { app, meta, doc }
}

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
  it("answers in the thread, as Derive", async () => {
    const { app, meta, doc } = await setup("cm-answer", "Annually, per the Pricing doc.")
    const { all } = await mention(app, meta, doc.short_id, "@derive how are seats billed?", DERIVE)
    const answer = all.at(-1)
    expect(answer?.author_id).toBe("derive")
    expect(answer?.author).toBe("Derive")
    expect(answer?.body_md).toContain("Annually")
    // Same thread — an answer to a question in a thread belongs in it, not as a new one.
    expect(answer?.thread_id).toBe(all[0]?.thread_id)
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

  it("does not answer when the workspace has not enabled chat", async () => {
    const { app, meta, doc } = await setup("cm-off", "should not appear", { chatBeta: false })
    const { created } = await mention(app, meta, doc.short_id, "@derive hello", DERIVE)
    const all = await meta.listComments(created.artifact_id, { threadId: created.thread_id })
    expect(all.filter((c) => c.author_id === "derive")).toHaveLength(0)
    // The comment itself still posted: a disabled feature must not swallow someone's comment.
    expect(all).toHaveLength(1)
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
})
