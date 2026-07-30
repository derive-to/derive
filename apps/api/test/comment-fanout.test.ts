import type { DeliveryRecord } from "@derive/core"
import { DEFAULT_ORG_SETTINGS, newId } from "@derive/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { commentCreatedAction } from "../src/lib/comment-actions"
import { makeSlackSender } from "../src/lib/slack-comments"
import { runDeliveryTick } from "../src/webhooks"
import { as, jsonAs, makeAuthedApp, pub, type TestUser } from "./helpers"

// The other interrupt-worthy emails ride the same outbox: a review request (the
// loop is blocked on its human) and an explicit share. Pinned here beside the
// comment policy so the whole "what emails" contract lives in one file.

// Posting a comment fans out onto the outbox: an email to @MENTIONED people only
// (a plain comment reaches thread participants as bell rows, never email — the
// interrupt bar), and a Slack post when connected — each gated by the workspace
// toggles. We drive the real route and inspect the enqueued outbox rows by kind.
const owner: TestUser = { id: "u-own", email: "own@x.com", name: "Owner", username: "own" }
const editor: TestUser = { id: "u-ed", email: "ed@x.com", name: "Ed", username: "edd" }

const claim = (
  meta: Awaited<ReturnType<typeof makeAuthedApp>>["meta"],
): Promise<DeliveryRecord[]> =>
  meta.claimDueDeliveries(
    new Date(Date.now() + 60_000).toISOString(),
    100,
    new Date(Date.now() + 120_000).toISOString(),
  )

const newArtifact = async (app: ReturnType<typeof makeAuthedApp>["app"]) => {
  const r = await pub(app, "# Doc", { visibility: "org" }, undefined, as(owner.email))
  return (await r.json()).short_id as string
}

const comment = (
  app: ReturnType<typeof makeAuthedApp>["app"],
  shortId: string,
  who: string,
  mentions?: { id: string; name: string }[],
) =>
  app.request(
    `/v1/artifacts/${shortId}/comments`,
    jsonAs(as(who), { body_md: "a note", ...(mentions ? { mentions } : {}) }),
  )

describe("comment channel fan-out", () => {
  it("a plain comment emails NO ONE — not even workspace owners", async () => {
    // The old policy blasted every workspace owner on every comment; with agents
    // multiplying comment volume that made admins' inboxes the firehose. Owners
    // hear about plain activity like everyone else: bell rows, not email.
    const { app, meta } = makeAuthedApp("fanout-email", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    const res = await comment(app, shortId, editor.email)
    expect(res.status).toBe(201)
    const kinds = (await claim(meta)).map((d) => d.kind)
    expect(kinds).not.toContain("email")
  })

  it("a reply bells earlier thread authors; the replier never hears themselves", async () => {
    const { app, meta } = makeAuthedApp("fanout-bell", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    // Owner opens the thread; editor replies into it.
    const first = await (await comment(app, shortId, owner.email)).json()
    await app.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs(as(editor.email), { body_md: "replying", thread_id: first.thread_id }),
    )
    const rows = await meta.listNotifications(owner.id, 10)
    const reply = rows.find((n) => n.kind === "comment" && n.thread_id === first.thread_id)
    expect(reply).toBeTruthy()
    // The replier never hears about their own comment.
    expect((await meta.listNotifications(editor.id, 10)).map((n) => n.kind)).not.toContain(
      "comment",
    )
  })

  it("a fresh comment on your artifact bells you — it's your content", async () => {
    const { app, meta } = makeAuthedApp("fanout-owner-bell", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    // Editor opens a NEW thread (owner has no comment in it, no mention).
    const res = await comment(app, shortId, editor.email)
    expect(res.status).toBe(201)
    const rows = await meta.listNotifications(owner.id, 10)
    expect(rows.some((n) => n.kind === "comment")).toBe(true)
  })

  it("a mention emails the mentioned person (and no one else)", async () => {
    const { app, meta } = makeAuthedApp("fanout-mention", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    const res = await comment(app, shortId, editor.email, [{ id: owner.id, name: "Owner" }])
    expect(res.status).toBe(201)
    const emails = (await claim(meta)).filter((d) => d.kind === "email")
    expect(emails).toHaveLength(1)
    expect(emails[0]?.payload).toContain(owner.email)
  })

  it("does not email a mention when the email toggle is off", async () => {
    const { app, meta } = makeAuthedApp("fanout-email-off", [owner, editor], "editor")
    await meta.setOrgSettings("default", {
      ...DEFAULT_ORG_SETTINGS,
      emailNotifications: false,
      githubPostComments: true,
      githubMirrorComments: true,
      githubPreviewLink: true,
    })
    const shortId = await newArtifact(app)
    await comment(app, shortId, editor.email, [{ id: owner.id, name: "Owner" }])
    const kinds = (await claim(meta)).map((d) => d.kind)
    expect(kinds).not.toContain("email")
  })

  it("enqueues a Slack post when Slack is connected with a default channel", async () => {
    const { app, meta } = makeAuthedApp("fanout-slack", [owner, editor], "editor")
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: "xoxb-stored",
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    await meta.upsertSlackSubscription({ id: newId("sub"), org_id: "default", channel_id: "C1" })
    const shortId = await newArtifact(app)
    await comment(app, shortId, owner.email)
    const kinds = (await claim(meta)).map((d) => d.kind)
    expect(kinds).toContain("slack_app")
  })

  it("does not post to Slack when no channel is subscribed", async () => {
    const { app, meta } = makeAuthedApp("fanout-slack-off", [owner, editor], "editor")
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: "xoxb-stored",
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    // Deliberately NO subscription: that is what "off" means now.
    await meta.setOrgSettings("default", {
      ...DEFAULT_ORG_SETTINGS,
      emailNotifications: true,
      githubPostComments: true,
      githubMirrorComments: true,
      githubPreviewLink: true,
    })
    const shortId = await newArtifact(app)
    await comment(app, shortId, owner.email)
    const kinds = (await claim(meta)).map((d) => d.kind)
    expect(kinds).not.toContain("slack_app")
  })

  it("does not mirror a comment on a PRIVATE artifact (no leak)", async () => {
    const { app, meta } = makeAuthedApp("fanout-slack-private", [owner], "editor")
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: "xoxb-stored",
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    await meta.upsertSlackSubscription({ id: newId("sub"), org_id: "default", channel_id: "C1" })
    const r = await pub(app, "# Secret", { visibility: "private" }, undefined, as(owner.email))
    const shortId = (await r.json()).short_id as string
    await comment(app, shortId, owner.email)
    // Private draft (listed "none") → its title + comment body never reach the org-wide channel.
    expect((await claim(meta)).map((d) => d.kind)).not.toContain("slack_app")
  })

  // The headline behaviour of subscriptions, and the reason the outbox row carries its own
  // channel: three subscribed channels produce three INDEPENDENT deliveries, so an archived
  // channel or one the bot was removed from fails and dead-letters on its own instead of taking
  // the others down with it.
  it("fans one comment out to every subscribed channel, one delivery each", async () => {
    const { app, meta } = makeAuthedApp("fanout-multi", [owner], "editor")
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: "xoxb-stored",
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    for (const ch of ["C-eng", "C-design", "C-all"])
      await meta.upsertSlackSubscription({ id: newId("sub"), org_id: "default", channel_id: ch })
    const shortId = await newArtifact(app)
    await comment(app, shortId, owner.email)
    const rows = (await claim(meta)).filter((d) => d.kind === "slack_app")
    expect(rows.map((d) => JSON.parse(d.payload).channel).sort()).toEqual([
      "C-all",
      "C-design",
      "C-eng",
    ])
  })

  // Each channel threads on its OWN root message — the reason thread links are keyed
  // (thread_id, channel) rather than by thread alone.
  it("threads independently per channel", async () => {
    const { app, meta } = makeAuthedApp("fanout-threading", [owner], "editor")
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: "xoxb-stored",
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    for (const ch of ["C-a", "C-b"])
      await meta.upsertSlackSubscription({ id: newId("sub"), org_id: "default", channel_id: ch })
    const shortId = await newArtifact(app)
    const artifact = await meta.getByShortId(shortId)
    const first = await (await comment(app, shortId, owner.email)).json()

    // Drain both root posts, so each channel records its own thread link.
    let ts = 100
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { channel: string }
        ts += 1
        return new Response(
          JSON.stringify({ ok: true, ts: `17000000${ts}.1`, channel: body.channel }),
          { status: 200 },
        )
      }),
    )
    await runDeliveryTick(
      meta,
      { precheck: async () => null },
      { slack_app: makeSlackSender(meta, "k") },
    )
    const links = await meta.listSlackThreadLinksByThread(first.thread_id)
    expect(links.map((l) => l.channel).sort()).toEqual(["C-a", "C-b"])
    // Distinct Slack messages, one per channel — not one message reused.
    expect(new Set(links.map((l) => l.message_ts)).size).toBe(2)
    expect(links.every((l) => l.artifact_id === artifact?.id)).toBe(true)
  })

  // The mirrors are gated on a COLLABORATOR author: it keeps a signed-in holder of a
  // commenter LINK — an invited outsider with no share and no seat — from relaying text into
  // the workspace's channel. (Anonymous visitors never reach here; they cannot comment at all.)
  // That gate had no test, and it now has an extra branch (`onBehalfOf`, for an agent acting
  // under a member's OAuth grant) — so pin both
  // directions against the same store: the branch must decide the outcome, not decorate it.
  describe("the collaborator-author gate on the mirror", () => {
    const connected = async (name: string) => {
      const { app, meta } = makeAuthedApp(name, [owner], "editor")
      await meta.setSlackInstall({
        org_id: "default",
        team_id: "T1",
        team_name: "Acme",
        bot_token: "xoxb-stored",
        bot_user_id: "UBOT",
        created_at: new Date().toISOString(),
      })
      await meta.upsertSlackSubscription({
        id: newId("sub"),
        org_id: "default",
        channel_id: "C1",
      })
      const shortId = await newArtifact(app)
      const artifact = await meta.getByShortId(shortId)
      const comment = await meta.createComment({
        id: newId("c"),
        artifact_id: artifact?.id ?? "",
        thread_id: newId("th"),
        base_version: 0,
        path: null,
        anchor: null,
        body_md: "a note",
        author: "An agent",
        author_id: "oauth:cli",
      })
      return { meta, artifact, comment }
    }
    const run = (
      d: Awaited<ReturnType<typeof connected>>,
      onBehalfOf: string | null,
    ): Promise<void> =>
      commentCreatedAction(
        {
          meta: d.meta,
          bus: { publish: () => {}, subscribe: () => () => {} } as never,
          blobs: {} as never,
          baseUrl: "http://derive.test",
          notify: async () => {},
        },
        d.artifact as never,
        d.comment as never,
        { mentions: [], actorId: "oauth:cli", onBehalfOf },
      )

    it("skips the mirror for an author who is nobody (no principal behind it)", async () => {
      const d = await connected("fanout-gate-untrusted")
      await run(d, null)
      expect((await claim(d.meta)).map((x) => x.kind)).not.toContain("slack_app")
    })

    it("mirrors when the author acts for a member — the OAuth-grant case", async () => {
      const d = await connected("fanout-gate-onbehalf")
      await run(d, owner.id)
      expect((await claim(d.meta)).map((x) => x.kind)).toContain("slack_app")
    })
  })
})

describe("connected-channel event cards (publishes / proposals)", () => {
  afterEach(() => vi.unstubAllGlobals())

  // An install can't exist without the instance having Slack creds, so the app is built with
  // them (notify only fans to the channel when `deps.slack` is set).
  const authed = (name: string) =>
    makeAuthedApp(name, [owner], "editor", {
      deps: { slack: { clientId: "c", clientSecret: "s", signingSecret: "sig" } },
    })

  // "Connected" is now two things: an install (credentials) and at least one subscribed
  // channel (where to post). The channel used to be a column on the install.
  const connect = async (meta: Awaited<ReturnType<typeof makeAuthedApp>>["meta"]) => {
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: "xoxb-plain",
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    await meta.upsertSlackSubscription({ id: newId("sub"), org_id: "default", channel_id: "C1" })
  }

  it("a publish posts a version.published card to the connected channel", async () => {
    const { app, meta } = authed("chan-publish")
    await connect(meta)
    await newArtifact(app) // publishes v1 → version.published
    const card = (await claim(meta)).find(
      (d) => d.kind === "slack_app" && d.event_type === "version.published",
    )
    expect(card).toBeTruthy()
  })

  it("does not post a channel card for a PRIVATE artifact's publish (no leak)", async () => {
    const { app, meta } = authed("chan-private")
    await connect(meta)
    await pub(app, "# Secret", { visibility: "private" }, undefined, as(owner.email))
    expect((await claim(meta)).map((d) => d.kind)).not.toContain("slack_app")
  })

  // "Off" is now the absence of a subscription rather than a workspace-wide toggle, so an
  // install with no subscribed channel posts nothing.
  it("posts no channel card when no channel is subscribed", async () => {
    const { app, meta } = authed("chan-off")
    await connect(meta)
    await meta.deleteSlackSubscriptionsByChannel("default", "C1")
    await newArtifact(app)
    expect((await claim(meta)).map((d) => d.kind)).not.toContain("slack_app")
  })

  it("the sender posts an event card top-level (not threaded under a comment)", async () => {
    const { meta } = authed("chan-sender")
    await connect(meta)
    const d: DeliveryRecord = {
      id: "wd-evt",
      webhook_id: "internal",
      url: "",
      secret: "",
      kind: "slack_app",
      event_type: "version.published",
      payload: JSON.stringify({
        channel: "C1",
        orgId: "default",
        event: "version.published",
        title: "Doc",
        link: "https://derive.test/artifacts/abc",
        author: "Ann",
        version: 2,
        message: null,
      }),
      status: "pending",
      attempts: 0,
      last_error: null,
      next_attempt_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }
    let sent: { channel?: string; thread_ts?: string; blocks?: unknown } = {}
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        sent = JSON.parse(init?.body ?? "{}")
        return new Response(JSON.stringify({ ok: true, ts: "1.1", channel: "C1" }))
      }),
    )
    const res = await makeSlackSender(meta, "k")(d)
    expect(res.ok).toBe(true)
    expect(sent.channel).toBe("C1")
    expect(sent.thread_ts).toBeUndefined() // top-level, not a threaded reply
    expect(JSON.stringify(sent.blocks)).toContain("published")
  })

  it("a proposal card carries Approve / Request-changes buttons", async () => {
    const { meta } = authed("chan-propcard")
    await connect(meta)
    const d: DeliveryRecord = {
      id: "wd-prop",
      webhook_id: "internal",
      url: "",
      secret: "",
      kind: "slack_app",
      event_type: "proposal.created",
      payload: JSON.stringify({
        orgId: "default",
        artifactId: "a1",
        event: "proposal.created",
        title: "Doc",
        link: "https://derive.test/artifacts/a1",
        author: "Ann",
        version: null,
        message: "please review",
        proposalId: "p9",
      }),
      status: "pending",
      attempts: 0,
      last_error: null,
      next_attempt_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }
    let sent: { blocks?: unknown } = {}
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        sent = JSON.parse(init?.body ?? "{}")
        return new Response(JSON.stringify({ ok: true, ts: "1.1", channel: "C1" }))
      }),
    )
    await makeSlackSender(meta, "k")(d)
    const s = JSON.stringify(sent.blocks)
    expect(s).toContain("derive_proposal_approve")
    expect(s).toContain("derive_proposal_request_changes")
  })

  it("escapes untrusted title/author/body in the comment card (no mrkdwn injection)", async () => {
    const { meta } = authed("chan-comment-escape")
    await connect(meta)
    const d: DeliveryRecord = {
      id: "wd-cmt",
      webhook_id: "internal",
      url: "",
      secret: "",
      kind: "slack_app",
      event_type: "comment.created",
      payload: JSON.stringify({
        orgId: "default",
        artifactId: "a1",
        threadId: "th1",
        text: "ping <!channel>",
        link: "https://derive.test/artifacts/a1",
        title: "<fake|link> & more",
        author: "<@U999>",
      }),
      status: "pending",
      attempts: 0,
      last_error: null,
      next_attempt_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }
    let sent: { blocks?: unknown; text?: string } = {}
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        sent = JSON.parse(init?.body ?? "{}")
        return new Response(JSON.stringify({ ok: true, ts: "1.1", channel: "C1" }))
      }),
    )
    await makeSlackSender(meta, "k")(d)
    const s = JSON.stringify(sent.blocks)
    // Untrusted control chars are escaped in both the block text and the plain-text fallback; the
    // only raw `<`/`>` left are the `<url|title>` link delimiters the card itself builds.
    expect(s).not.toContain("<@U999>")
    expect(s).not.toContain("<!channel>")
    expect(s).toContain("&lt;@U999&gt;")
    expect(sent.text).not.toContain("<@U999>")
    expect(sent.text).toContain("&lt;@U999&gt;")
  })
})

describe("review-request + share emails", () => {
  it("an agent's review request emails the human it acts for", async () => {
    const { app, meta } = makeAuthedApp("fanout-review", [owner, editor], "editor")
    const reg = await (
      await app.request("/v1/agents", jsonAs(as(owner.email), { name: "Scribe", role: "editor" }))
    ).json()
    const res = await pub(app, "# plan", { request_review: "true", title: "Plan" }, undefined, {
      authorization: `Bearer ${reg.token}`,
    })
    expect(res.status).toBe(201)
    const emails = (await claim(meta)).filter((d) => d.kind === "email")
    expect(emails).toHaveLength(1)
    expect(emails[0]?.payload).toContain(owner.email)
    expect(emails[0]?.payload).toContain("requested your review")
  })

  it("a human's own request_review never emails themselves", async () => {
    const { app, meta } = makeAuthedApp("fanout-review-self", [owner], "editor")
    const res = await pub(
      app,
      "# plan",
      { request_review: "true", title: "Plan" },
      undefined,
      as(owner.email),
    )
    expect(res.status).toBe(201)
    expect((await claim(meta)).map((d) => d.kind)).not.toContain("email")
  })

  it("sharing an artifact emails the person you added", async () => {
    const { app, meta } = makeAuthedApp("fanout-share", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    const res = await app.request(`/v1/artifacts/${shortId}/members`, {
      ...jsonAs(as(owner.email), { user: editor.username, role: "commenter" }),
      method: "PUT",
    })
    expect(res.status).toBe(201)
    const emails = (await claim(meta)).filter((d) => d.kind === "email")
    expect(emails).toHaveLength(1)
    expect(emails[0]?.payload).toContain(editor.email)
    expect(emails[0]?.payload).toContain("shared")
  })
})
