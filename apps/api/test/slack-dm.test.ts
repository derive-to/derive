import { type ArtifactRecord, type CommentRecord, type DeliveryRecord, newId } from "@derive/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  enqueueSlackMentionDms,
  enqueueSlackReviewRequestedDm,
  enqueueSlackShareDm,
  makeSlackDmSender,
  wantsSlackDm,
} from "../src/lib/slack-dm"
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
    created_at: new Date().toISOString(),
  })

const optOut = (meta: ReturnType<typeof make>, userId: string) =>
  meta.setUserNotificationPref({
    id: newId("unp"),
    org_id: "default",
    user_id: userId,
    prefs: JSON.stringify({ slackDm: false }),
    created_at: new Date().toISOString(),
  })

const makeArtifact = (meta: ReturnType<typeof make>) =>
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

const artifactAndComment = async (meta: ReturnType<typeof make>) => {
  const artifact = await makeArtifact(meta)
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

describe("wantsSlackDm", () => {
  it("defaults on; off only when explicitly disabled", () => {
    expect(wantsSlackDm(undefined)).toBe(true)
    expect(wantsSlackDm("{}")).toBe(true)
    expect(wantsSlackDm(JSON.stringify({ slackDm: false }))).toBe(false)
    expect(wantsSlackDm(JSON.stringify({ slackDm: true }))).toBe(true)
    expect(wantsSlackDm("not json")).toBe(true)
  })
})

describe("enqueueSlackMentionDms (gate)", () => {
  it("enqueues a DM for an opted-in member; skips opted-out and non-members", async () => {
    const meta = make("slack-dm-gate")
    await connect(meta)
    await optOut(meta, optout.id)
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

  it("escapes mrkdwn control chars in the card + fallback (no <!channel> injection)", async () => {
    const meta = make("slack-dm-escape")
    await connect(meta)
    const artifact = (await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s").slice(0, 8),
      org_id: "default",
      slug: null,
      title: "<!channel> & <fake|link>",
      link_role: "viewer",
      kind: "file",
      spa: 0,
    })) as ArtifactRecord
    const comment = (await meta.createComment({
      id: newId("c"),
      artifact_id: artifact.id,
      thread_id: newId("th"),
      base_version: 0,
      path: null,
      anchor: null,
      body_md: "look <!here>",
      author: "<@U999>",
      author_id: "u-x",
    })) as CommentRecord
    await enqueueSlackMentionDms({ meta, baseUrl }, artifact, comment, [
      { id: linked.id, name: "L" },
    ])
    const payload = JSON.parse(
      (await claim(meta)).find((d) => d.kind === "slack_dm")?.payload ?? "{}",
    )
    const serialized = JSON.stringify(payload)
    // The literal control chars from untrusted author/title/body must be escaped everywhere they
    // land — both the block text and the plain-text fallback. `link` URLs are ours, so the only
    // raw `<`/`>` allowed are the `<url|...>` link delimiters we build.
    expect(payload.text).not.toContain("<!channel>")
    expect(payload.text).toContain("&lt;!channel&gt;")
    expect(payload.text).toContain("&lt;!here&gt;")
    expect(serialized).not.toContain("<@U999>")
    expect(serialized).not.toContain("<!here>")
    expect(serialized).toContain("&lt;@U999&gt;")
  })

  // Wiring, not just the renderer: a comment body is authored prose, so the sender must run it
  // through mrkdwnBody (escape THEN render markdown) rather than a bare escape — while the
  // control above still holds. A bare escape leaves markdown as literal `[text](url)` noise and
  // rewrites the URL's `&` to `&amp;`.
  it("renders the comment body's markdown without letting it forge a link", async () => {
    const meta = make("slack-dm-body-md")
    await connect(meta)
    const artifact = await makeArtifact(meta)
    const comment = (await meta.createComment({
      id: newId("c"),
      artifact_id: artifact.id,
      thread_id: newId("th"),
      base_version: 0,
      path: null,
      anchor: null,
      body_md: "see [the spec](https://ok.example/a?b=1&c=2) and <https://evil.example|Support>",
      author: "Ada",
      author_id: "u-ada",
    })) as CommentRecord
    await enqueueSlackMentionDms({ meta, baseUrl }, artifact, comment, [
      { id: linked.id, name: "L" },
    ])
    const serialized = JSON.stringify(
      JSON.parse((await claim(meta)).find((d) => d.kind === "slack_dm")?.payload ?? "{}"),
    )
    // The author's real markdown link renders, query string byte-intact...
    expect(serialized).toContain("<https://ok.example/a?b=1&c=2|the spec>")
    // ...while a hand-written Slack link stays inert text.
    expect(serialized).not.toContain("<https://evil.example|Support>")
    expect(serialized).toContain("&lt;https://evil.example|Support&gt;")
  })
})

describe("enqueueSlackReviewRequestedDm (gate)", () => {
  it("enqueues a DM for the reviewer when opted in; skips when opted out", async () => {
    const meta = make("slack-dm-review")
    await connect(meta)
    const artifact = await makeArtifact(meta)
    await enqueueSlackReviewRequestedDm(
      { meta, baseUrl },
      artifact,
      { requestedBy: "Ada", version: 3, note: "please check the intro" },
      linked.id,
    )
    const dms = (await claim(meta)).filter((d) => d.kind === "slack_dm")
    expect(dms).toHaveLength(1)
    const payload = JSON.parse(dms[0]?.payload ?? "{}")
    expect(payload.userId).toBe(linked.id)
    expect(payload.text).toContain("Ada requested your review")

    await optOut(meta, optout.id)
    await enqueueSlackReviewRequestedDm(
      { meta, baseUrl },
      artifact,
      { requestedBy: "Ada", version: 3 },
      optout.id,
    )
    expect((await claim(meta)).filter((d) => d.kind === "slack_dm")).toHaveLength(0)
  })
})

describe("enqueueSlackShareDm (gate)", () => {
  it("enqueues a DM for the person shared with when opted in; skips when opted out", async () => {
    const meta = make("slack-dm-share")
    await connect(meta)
    const artifact = await makeArtifact(meta)
    await enqueueSlackShareDm(
      { meta, baseUrl },
      artifact,
      { sharedBy: "Ada", role: "editor" },
      linked.id,
    )
    const dms = (await claim(meta)).filter((d) => d.kind === "slack_dm")
    expect(dms).toHaveLength(1)
    const payload = JSON.parse(dms[0]?.payload ?? "{}")
    expect(payload.userId).toBe(linked.id)
    expect(payload.text).toContain("Ada shared")

    await optOut(meta, optout.id)
    await enqueueSlackShareDm(
      { meta, baseUrl },
      artifact,
      { sharedBy: "Ada", role: "viewer" },
      optout.id,
    )
    expect((await claim(meta)).filter((d) => d.kind === "slack_dm")).toHaveLength(0)
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

  it("prefers a linked Slack identity over the email lookup", async () => {
    const meta = make("slack-dm-linked")
    await connect(meta)
    await meta.setSlackUserLink({
      id: "sul-1",
      org_id: "default",
      user_id: linked.id,
      team_id: "T1",
      slack_user_id: "U-LINKED",
      origin: "oauth" as const,
      checked_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    const { artifact, comment } = await artifactAndComment(meta)
    await enqueueSlackMentionDms({ meta, baseUrl }, artifact, comment, [
      { id: linked.id, name: "Lin" },
    ])

    const calls: { url: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({ url, body: JSON.parse(init?.body ?? "{}") })
        if (url.endsWith("/conversations.open"))
          return new Response(JSON.stringify({ ok: true, channel: { id: "D-9" } }))
        return new Response(JSON.stringify({ ok: true, ts: "1.1", channel: "D-9" }))
      }),
    )
    const [row] = (await claim(meta)).filter((d) => d.kind === "slack_dm")
    if (!row) throw new Error("no slack_dm row")
    const res = await makeSlackDmSender(meta, KEY)(row)
    expect(res.ok).toBe(true)
    // The link resolved the Slack user directly — no email lookup at all.
    expect(calls.some((c) => c.url.includes("/users.lookupByEmail"))).toBe(false)
    const open = calls.find((c) => c.url.endsWith("/conversations.open"))
    expect(JSON.stringify(open?.body)).toContain("U-LINKED")
  })

  it("posts one rich mention-DM root and threads later pings beneath it", async () => {
    const meta = make("slack-dm-threaded-mentions")
    await connect(meta)
    await meta.setSlackUserLink({
      id: "sul-threaded",
      org_id: "default",
      user_id: linked.id,
      team_id: "T1",
      slack_user_id: "U-LINKED",
      origin: "oauth" as const,
      checked_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    const { artifact, comment } = await artifactAndComment(meta)
    const posts: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>
        if (url.endsWith("/conversations.open"))
          return new Response(JSON.stringify({ ok: true, channel: { id: "D-thread" } }))
        if (url.endsWith("/chat.postMessage")) {
          posts.push(body)
          return new Response(
            JSON.stringify({
              ok: true,
              ts: posts.length === 1 ? "1.1" : "1.2",
              channel: "D-thread",
            }),
          )
        }
        return new Response(JSON.stringify({ ok: false, error: "unexpected" }))
      }),
    )

    await enqueueSlackMentionDms({ meta, baseUrl }, artifact, comment, [
      { id: linked.id, name: "Lin" },
    ])
    const [first] = (await claim(meta)).filter((d) => d.kind === "slack_dm")
    if (!first) throw new Error("no first mention delivery")
    expect((await makeSlackDmSender(meta, KEY)(first)).ok).toBe(true)
    expect((posts[0]?.metadata as { entities?: unknown[] }).entities).toHaveLength(1)
    expect(posts[0]?.thread_ts).toBeUndefined()
    const route = (await meta.listSlackThreadLinksByThread(comment.thread_id)).find(
      (l) => l.surface === "mention_dm",
    )
    expect(route?.recipient_user_id).toBe(linked.id)
    expect(route?.slack_user_id).toBe("U-LINKED")

    await enqueueSlackMentionDms({ meta, baseUrl }, artifact, comment, [
      { id: linked.id, name: "Lin" },
    ])
    const [second] = (await claim(meta)).filter((d) => d.kind === "slack_dm")
    if (!second) throw new Error("no second mention delivery")
    expect((await makeSlackDmSender(meta, KEY)(second)).ok).toBe(true)
    expect(posts[1]?.thread_ts).toBe("1.1")
    expect(posts[1]?.metadata).toBeUndefined()
  })

  it("starts a fresh DM root when the recipient has re-linked a different Slack account", async () => {
    const meta = make("slack-dm-relinked")
    await connect(meta)
    await meta.setSlackUserLink({
      id: "sul-relinked",
      org_id: "default",
      user_id: linked.id,
      team_id: "T1",
      slack_user_id: "U-NEW",
      origin: "oauth",
      checked_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    const { artifact, comment } = await artifactAndComment(meta)
    // An old route points at a different Slack identity. Its message ts is not valid in the
    // newly opened DM, so reusing it would turn this mention into a thread_not_found retry.
    await meta.setSlackThreadLink({
      id: "stl-old-identity",
      org_id: "default",
      artifact_id: artifact.id,
      thread_id: comment.thread_id,
      channel: "D-OLD",
      message_ts: "1.1",
      surface: "mention_dm",
      recipient_user_id: linked.id,
      slack_user_id: "U-OLD",
      created_at: new Date().toISOString(),
    })
    const posts: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>
        if (url.endsWith("/conversations.open"))
          return new Response(JSON.stringify({ ok: true, channel: { id: "D-NEW" } }))
        if (url.endsWith("/chat.postMessage")) {
          posts.push(body)
          return new Response(JSON.stringify({ ok: true, ts: "2.1", channel: "D-NEW" }))
        }
        return new Response(JSON.stringify({ ok: false, error: "unexpected" }))
      }),
    )
    await enqueueSlackMentionDms({ meta, baseUrl }, artifact, comment, [
      { id: linked.id, name: "Lin" },
    ])
    const [row] = (await claim(meta)).filter((d) => d.kind === "slack_dm")
    if (!row) throw new Error("no mention delivery")
    expect((await makeSlackDmSender(meta, KEY)(row)).ok).toBe(true)
    expect(posts[0]?.thread_ts).toBeUndefined()
    expect((posts[0]?.metadata as { entities?: unknown[] }).entities).toHaveLength(1)
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
