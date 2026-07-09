import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ArtifactRecord, DEFAULT_ORG_SETTINGS, type DeliveryRecord, newId } from "@derive/core"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  enqueueSlackEvent,
  makeSlackEventSender,
  resolveSlackChannel,
} from "../src/lib/slack-events"

const KEY = "test-encryption-key"
const baseUrl = "https://derive.test"

const freshStore = () =>
  new SqliteMetaStore(join(mkdtempSync(join(tmpdir(), "derive-slackev-")), "db.sqlite"))

const makeArtifact = (meta: SqliteMetaStore) =>
  meta.createArtifact({
    id: newId("a"),
    short_id: newId("s").slice(0, 8),
    org_id: "default",
    slug: null,
    title: "Doc",
    link_role: "viewer",
    kind: "file",
    spa: 0,
  }) as Promise<ArtifactRecord>

const connectSlack = (meta: SqliteMetaStore, channel: string | null = "C1") =>
  meta.setSlackInstall({
    org_id: "default",
    team_id: "T1",
    team_name: "Acme",
    bot_token: "xoxb-plain", // decryptSecret passes non-"v1." blobs through unchanged
    bot_user_id: "UBOT",
    default_channel: channel,
    created_at: new Date().toISOString(),
  })

const claim = (meta: SqliteMetaStore): Promise<DeliveryRecord[]> =>
  meta.claimDueDeliveries(
    new Date(Date.now() + 60_000).toISOString(),
    100,
    new Date(Date.now() + 120_000).toISOString(),
  )

describe("enqueueSlackEvent (gate)", () => {
  it("enqueues a slack_app_event row for version.published when connected", async () => {
    const meta = freshStore()
    await connectSlack(meta)
    const artifact = await makeArtifact(meta)
    const queued = await enqueueSlackEvent({ meta, baseUrl }, artifact, "version.published", {
      version: 2,
    })
    expect(queued).toBe(true)
    const rows = await claim(meta)
    expect(rows.map((r) => r.kind)).toContain("slack_app_event")
    expect(rows.find((r) => r.kind === "slack_app_event")?.event_type).toBe("version.published")
  })

  it("does not enqueue when Slack is not connected", async () => {
    const meta = freshStore()
    const artifact = await makeArtifact(meta)
    expect(await enqueueSlackEvent({ meta, baseUrl }, artifact, "version.published", {})).toBe(
      false,
    )
  })

  it("does not enqueue for comment.created/mention (mirrored as threads elsewhere)", async () => {
    const meta = freshStore()
    await connectSlack(meta)
    const artifact = await makeArtifact(meta)
    expect(await enqueueSlackEvent({ meta, baseUrl }, artifact, "comment.created", {})).toBe(false)
    expect(await enqueueSlackEvent({ meta, baseUrl }, artifact, "comment.mention", {})).toBe(false)
  })

  it("respects the per-event opt-out toggle", async () => {
    const meta = freshStore()
    await connectSlack(meta)
    await meta.setOrgSettings("default", {
      ...DEFAULT_ORG_SETTINGS,
      slackEvents: { "version.published": false },
    })
    const artifact = await makeArtifact(meta)
    expect(await enqueueSlackEvent({ meta, baseUrl }, artifact, "version.published", {})).toBe(
      false,
    )
    // A different event with no explicit opt-out still fires.
    expect(
      await enqueueSlackEvent({ meta, baseUrl }, artifact, "proposal.created", {
        proposal_id: "p1",
      }),
    ).toBe(true)
  })
})

describe("resolveSlackChannel (routing)", () => {
  it("falls back to the default channel when no routes exist", async () => {
    const meta = freshStore()
    const artifact = await makeArtifact(meta)
    expect(await resolveSlackChannel(meta, "default", artifact.id, "C-def")).toBe("C-def")
  })

  it("a collection route the artifact belongs to wins; else the default route", async () => {
    const meta = freshStore()
    const artifact = await makeArtifact(meta)
    await meta.createCollection({ id: "col-1", org_id: "default", title: "Col", created_by: "u-x" })
    await meta.addCollectionItem("col-1", artifact.id)
    await meta.setSlackChannelRoute({
      id: "scr-def",
      org_id: "default",
      target_type: "default",
      target_id: "",
      channel_id: "C-route-default",
      created_at: new Date().toISOString(),
    })
    // With only a default route, it overrides the install default.
    expect(await resolveSlackChannel(meta, "default", artifact.id, "C-install")).toBe(
      "C-route-default",
    )
    // A collection route for a collection the artifact is in beats the default route.
    await meta.setSlackChannelRoute({
      id: "scr-col",
      org_id: "default",
      target_type: "collection",
      target_id: "col-1",
      channel_id: "C-col",
      created_at: new Date().toISOString(),
    })
    expect(await resolveSlackChannel(meta, "default", artifact.id, "C-install")).toBe("C-col")
  })
})

describe("makeSlackEventSender (delivery)", () => {
  afterEach(() => vi.unstubAllGlobals())

  // Mock Slack's HTTP surface; capture chat.postMessage bodies for assertions.
  const mockSlack = (opts: { failFirstWith?: string } = {}) => {
    const posts: Record<string, unknown>[] = []
    let n = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        if (url.endsWith("/chat.postMessage")) {
          const body = JSON.parse(init?.body ?? "{}")
          posts.push(body)
          n += 1
          if (n === 1 && opts.failFirstWith)
            return new Response(JSON.stringify({ ok: false, error: opts.failFirstWith }))
          return new Response(JSON.stringify({ ok: true, ts: "1700.5", channel: body.channel }))
        }
        if (url.endsWith("/conversations.join")) return new Response(JSON.stringify({ ok: true }))
        return new Response(JSON.stringify({ ok: false, error: "unexpected" }))
      }),
    )
    return { posts }
  }

  const deliverOne = async (meta: SqliteMetaStore) => {
    const [row] = (await claim(meta)).filter((r) => r.kind === "slack_app_event")
    if (!row) throw new Error("no slack_app_event row enqueued")
    return makeSlackEventSender(meta, KEY)(row)
  }

  it("posts a top-level card to the default channel", async () => {
    const meta = freshStore()
    await connectSlack(meta)
    const artifact = await makeArtifact(meta)
    await enqueueSlackEvent({ meta, baseUrl }, artifact, "version.published", {
      version: 3,
      author: "Ada",
    })
    const { posts } = mockSlack()
    const res = await deliverOne(meta)
    expect(res.ok).toBe(true)
    expect(posts).toHaveLength(1)
    const [post] = posts
    expect(post?.channel).toBe("C1")
    expect(post?.blocks).toBeDefined()
    expect(post?.thread_ts).toBeUndefined()
    expect(String(post?.text)).toContain("v3")
  })

  it("retries text-only when Slack rejects the blocks (invalid_blocks)", async () => {
    const meta = freshStore()
    await connectSlack(meta)
    const artifact = await makeArtifact(meta)
    await enqueueSlackEvent({ meta, baseUrl }, artifact, "proposal.created", {
      proposal_id: "p1",
      author: "Ada",
    })
    const { posts } = mockSlack({ failFirstWith: "invalid_blocks" })
    const res = await deliverOne(meta)
    expect(res.ok).toBe(true)
    expect(posts).toHaveLength(2)
    expect(posts[1]?.blocks).toBeUndefined() // second attempt is text-only
  })

  it("threads comment.resolved under the mirrored thread, and skips when unmirrored", async () => {
    const meta = freshStore()
    await connectSlack(meta)
    const artifact = await makeArtifact(meta)
    const threadId = newId("c")
    await meta.setSlackThreadLink({
      id: newId("stl"),
      org_id: "default",
      artifact_id: artifact.id,
      thread_id: threadId,
      channel: "C-thread",
      message_ts: "root-1",
      created_at: new Date().toISOString(),
    })
    await enqueueSlackEvent({ meta, baseUrl }, artifact, "comment.resolved", {
      state: "resolved",
      thread_id: threadId,
    })
    const { posts } = mockSlack()
    const res = await deliverOne(meta)
    expect(res.ok).toBe(true)
    expect(posts[0]?.channel).toBe("C-thread")
    expect(posts[0]?.thread_ts).toBe("root-1")

    // A resolution for a thread never mirrored to Slack is a delivered no-op (no post).
    await enqueueSlackEvent({ meta, baseUrl }, artifact, "comment.resolved", {
      state: "resolved",
      thread_id: newId("c"),
    })
    const before = posts.length
    const res2 = await deliverOne(meta)
    expect(res2.ok).toBe(true)
    expect(posts.length).toBe(before) // nothing posted
  })

  it("flags the install needs_reauth when Slack rejects the token (invalid_auth)", async () => {
    const meta = freshStore()
    await connectSlack(meta)
    const artifact = await makeArtifact(meta)
    await enqueueSlackEvent({ meta, baseUrl }, artifact, "version.published", { version: 1 })
    mockSlack({ failFirstWith: "invalid_auth" })
    const res = await deliverOne(meta)
    expect(res.ok).toBe(false)
    expect(res.permanent).toBe(true)
    expect((await meta.getSlackInstall("default"))?.needs_reauth).toBe(1)
  })
})
