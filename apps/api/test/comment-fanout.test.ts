import type { DeliveryRecord } from "@derive/core"
import { DEFAULT_ORG_SETTINGS } from "@derive/core"
import { describe, expect, it } from "vitest"
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
      slackPost: true,
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
      default_channel: "C1",
      created_at: new Date().toISOString(),
    })
    const shortId = await newArtifact(app)
    await comment(app, shortId, owner.email)
    const kinds = (await claim(meta)).map((d) => d.kind)
    expect(kinds).toContain("slack_app")
  })

  it("does not post to Slack when the toggle is off", async () => {
    const { app, meta } = makeAuthedApp("fanout-slack-off", [owner, editor], "editor")
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: "xoxb-stored",
      bot_user_id: "UBOT",
      default_channel: "C1",
      created_at: new Date().toISOString(),
    })
    await meta.setOrgSettings("default", {
      ...DEFAULT_ORG_SETTINGS,
      emailNotifications: true,
      githubPostComments: true,
      githubMirrorComments: true,
      githubPreviewLink: true,
      slackPost: false,
    })
    const shortId = await newArtifact(app)
    await comment(app, shortId, owner.email)
    const kinds = (await claim(meta)).map((d) => d.kind)
    expect(kinds).not.toContain("slack_app")
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
