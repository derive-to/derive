import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ArtifactRecord, newId } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { afterAll, describe, expect, it, vi } from "vitest"
import { runSlackReviewAction } from "../src/lib/slack-review"

// Approving from Slack must land in exactly the state `derive approve` or the sidebar button
// would produce — the agent polling catch_up cannot tell which surface settled the round, and
// must not have to. So the permissions mirror routes/review.ts rather than inventing a
// Slack-specific rule: `comment` to send back, `approve` to approve.
const dir = mkdtempSync(join(tmpdir(), "derive-slack-review-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const bus = { publish: () => {}, subscribe: () => () => {} } as never
const noBilling = async () => null

const setup = async (name: string, opts: { role?: string; link?: boolean } = {}) => {
  const meta = new SqliteMetaStore(join(dir, `${name}.db`))
  const artifact = await meta.createArtifact({
    id: newId("a"),
    short_id: newId("s").slice(0, 8),
    org_id: "default",
    slug: null,
    title: "Doc",
    workspace_access: "member",
    link_role: "none",
    listed: "workspace",
    kind: "file",
    spa: 0,
  })
  if (opts.link !== false)
    await meta.setSlackUserLink({
      id: newId("sul"),
      org_id: "default",
      user_id: "u-1",
      team_id: "T1",
      slack_user_id: "U1",
      created_at: new Date().toISOString(),
    })
  if (opts.role)
    await meta.setMembership({
      id: newId("mem"),
      org_id: "default",
      user_id: "u-1",
      role: opts.role as "owner",
    })
  const round = await meta.createReviewRound({
    id: newId("rr"),
    artifact_id: artifact.id,
    version: 1,
    requested_by: "ag-1",
    requested_for: "u-1",
    note: null,
  })
  return { meta, artifact: artifact as ArtifactRecord, round }
}

const run = (
  meta: SqliteMetaStore,
  artifact: ArtifactRecord,
  op: "approve" | "send_back",
  sent: string[],
) => {
  vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
    sent.push(String((JSON.parse(String(init.body)) as { text?: string }).text ?? ""))
    return new Response("ok", { status: 200 })
  })
  return runSlackReviewAction(
    { meta: meta as never, bus, billingBlocked: noBilling },
    {
      teamId: "T1",
      slackUserId: "U1",
      artifact,
      op,
      responseUrl: "https://hooks.slack.test/x",
    },
  )
}

describe("runSlackReviewAction", () => {
  it("approves as the linked account, settling the round", async () => {
    const { meta, artifact, round } = await setup("approve-ok", { role: "owner" })
    const sent: string[] = []
    await run(meta, artifact, "approve", sent)
    expect(await meta.getPendingRound(artifact.id)).toBeNull()
    const rounds = await meta.listReviewRounds(artifact.id)
    expect(rounds.find((r) => r.id === round.id)?.state).toBe("approved")
    expect(sent.join(" ")).toContain("Approved")
  })

  it("sends back on a comment-level role, which may not approve", async () => {
    const { meta, artifact, round } = await setup("sendback-ok", { role: "commenter" })
    const sent: string[] = []
    await run(meta, artifact, "send_back", sent)
    const rounds = await meta.listReviewRounds(artifact.id)
    expect(rounds.find((r) => r.id === round.id)?.state).toBe("sent_back")

    const second = await setup("approve-denied", { role: "commenter" })
    const denied: string[] = []
    await run(second.meta, second.artifact, "approve", denied)
    expect(denied.join(" ")).toContain("permission")
    expect(await second.meta.getPendingRound(second.artifact.id)).not.toBeNull()
  })

  // No Derive principal ⇒ nothing to authorize against. Same prompt the proposal buttons give.
  it("refuses an unlinked clicker", async () => {
    const { meta, artifact } = await setup("no-link", { role: "owner", link: false })
    const sent: string[] = []
    await run(meta, artifact, "approve", sent)
    expect(sent.join(" ")).toContain("Link your Slack account")
    expect(await meta.getPendingRound(artifact.id)).not.toBeNull()
  })

  // The card may have been rendered minutes ago; the round can be settled from Derive meanwhile.
  it("says so when the round is already gone, rather than acting", async () => {
    const { meta, artifact, round } = await setup("already", { role: "owner" })
    await meta.resolveReviewRound(round.id, { state: "approved", note: null })
    const sent: string[] = []
    await run(meta, artifact, "approve", sent)
    expect(sent.join(" ")).toContain("no review pending")
  })

  it("honours the billing gate on approve only", async () => {
    const { meta, artifact } = await setup("billing", { role: "owner" })
    const sent: string[] = []
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      sent.push(String((JSON.parse(String(init.body)) as { text?: string }).text ?? ""))
      return new Response("ok", { status: 200 })
    })
    await runSlackReviewAction(
      {
        meta: meta as never,
        bus,
        billingBlocked: async () => ({ code: "past_due", message: "Billing is past due." }),
      },
      {
        teamId: "T1",
        slackUserId: "U1",
        artifact,
        op: "approve",
        responseUrl: "https://hooks.slack.test/x",
      },
    )
    expect(sent.join(" ")).toContain("past due")
    expect(await meta.getPendingRound(artifact.id)).not.toBeNull()
  })
})
