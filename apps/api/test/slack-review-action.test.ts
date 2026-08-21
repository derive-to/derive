import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ArtifactRecord, newId } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { afterAll, describe, expect, it, vi } from "vitest"
import { runSlackReviewAction } from "../src/lib/slack-review"

// Sending back from Slack must land in exactly the state `derive send-back` or the sidebar
// button would produce — the agent polling catch_up cannot tell which surface settled the
// round, and must not have to. So the permissions mirror routes/review.ts rather than
// inventing a Slack-specific rule: `comment` standing, because answering is collaboration.
const dir = mkdtempSync(join(tmpdir(), "derive-slack-review-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const bus = { publish: () => {}, subscribe: () => () => {} } as never

const setup = async (
  name: string,
  opts: { role?: string; link?: boolean; origin?: "oauth" | "email" } = {},
) => {
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
      origin: opts.origin ?? "oauth",
      checked_at: new Date().toISOString(),
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

const run = (meta: SqliteMetaStore, artifact: ArtifactRecord, sent: string[]) => {
  vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
    sent.push(String((JSON.parse(String(init.body)) as { text?: string }).text ?? ""))
    return new Response("ok", { status: 200 })
  })
  return runSlackReviewAction(
    { meta: meta as never, bus },
    {
      teamId: "T1",
      slackUserId: "U1",
      artifact,
      responseUrl: "https://hooks.slack.test/x",
    },
  )
}

describe("runSlackReviewAction", () => {
  it("sends back as the linked account, settling the round with who decided", async () => {
    const { meta, artifact, round } = await setup("sendback-ok", { role: "commenter" })
    const sent: string[] = []
    await run(meta, artifact, sent)
    expect(await meta.getPendingRound(artifact.id)).toBeNull()
    const rounds = await meta.listReviewRounds(artifact.id)
    const settled = rounds.find((r) => r.id === round.id)
    expect(settled?.state).toBe("sent_back")
    expect(settled?.resolved_by).toBe("u-1")
    expect(sent.join(" ")).toContain("Sent back")
  })

  it("refuses a clicker with no comment standing", async () => {
    const { meta, artifact } = await setup("no-standing")
    const sent: string[] = []
    await run(meta, artifact, sent)
    expect(sent.join(" ")).toContain("permission")
    expect(await meta.getPendingRound(artifact.id)).not.toBeNull()
  })

  // An email match says who somebody probably is. Settling a round is recorded as their
  // decision and unblocks a build, so it needs the deliberate link — see lib/slack-identity.ts.
  it("refuses an email-matched identity, and says how to fix it", async () => {
    const { meta, artifact } = await setup("email-origin", { role: "owner", origin: "email" })
    const sent: string[] = []
    await run(meta, artifact, sent)
    expect(sent.join(" ")).toContain("Settings → Integrations")
    expect(await meta.getPendingRound(artifact.id)).not.toBeNull()
  })

  // No Derive principal ⇒ nothing to authorize against.
  it("refuses an unlinked clicker", async () => {
    const { meta, artifact } = await setup("no-link", { role: "owner", link: false })
    const sent: string[] = []
    await run(meta, artifact, sent)
    expect(sent.join(" ")).toContain("Settings → Integrations")
    expect(sent.join(" ")).not.toContain("from your email")
    expect(await meta.getPendingRound(artifact.id)).not.toBeNull()
  })

  // The card may have been rendered minutes ago; the round can be settled from Derive meanwhile.
  it("says so when the round is already gone, rather than acting", async () => {
    const { meta, artifact, round } = await setup("already", { role: "owner" })
    await meta.resolveReviewRound(round.id, { state: "sent_back", note: null })
    const sent: string[] = []
    await run(meta, artifact, sent)
    expect(sent.join(" ")).toContain("no review pending")
  })
})
