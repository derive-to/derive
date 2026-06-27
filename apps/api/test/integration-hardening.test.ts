import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type DeliveryRecord, newId } from "@dock/core"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { afterAll, describe, expect, it } from "vitest"
import { buildMime } from "../src/email-cf"
import { isCollaboratorAuthor } from "../src/lib/comments"
import { type ChannelSendResult, enqueueChannelDelivery, runDeliveryTick } from "../src/webhooks"

const dir = mkdtempSync(join(tmpdir(), "dock-harden-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("collaborator-author gate (external fan-out)", () => {
  const meta = new SqliteMetaStore(join(dir, "collab.sqlite"))
  it("trusts a workspace member, an artifact-share recipient, and an agent; rejects others", async () => {
    const artifact = await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s").slice(0, 8),
      org_id: "org1",
      slug: null,
      title: "Doc",
      visibility: "link",
      kind: "file",
      spa: 0,
    })
    await meta.setMembership({ id: newId("m"), org_id: "org1", user_id: "member1", role: "editor" })
    await meta.setArtifactMember({
      id: newId("am"),
      artifact_id: artifact.id,
      user_id: "shared1",
      role: "commenter",
      // biome-ignore lint/suspicious/noExplicitAny: NewArtifactMember shape varies by dialect
    } as any)
    const agent = await meta.createAgent({
      id: newId("ag"),
      org_id: "org1",
      name: "bot",
      token: newId("tok"),
      role: "commenter",
      // biome-ignore lint/suspicious/noExplicitAny: NewAgent optional fields
    } as any)

    expect(await isCollaboratorAuthor(meta, artifact, "member1")).toBe(true)
    expect(await isCollaboratorAuthor(meta, artifact, "shared1")).toBe(true)
    expect(await isCollaboratorAuthor(meta, artifact, agent.id)).toBe(true)
    expect(await isCollaboratorAuthor(meta, artifact, "stranger")).toBe(false)
    expect(await isCollaboratorAuthor(meta, artifact, null)).toBe(false)
  })
})

describe("permanent-failure dead-lettering", () => {
  const meta = new SqliteMetaStore(join(dir, "perm.sqlite"))
  const claimAll = (): Promise<DeliveryRecord[]> =>
    meta.claimDueDeliveries(
      new Date(Date.now() + 600_000).toISOString(),
      100,
      new Date(Date.now() + 700_000).toISOString(),
    )

  it("dead-letters a permanent failure on the first attempt instead of retrying", async () => {
    await enqueueChannelDelivery(meta, "slack_app", "comment.created", { x: 1 })
    const permanentSender = async (): Promise<ChannelSendResult> => ({
      ok: false,
      status: "channel_not_found",
      permanent: true,
    })
    await runDeliveryTick(meta, { precheck: async () => null }, { slack_app: permanentSender })
    // Re-claiming with a far-future cutoff would surface any still-pending row; a dead
    // row is excluded, proving it didn't schedule a retry.
    const stillDue = await claimAll()
    expect(stillDue).toHaveLength(0)
  })

  it("retries a transient failure (stays pending for a later attempt)", async () => {
    await enqueueChannelDelivery(meta, "email", "comment.created", { y: 2 })
    const transientSender = async (): Promise<ChannelSendResult> => ({ ok: false, status: "503" })
    await runDeliveryTick(meta, { precheck: async () => null }, { email: transientSender })
    // The row is rescheduled (next_attempt_at in the future) — claimable again with a
    // far-future cutoff, but NOT dead.
    const due = (await claimAll()).filter((d) => d.kind === "email")
    expect(due).toHaveLength(1)
    expect(due[0]?.status).toBe("pending")
  })
})

describe("email header-injection defense", () => {
  it("strips CR/LF from header values so an author/title can't inject headers", () => {
    const mime = buildMime(
      "Dock <notifications@dock.build>",
      {
        to: "victim@x.com\r\nBcc: attacker@evil.com",
        subject: "hi\r\nBcc: attacker@evil.com",
        html: "<p>body</p>",
        text: "body",
      },
      "2026-06-20T00:00:00.000Z",
      "abc123",
    )
    const headerLines = (mime.split("\r\n\r\n")[0] ?? "").split("\r\n")
    // No injected header: the CRLF was flattened, so nothing is a standalone Bcc: line.
    expect(headerLines.some((l) => /^bcc:/i.test(l))).toBe(false)
    // Exactly the headers we wrote — no extra lines smuggled in via newlines.
    expect(headerLines.filter((l) => /^to:/i.test(l))).toHaveLength(1)
    expect(headerLines.filter((l) => /^subject:/i.test(l))).toHaveLength(1)
    expect(mime).toContain("victim@x.com")
  })
})
