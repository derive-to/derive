import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ArtifactRecord, type CommentRecord, type DeliveryRecord, newId } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { enqueueSlackMentionDms, makeSlackDmSender, wantsMentionDm } from "../src/lib/slack-dm"

const KEY = "dm-key"
const baseUrl = "https://derive.test"

const freshStore = () =>
  new SqliteMetaStore(join(mkdtempSync(join(tmpdir(), "derive-slackdm-")), "db.sqlite"))

const connect = (meta: SqliteMetaStore) =>
  meta.setSlackInstall({
    org_id: "default",
    team_id: "T1",
    team_name: "Acme",
    bot_token: "xoxb-plain",
    bot_user_id: "UBOT",
    default_channel: "C1",
    created_at: new Date().toISOString(),
  })

// A confirmed-linked workspace member who can be DM'd.
const member = async (meta: SqliteMetaStore, userId: string, slackId: string) => {
  await meta.setMembership({ id: newId("m"), org_id: "default", user_id: userId, role: "editor" })
  await meta.setSlackUserLink({
    id: newId("sul"),
    org_id: "default",
    slack_user_id: slackId,
    user_id: userId,
    status: "confirmed",
    dm_channel_id: null,
    created_at: new Date().toISOString(),
  })
}

const artifactAndComment = async (meta: SqliteMetaStore) => {
  const artifact = (await meta.createArtifact({
    id: newId("a"),
    short_id: newId("s").slice(0, 8),
    org_id: "default",
    slug: null,
    title: "Doc",
    visibility: "link",
    kind: "file",
    spa: 0,
  })) as ArtifactRecord
  const comment = await meta.createComment({
    id: newId("c"),
    artifact_id: artifact.id,
    thread_id: newId("th"),
    base_version: 0,
    path: null,
    anchor: null,
    body_md: "hey @you look here",
    author: "Ada",
    author_id: "u-ada",
  })
  return { artifact, comment: comment as CommentRecord }
}

const claim = (meta: SqliteMetaStore): Promise<DeliveryRecord[]> =>
  meta.claimDueDeliveries(
    new Date(Date.now() + 60_000).toISOString(),
    100,
    new Date(Date.now() + 120_000).toISOString(),
  )

describe("wantsMentionDm", () => {
  it("defaults on; off only when explicitly disabled", () => {
    expect(wantsMentionDm(undefined)).toBe(true)
    expect(wantsMentionDm("{}")).toBe(true)
    expect(wantsMentionDm(JSON.stringify({ slackMentionDm: false }))).toBe(false)
    expect(wantsMentionDm(JSON.stringify({ slackMentionDm: true }))).toBe(true)
    expect(wantsMentionDm("not json")).toBe(true)
  })
})

describe("enqueueSlackMentionDms (gate)", () => {
  it("enqueues a DM for a linked, opted-in member; skips unlinked and opted-out", async () => {
    const meta = freshStore()
    await connect(meta)
    await member(meta, "u-linked", "U-LINK")
    await member(meta, "u-optout", "U-OPT")
    await meta.setUserNotificationPref({
      id: newId("unp"),
      org_id: "default",
      user_id: "u-optout",
      prefs: JSON.stringify({ slackMentionDm: false }),
      created_at: new Date().toISOString(),
    })
    const { artifact, comment } = await artifactAndComment(meta)
    await enqueueSlackMentionDms({ meta, baseUrl }, artifact, comment, [
      { id: "u-linked", name: "Lin" },
      { id: "u-optout", name: "Opt" },
      { id: "u-stranger", name: "Str" }, // not linked
    ])
    const dms = (await claim(meta)).filter((d) => d.kind === "slack_dm")
    expect(dms).toHaveLength(1)
    expect(JSON.parse(dms[0]?.payload ?? "{}").userId).toBe("u-linked")
  })
})

describe("makeSlackDmSender (delivery)", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("opens the DM channel, posts, and caches the channel id on the link", async () => {
    const meta = freshStore()
    await connect(meta)
    await member(meta, "u-linked", "U-LINK")
    const { artifact, comment } = await artifactAndComment(meta)
    await enqueueSlackMentionDms({ meta, baseUrl }, artifact, comment, [
      { id: "u-linked", name: "Lin" },
    ])

    const calls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push(url)
        if (url.endsWith("/conversations.open"))
          return new Response(JSON.stringify({ ok: true, channel: { id: "D-123" } }))
        const body = JSON.parse(init?.body ?? "{}")
        expect(body.channel).toBe("D-123")
        return new Response(JSON.stringify({ ok: true, ts: "1.1", channel: body.channel }))
      }),
    )
    const [row] = (await claim(meta)).filter((d) => d.kind === "slack_dm")
    if (!row) throw new Error("no slack_dm row")
    const res = await makeSlackDmSender(meta, KEY)(row)
    expect(res.ok).toBe(true)
    expect(calls.some((u) => u.endsWith("/conversations.open"))).toBe(true)
    // The opened DM channel is cached so the next DM skips conversations.open.
    expect((await meta.getSlackUserLinkByUser("default", "u-linked"))?.dm_channel_id).toBe("D-123")
  })

  it("is a delivered no-op when the user isn't linked", async () => {
    const meta = freshStore()
    await connect(meta)
    // Enqueue a DM for an unlinked user directly.
    const { enqueueSlackDm } = await import("../src/lib/slack-dm")
    await enqueueSlackDm(meta, "default", "u-nope", "hi", [])
    const [row] = (await claim(meta)).filter((d) => d.kind === "slack_dm")
    if (!row) throw new Error("no slack_dm row")
    const res = await makeSlackDmSender(meta, KEY)(row)
    expect(res.ok).toBe(true)
    expect(res.status).toContain("not linked")
  })
})
