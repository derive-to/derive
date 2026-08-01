import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newId } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createInProcessBackplane } from "../src/bus"
import { runSlackProposalAction } from "../src/lib/slack-proposal"

// Approving from Slack is editor-level, authorized AS the clicker's LINKED Derive account.
// We use request_changes for the positive path — it decides the proposal without republishing
// a version (no blob), so the test stays focused on the authorization gate.
const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), "slkprop-"))
  const meta = new SqliteMetaStore(join(dir, "db.sqlite"))
  const blobs = new FsBlobStore(join(dir, "blobs"))
  await meta.setMembership({ id: newId("mem"), org_id: "default", user_id: "u-ed", role: "editor" })
  await meta.createArtifact({
    id: "a1",
    short_id: "a1short",
    org_id: "default",
    slug: null,
    title: "Doc",
    workspace_access: "member",
    link_role: "viewer",
    listed: "workspace",
    kind: "file",
    spa: 0,
  })
  await meta.createProposal({
    id: "p1",
    artifact_id: "a1",
    blob_key: "bk",
    content_type: "text/markdown",
    kind: "file",
    author: "Ed",
    base_version: 0,
  })
  await meta.setSlackInstall({
    org_id: "default",
    team_id: "T1",
    team_name: "Acme",
    bot_token: "xoxb",
    bot_user_id: "UBOT",
    created_at: new Date().toISOString(),
  })
  // U1 → editor member; U2 → a linked user who is NOT a member of the workspace.
  await meta.setSlackUserLink({
    id: newId("sul"),
    org_id: "default",
    user_id: "u-ed",
    team_id: "T1",
    slack_user_id: "U1",
    origin: "oauth" as const,
    checked_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  })
  await meta.setSlackUserLink({
    id: newId("sul"),
    org_id: "default",
    user_id: "u-nobody",
    team_id: "T1",
    slack_user_id: "U2",
    origin: "oauth" as const,
    checked_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  })
  const deps = {
    meta,
    blobs,
    bus: createInProcessBackplane(),
    notify: async () => {},
    billingBlocked: async () => null,
  }
  return { meta, deps }
}

const args = (op: "approve" | "request_changes", slackUserId: string) => ({
  teamId: "T1",
  slackUserId,
  proposalId: "p1",
  artifactId: "a1",
  op,
  responseUrl: "https://hooks.slack.test/r",
})

describe("runSlackProposalAction (approve/request-changes from Slack)", () => {
  beforeEach(() =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    ),
  )
  afterEach(() => vi.unstubAllGlobals())

  it("a linked editor's click decides the proposal", async () => {
    const { meta, deps } = await setup()
    await runSlackProposalAction(deps, args("request_changes", "U1"))
    expect((await meta.getProposal("p1"))?.state).toBe("changes_requested")
  })

  it("a linked NON-member is denied (authz gate) — proposal stays open", async () => {
    const { meta, deps } = await setup()
    await runSlackProposalAction(deps, args("request_changes", "U2"))
    expect((await meta.getProposal("p1"))?.state).toBe("open")
  })

  it("an UNLINKED Slack user cannot act — proposal stays open", async () => {
    const { meta, deps } = await setup()
    await runSlackProposalAction(deps, args("request_changes", "U-UNKNOWN"))
    expect((await meta.getProposal("p1"))?.state).toBe("open")
  })
})
