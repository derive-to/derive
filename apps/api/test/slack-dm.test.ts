import {
  type ArtifactRecord,
  type CommentRecord,
  type DeliveryRecord,
  type MetaStore,
  newId,
} from "@derive/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildReviewEmail } from "../src/lib/email"
import { summarizeReviewDocuments, summarizeTextEdits } from "../src/lib/review-summary"
import { postWithRecovery } from "../src/lib/slack-delivery"
import {
  enqueueSlackArtifactCompletedDm,
  enqueueSlackArtifactMentionDms,
  enqueueSlackMentionDms,
  enqueueSlackReviewRequestedDm,
  enqueueSlackShareDm,
  makeSlackDmSender,
  wantsReviewEmail,
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

describe("enqueueSlackArtifactMentionDms", () => {
  it("sends a contextual open-only DM and honors the recipient preference", async () => {
    const meta = make("slack-dm-artifact-mention")
    await connect(meta)
    const artifact = await makeArtifact(meta)
    await optOut(meta, optout.id)
    await enqueueSlackArtifactMentionDms(
      { meta, baseUrl },
      artifact,
      [
        { id: linked.id, excerpt: "@lin, please decide before Friday." },
        { id: optout.id, excerpt: "@opt, this should stay quiet." },
      ],
      { author: "Ada", excerpt: "fallback context" },
    )
    const dms = (await claim(meta)).filter((delivery) => delivery.kind === "slack_dm")
    expect(dms).toHaveLength(1)
    const payload = JSON.parse(dms[0]?.payload ?? "{}") as Record<string, unknown>
    expect(payload.userId).toBe(linked.id)
    expect(JSON.stringify(payload)).toContain("please decide before Friday")
    // There is no synthetic Slack thread to reply into for a document-body mention.
    expect(payload.mention).toBeUndefined()
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
      {
        requestedBy: "Ada",
        roundId: "rr-review-1",
        version: 3,
        note: "please check the intro",
        summary: {
          fromVersion: 2,
          toVersion: 3,
          added: 4,
          removed: 1,
          changes: [
            {
              kind: "updated",
              title: "Approval flow",
              added: 4,
              removed: 1,
              before: "Publish immediately after approval.",
              after: "Open the work and leave contextual feedback.",
            },
          ],
          totalChanges: 4,
          highlights: [],
          note: "please check the intro",
        },
      },
      linked.id,
    )
    const dms = (await claim(meta)).filter((d) => d.kind === "slack_dm")
    expect(dms).toHaveLength(1)
    const payload = JSON.parse(dms[0]?.payload ?? "{}")
    expect(payload.userId).toBe(linked.id)
    expect(payload.text).toContain("Ada updated")
    expect(payload.blocks).toEqual([])
    expect(JSON.stringify(payload.fallbackBlocks)).toContain("Approval flow")
    expect(JSON.stringify(payload.fallbackBlocks)).toContain("3 more changes")
    expect(payload.metadata.entities[0].entity_payload.attributes.display_type).toBe("Review")
    expect(payload.metadata.entities[0].external_ref).toEqual({
      id: `${artifact.id}::rr-review-1`,
      type: "review_request",
    })

    await optOut(meta, optout.id)
    await enqueueSlackReviewRequestedDm(
      { meta, baseUrl },
      artifact,
      {
        requestedBy: "Ada",
        roundId: "rr-review-2",
        version: 3,
        summary: {
          fromVersion: 2,
          toVersion: 3,
          added: 0,
          removed: 0,
          highlights: [],
          note: null,
        },
      },
      optout.id,
    )
    expect((await claim(meta)).filter((d) => d.kind === "slack_dm")).toHaveLength(0)
  })
})

describe("enqueueSlackArtifactCompletedDm", () => {
  it("defaults on and renders a bounded visual diff with an open-and-comment action", async () => {
    const meta = make("slack-dm-completed")
    await connect(meta)
    const artifact = await makeArtifact(meta)
    await enqueueSlackArtifactCompletedDm(
      { meta, baseUrl },
      artifact,
      {
        agentName: "Codex",
        version: 8,
        summary: {
          fromVersion: 7,
          toVersion: 8,
          added: 12,
          removed: 3,
          changes: [
            {
              kind: "updated",
              title: "Review flow",
              added: 4,
              removed: 1,
              after: "Comment inline.",
            },
            {
              kind: "added",
              title: "Diagram",
              added: 5,
              removed: 0,
              after: "Draft → Review → Done.",
            },
            {
              kind: "removed",
              title: "Publish step",
              added: 0,
              removed: 2,
              before: "Publish manually.",
            },
          ],
          totalChanges: 6,
          highlights: [],
          note: null,
        },
      },
      linked.id,
    )
    const dms = (await claim(meta)).filter((d) => d.kind === "slack_dm")
    expect(dms).toHaveLength(1)
    expect(dms[0]?.event_type).toBe("artifact.completed")
    const payload = JSON.parse(dms[0]?.payload ?? "{}")
    expect(payload.text).toContain("Codex updated Doc")
    expect(payload.blocks).toEqual([])
    expect(JSON.stringify(payload.fallbackBlocks)).toContain("Open & comment")
    expect(JSON.stringify(payload.fallbackBlocks)).toContain("3 more changes")
    expect(payload.metadata.entities[0].entity_payload.attributes.display_type).toBe(
      "Work completed",
    )
    expect(payload.metadata.entities[0].external_ref).toEqual({
      id: `${artifact.id}::v8`,
      type: "artifact_completion",
    })
  })

  it("coalesces rapid publishes of one artifact into the latest pending card", async () => {
    const meta = make("slack-dm-completed-coalesce")
    await connect(meta)
    const artifact = await makeArtifact(meta)
    for (const version of [2, 3])
      await enqueueSlackArtifactCompletedDm(
        { meta, baseUrl },
        artifact,
        {
          agentName: "Codex",
          version,
          summary: {
            fromVersion: version - 1,
            toVersion: version,
            added: version,
            removed: 0,
            changes: [{ kind: "updated", title: `Version ${version}`, added: version, removed: 0 }],
            totalChanges: 1,
            highlights: [],
            note: null,
          },
        },
        linked.id,
      )
    const dms = (await claim(meta)).filter((d) => d.kind === "slack_dm")
    expect(dms).toHaveLength(1)
    const payload = JSON.parse(dms[0]?.payload ?? "{}")
    expect(payload.text).toContain("v3")
    expect(JSON.stringify(payload.metadata)).toContain("Version 3")
  })

  it("does not enqueue after the user turns Slack updates off", async () => {
    const meta = make("slack-dm-completed-optout")
    await connect(meta)
    await optOut(meta, optout.id)
    const artifact = await makeArtifact(meta)
    await enqueueSlackArtifactCompletedDm(
      { meta, baseUrl },
      artifact,
      {
        agentName: "Codex",
        version: 1,
        summary: {
          fromVersion: null,
          toVersion: 1,
          added: 0,
          removed: 0,
          changes: [],
          totalChanges: 0,
          highlights: [],
          note: null,
        },
      },
      optout.id,
    )
    expect((await claim(meta)).filter((d) => d.kind === "slack_dm")).toHaveLength(0)
  })
})

describe("notification preferences", () => {
  it("defaults Slack on and review email off", () => {
    expect(wantsSlackDm(undefined)).toBe(true)
    expect(wantsReviewEmail(undefined)).toBe(false)
    expect(wantsReviewEmail("not-json")).toBe(false)
    expect(wantsReviewEmail(JSON.stringify({ reviewEmail: true }))).toBe(true)
  })
})

describe("review summary", () => {
  it("summarizes an exact edit without diffing the surrounding large document", () => {
    const unchanged = "stable surrounding copy ".repeat(100_000)
    const summary = summarizeTextEdits({
      edits: [
        {
          before: `${unchanged}needle-2301${unchanged}`,
          after: `${unchanged}needle-2301-proof${unchanged}`,
          contentType: "text/html",
        },
      ],
      fromVersion: 3,
      toVersion: 4,
    })
    expect(summary).toMatchObject({ fromVersion: 3, toVersion: 4 })
    expect(summary.added + summary.removed).toBeGreaterThan(0)
    expect(JSON.stringify(summary).length).toBeLessThan(4_000)
    expect(JSON.stringify(summary)).toContain("needle-2301-proof")
  })

  it("reports a short one-word correction as a real edit", () => {
    const summary = summarizeTextEdits({
      edits: [{ before: "teh", after: "the", contentType: "text/markdown" }],
      fromVersion: 8,
      toVersion: 9,
    })
    expect(summary).toMatchObject({ added: 1, removed: 1, totalChanges: 1 })
    expect(summary.changes?.[0]).toMatchObject({ title: "Edited content" })
  })

  it("turns HTML and Mermaid changes into ranked, bounded structural cards", () => {
    const summary = summarizeReviewDocuments({
      before: `<h1>Checkout</h1><h2>Flow</h2><pre class="mermaid">graph LR\nCart-->|Pay|Receipt</pre><h2>Legacy</h2><p>Publish immediately after approval.</p>`,
      after: `<h1>Checkout</h1><h2>Flow</h2><pre class="mermaid">graph LR\nCart-->|Review|Approval\nApproval-->|Pay|Receipt</pre><h2>Review controls</h2><p>Open the work and leave contextual feedback.</p><h2>Audit trail</h2><p>Every decision records its author and time.</p>`,
      beforeContentType: "text/html",
      afterContentType: "text/html",
      fromVersion: 6,
      toVersion: 7,
    })
    expect(summary.added).toBeGreaterThan(0)
    expect(summary.removed).toBeGreaterThan(0)
    expect(summary.changes?.length).toBeLessThanOrEqual(3)
    expect(summary.totalChanges).toBeGreaterThanOrEqual(summary.changes?.length ?? 0)
    expect(JSON.stringify(summary)).toContain("Review controls")
    expect(JSON.stringify(summary)).not.toContain("<h2>")
  })

  it("keeps the email compact and puts the open action above and below the diff", async () => {
    const meta = make("review-email-render")
    const artifact = await makeArtifact(meta)
    const summary = summarizeReviewDocuments({
      before: "# Intro\nOld introduction.\n# Flow\nOld flow.\n# Legacy\nRemove this.\n",
      after:
        "# Intro\nNew introduction.\n# Flow\nNew flow.\n# Diagram\nDraft → Review → Done.\n# Audit\nEvery choice is recorded.\n",
      fromVersion: 2,
      toVersion: 3,
    })
    const email = buildReviewEmail(baseUrl, artifact, {
      requestedBy: "Ada",
      version: 3,
      summary: { ...summary, totalChanges: 6 },
    })
    expect(email.subject).toContain("updated Doc")
    expect(email.html).toContain('<meta charset="utf-8"')
    expect(email.html.match(/>Open the work</g)).toHaveLength(2)
    expect(email.html).toContain("+ 3 more changes")
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

  it("uses the active workspace's saved Slack email before the Derive account email", async () => {
    const meta = make("slack-dm-workspace-email")
    await connect(meta)
    await meta.setUserNotificationPref({
      id: "pref-workspace-email",
      org_id: "default",
      user_id: linked.id,
      prefs: JSON.stringify({ slackEmail: "lin@workspace.example" }),
      created_at: new Date().toISOString(),
    })
    const { artifact, comment } = await artifactAndComment(meta)
    await enqueueSlackMentionDms({ meta, baseUrl }, artifact, comment, [
      { id: linked.id, name: "Lin" },
    ])

    const lookups: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/users.lookupByEmail")) {
          lookups.push(new URL(url).searchParams.get("email") ?? "")
          return Response.json({ ok: true, user: { id: "U-WORKSPACE" } })
        }
        if (url.endsWith("/conversations.open"))
          return Response.json({ ok: true, channel: { id: "D-WORKSPACE" } })
        const body = JSON.parse(String(init?.body)) as { channel: string }
        return Response.json({ ok: true, ts: "1.1", channel: body.channel })
      }),
    )
    const [row] = (await claim(meta)).filter((delivery) => delivery.kind === "slack_dm")
    if (!row) throw new Error("no slack_dm row")

    expect((await makeSlackDmSender(meta, KEY)(row)).ok).toBe(true)
    expect(lookups).toEqual(["lin@workspace.example"])
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
})

describe("Slack Work Object recovery", () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    "invalid_metadata_schema",
    "error_processing_metadata",
  ])("falls back to Block Kit when Slack rejects entity metadata with %s", async (metadataError) => {
    const posted: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        posted.push(body)
        if (posted.length === 1)
          return new Response(JSON.stringify({ ok: false, error: metadataError }))
        return new Response(JSON.stringify({ ok: true, ts: "1.1", channel: "D1" }))
      }),
    )

    const r = await postWithRecovery(
      {} as MetaStore,
      "org",
      "xoxb-token",
      {
        channel: "D1",
        text: "A mention",
        blocks: [],
        fallbackBlocks: [{ type: "section", block_id: "expanded-fallback" }],
        metadata: { entities: [{ external_ref: { id: "th_1" } }] },
      },
      { metadataFallback: true },
    )

    expect(r).toMatchObject({ ok: true, status: expect.stringContaining("blocks-only") })
    expect(posted).toHaveLength(2)
    expect(posted[0]?.metadata).toBeTruthy()
    expect(posted[0]?.blocks).toEqual([])
    expect(posted[1]?.metadata).toBeUndefined()
    expect(JSON.stringify(posted[1]?.blocks)).toContain("expanded-fallback")
  })

  it("keeps entity metadata when only the Block Kit payload is invalid", async () => {
    const posted: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        posted.push(body)
        if (posted.length === 1)
          return new Response(JSON.stringify({ ok: false, error: "invalid_blocks" }))
        return new Response(JSON.stringify({ ok: true, ts: "1.1", channel: "D1" }))
      }),
    )

    const r = await postWithRecovery(
      {} as MetaStore,
      "org",
      "xoxb-token",
      {
        channel: "D1",
        text: "A mention",
        blocks: [{ type: "not-a-real-block" }],
        metadata: { entities: [{ external_ref: { id: "th_1" } }] },
      },
      { metadataFallback: true, textFallback: true },
    )

    expect(r).toMatchObject({ ok: true, status: expect.stringContaining("text-only") })
    expect(posted).toHaveLength(2)
    expect(posted[1]?.blocks).toBeUndefined()
    expect(posted[1]?.metadata).toBeTruthy()
  })
})
