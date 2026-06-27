import type { DeliveryRecord } from "@dock/core"
import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, pub, type TestUser } from "./helpers"

// Posting a comment fans out onto the outbox: an email to eligible recipients and a
// Slack post when connected — each gated by the workspace toggles. We drive the real
// route and inspect the enqueued outbox rows by kind.
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
  const r = await pub(app, "# Doc", {}, undefined, as(owner.email))
  return (await r.json()).short_id as string
}

const comment = (app: ReturnType<typeof makeAuthedApp>["app"], shortId: string, who: string) =>
  app.request(`/v1/artifacts/${shortId}/comments`, jsonAs(as(who), { body_md: "a note" }))

describe("comment channel fan-out", () => {
  it("enqueues an email to the workspace owner when a non-owner comments", async () => {
    const { app, meta } = makeAuthedApp("fanout-email", [owner, editor], "editor")
    const shortId = await newArtifact(app)
    const res = await comment(app, shortId, editor.email)
    expect(res.status).toBe(201)
    const kinds = (await claim(meta)).map((d) => d.kind)
    expect(kinds).toContain("email")
  })

  it("does not email when the email toggle is off", async () => {
    const { app, meta } = makeAuthedApp("fanout-email-off", [owner, editor], "editor")
    await meta.setOrgSettings("default", {
      emailNotifications: false,
      githubPostComments: true,
      githubMirrorComments: true,
      githubPreviewLink: true,
      slackPost: true,
    })
    const shortId = await newArtifact(app)
    await comment(app, shortId, editor.email)
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
