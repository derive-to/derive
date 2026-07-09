import { type ArtifactRecord, type CommentRecord, type DeliveryRecord, newId } from "@derive/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { enqueueSlackMentionDms, makeSlackDmSender, wantsMentionDm } from "../src/lib/slack-dm"
import { quotaApp, type TestUser } from "./helpers"

const KEY = "dm-key"
const baseUrl = "https://derive.test"

const linked: TestUser = { id: "u-linked", email: "lin@x.com", name: "Lin" }
const optout: TestUser = { id: "u-optout", email: "opt@x.com", name: "Opt" }

// Build a store with Slack configured + both members seeded (emails are the DM join key,
// resolved live via users.lookupByEmail — no linking table).
const make = (name: string) => {
  const { meta } = quotaApp(
    name,
    { encryptionKey: KEY, defaultOrgId: "default" },
    [linked, optout],
    [
      { user_id: linked.id, role: "editor" },
      { user_id: optout.id, role: "editor" },
    ],
  )
  return meta
}

const connect = (meta: ReturnType<typeof make>) =>
  meta.setSlackInstall({
    org_id: "default",
    team_id: "T1",
    team_name: "Acme",
    bot_token: "xoxb-plain",
    bot_user_id: "UBOT",
    default_channel: "C1",
    created_at: new Date().toISOString(),
  })

const artifactAndComment = async (meta: ReturnType<typeof make>) => {
  const artifact = (await meta.createArtifact({
    id: newId("a"),
    short_id: newId("s").slice(0, 8),
    org_id: "default",
    slug: null,
    title: "Doc",
    link_role: "viewer",
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

const claim = (meta: ReturnType<typeof make>): Promise<DeliveryRecord[]> =>
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
  it("enqueues a DM for an opted-in member; skips opted-out and non-members", async () => {
    const meta = make("slack-dm-gate")
    await connect(meta)
    await meta.setUserNotificationPref({
      id: newId("unp"),
      org_id: "default",
      user_id: optout.id,
      prefs: JSON.stringify({ slackMentionDm: false }),
      created_at: new Date().toISOString(),
    })
    const { artifact, comment } = await artifactAndComment(meta)
    await enqueueSlackMentionDms({ meta, baseUrl }, artifact, comment, [
      { id: linked.id, name: "Lin" },
      { id: optout.id, name: "Opt" },
      { id: "u-stranger", name: "Str" }, // not a member
    ])
    const dms = (await claim(meta)).filter((d) => d.kind === "slack_dm")
    expect(dms).toHaveLength(1)
    expect(JSON.parse(dms[0]?.payload ?? "{}").userId).toBe(linked.id)
  })
})

describe("makeSlackDmSender (delivery)", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("resolves the user's Slack account by email, opens a DM, and posts", async () => {
    const meta = make("slack-dm-send")
    await connect(meta)
    const { artifact, comment } = await artifactAndComment(meta)
    await enqueueSlackMentionDms({ meta, baseUrl }, artifact, comment, [
      { id: linked.id, name: "Lin" },
    ])

    const calls: { url: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: JSON.parse(init?.body ?? "{}") })
        if (url.includes("/users.lookupByEmail"))
          return new Response(JSON.stringify({ ok: true, user: { id: "U-LOOKED-UP" } }))
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
    expect(calls.some((c) => c.url.includes("/users.lookupByEmail"))).toBe(true)
    expect(calls.some((c) => c.url.endsWith("/conversations.open"))).toBe(true)
  })

  it("is a delivered no-op when the email has no matching Slack account", async () => {
    const meta = make("slack-dm-nomatch")
    await connect(meta)
    const { artifact, comment } = await artifactAndComment(meta)
    await enqueueSlackMentionDms({ meta, baseUrl }, artifact, comment, [
      { id: linked.id, name: "Lin" },
    ])
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/users.lookupByEmail"))
          return new Response(JSON.stringify({ ok: false, error: "users_not_found" }))
        return new Response(JSON.stringify({ ok: false, error: "unexpected" }))
      }),
    )
    const [row] = (await claim(meta)).filter((d) => d.kind === "slack_dm")
    if (!row) throw new Error("no slack_dm row")
    const res = await makeSlackDmSender(meta, KEY)(row)
    expect(res.ok).toBe(true)
    expect(res.status).toContain("no matching Slack account")
  })

  it("is a delivered no-op when Slack isn't connected", async () => {
    const meta = make("slack-dm-noconn")
    // enqueue directly (no install), bypassing the enqueue-time gate.
    const { enqueueSlackDm } = await import("../src/lib/slack-dm")
    await enqueueSlackDm(meta, "default", linked.id, "hi", [])
    const [row] = (await claim(meta)).filter((d) => d.kind === "slack_dm")
    if (!row) throw new Error("no slack_dm row")
    const res = await makeSlackDmSender(meta, KEY)(row)
    expect(res.ok).toBe(true)
    expect(res.status).toContain("not connected")
  })
})
