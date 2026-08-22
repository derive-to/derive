import { createHmac } from "node:crypto"
import { type ArtifactRecord, type DeliveryRecord, type MetaStore, newId } from "@derive/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { encryptSecret, signState } from "../src/lib/crypto"
import { notifyThreadReplyAgents } from "../src/lib/mentions"
import { makeSlackIngestSender, SLACK_THREAD_ACTION } from "../src/lib/slack-comments"
import { authorKind, resolveChannels } from "../src/lib/slack-subscriptions"
import { runDeliveryTick } from "../src/webhooks"
import { as, jsonAs, quotaApp, type TestUser } from "./helpers"

const KEY = "enc-key-slack-routes-123456"
const SIGNING = "slack-signing-secret"
const owner: TestUser = { id: "u-o", email: "o@x.com", name: "O", username: "o" }
const editor: TestUser = { id: "u-e", email: "e@x.com", name: "E", username: "e" }

// Build an app with Slack configured + an owner/editor team. quotaApp wires fake auth
// (x-test-user header → session) and the custom deps. The memberships are seeded
// through quotaApp's `team` arg (4th) so they land inside the store's awaited `ready`
// step — firing meta.setMembership(...) un-awaited here would race activeWorkspace's
// listWorkspaces lookup under Postgres, falling through to provisionPersonal and
// resolving the wrong org (the flaky 404s / stale installs this suite saw).
const make = (name: string) => {
  const { app, meta } = quotaApp(
    name,
    {
      encryptionKey: KEY,
      defaultOrgId: "default",
      slack: { clientId: "cid", clientSecret: "csec", signingSecret: SIGNING },
    },
    [owner, editor],
    [
      { user_id: owner.id, role: "owner" },
      { user_id: editor.id, role: "editor" },
    ],
  )
  return { app, meta }
}

const sign = (ts: string, body: string) =>
  `v0=${createHmac("sha256", SIGNING).update(`v0:${ts}:${body}`).digest("hex")}`

// The events endpoint acks fast and defers ingestion to the outbox; tests drain it by
// hand (no worker runs under quotaApp). A no-op address guard: ingestion isn't an HTTP
// delivery, so there's no URL to SSRF-check.
const drainIngest = (meta: MetaStore) =>
  runDeliveryTick(
    meta,
    { precheck: async () => null },
    { slack_ingest: makeSlackIngestSender(meta, KEY) },
  )

// A signed Slack events POST.
type TestApp = { request: (path: string, init?: RequestInit) => Response | Promise<Response> }
const postEvent = (app: TestApp, body: string) => {
  const ts = String(Math.floor(Date.now() / 1000))
  return app.request("/v1/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sign(ts, body),
    },
    body,
  })
}

// A signed Block Kit interactivity POST (form-encoded: payload=<url-encoded JSON>).
const postInteract = (app: TestApp, payload: unknown) => {
  const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`
  const ts = String(Math.floor(Date.now() / 1000))
  return app.request("/v1/slack/interactivity", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sign(ts, raw),
    },
    body: raw,
  })
}

// A signed slash-command POST (form-encoded fields).
const postCommand = (app: TestApp, fields: Record<string, string>) => {
  const raw = new URLSearchParams(fields).toString()
  const ts = String(Math.floor(Date.now() / 1000))
  return app.request("/v1/slack/commands", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sign(ts, raw),
    },
    body: raw,
  })
}

// "T1" matches the team_id seedResolvable stores on the install (the acting-team authz bind).
const threadAction = (
  artifactId: string,
  threadId: string,
  actionId: string,
  teamId = "T1",
  channelId = "C1",
) => ({
  type: "block_actions",
  response_url: "https://hooks.slack.test/response",
  team: { id: teamId },
  channel: { id: channelId },
  user: { username: "dana" },
  actions: [{ action_id: actionId, value: JSON.stringify({ a: artifactId, t: threadId }) }],
  message: { blocks: [{ type: "section", text: { type: "mrkdwn", text: "a comment" } }] },
})

afterEach(() => vi.unstubAllGlobals())

/** Publish a version onto a bare `createArtifact` fixture and return its number. Artifacts made
 *  by hand start at current_version 0 with no version row; anything that reads a version — a
 *  preview status, most obviously — needs a real one. */
const addV = async (m: MetaStore, artifactId: string): Promise<number> => {
  const v = await m.addVersion(artifactId, {
    id: newId("v"),
    blob_key: "blob-content",
    content_type: "text/markdown",
    size_bytes: 1,
    author: "tester",
    message: null,
  })
  return v.n
}

describe("slack status + admin routes", () => {
  it("defaults Slack review DMs on, review email off, and lets each change independently", async () => {
    const { app } = make("slack-personal-prefs")
    const initial = await (await app.request("/v1/slack", { headers: as(owner.email) })).json()
    expect(initial).toMatchObject({ slack_dm: true, review_email: false })

    const emailOn = await (
      await app.request("/v1/slack/prefs", {
        ...jsonAs(as(owner.email), { review_email: true }),
        method: "PATCH",
      })
    ).json()
    expect(emailOn).toMatchObject({ slack_dm: true, review_email: true })

    const slackOff = await (
      await app.request("/v1/slack/prefs", {
        ...jsonAs(as(owner.email), { slack_dm: false }),
        method: "PATCH",
      })
    ).json()
    expect(slackOff).toMatchObject({ slack_dm: false, review_email: true })
  })

  it("persists an OAuth install and returns an explicit success handoff", async () => {
    const { app, meta } = make("slack-oauth-success")
    const start = await app.request("/v1/slack/install", { headers: as(owner.email) })
    const authorizeUrl = new URL(start.headers.get("location") ?? "")
    const state = authorizeUrl.searchParams.get("state")
    expect(state).toBeTruthy()

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          access_token: "xoxb-oauth",
          bot_user_id: "UBOT",
          team: { id: "T-OAUTH", name: "Acme Slack" },
        }),
      ),
    )
    const callback = await app.request(
      `/v1/slack/oauth/callback?code=oauth-code&state=${encodeURIComponent(state ?? "")}`,
    )

    expect(callback.status).toBe(302)
    expect(callback.headers.get("location")).toBe("/settings/integrations?slack_connected=1")
    expect(await meta.getSlackInstall("default")).toMatchObject({
      team_id: "T-OAUTH",
      team_name: "Acme Slack",
      bot_user_id: "UBOT",
    })
  })

  it("an admin disconnects Slack", async () => {
    const { app, meta } = make("slack-disconnect")
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    const r = await app.request("/v1/slack", { method: "DELETE", headers: as(owner.email) })
    expect(r.status).toBe(204)
    expect(await meta.getSlackInstall("default")).toBe(null)
  })
})

describe("slack account linking (OIDC)", () => {
  const connect = (meta: MetaStore, teamId = "T1") =>
    meta.setSlackInstall({
      org_id: "default",
      team_id: teamId,
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })

  // Stub the two OIDC back-channel calls (token exchange + userInfo).
  //
  // The method names here must be Slack's EXACT spelling. This mock used to match
  // "openid.connect.userinfo" — all lowercase, the same typo the client carried — and an
  // unrecognised URL fell through to `{}`, so the suite stayed green while account linking was
  // impossible in production: Slack's Web API method names are case-sensitive and the lowercase
  // spelling returns `unknown_method`. Two changes stop that recurring: the correct camelCase
  // `userInfo`, and an unstubbed call now THROWS instead of being absorbed as an empty body.
  const stubOidc = (userId: string, teamId: string, email = "o@x.com") =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        const u = String(url)
        if (u.includes("openid.connect.token"))
          return new Response(JSON.stringify({ ok: true, access_token: "xoxp-oidc" }), {
            status: 200,
          })
        if (u.includes("openid.connect.userInfo"))
          return new Response(
            JSON.stringify({
              "https://slack.com/user_id": userId,
              "https://slack.com/team_id": teamId,
              email,
            }),
            { status: 200 },
          )
        throw new Error(`unstubbed Slack call: ${u}`)
      }),
    )

  it("starts the OIDC link flow for a signed-in user of a connected workspace", async () => {
    const { app, meta } = make("slack-link-start")
    await connect(meta)
    const r = await app.request("/v1/slack/link", { headers: as(owner.email), redirect: "manual" })
    expect(r.status).toBe(302)
    const loc = r.headers.get("location") ?? ""
    expect(loc).toContain("slack.com/openid/connect/authorize")
    expect(loc).toContain("scope=openid")
    expect(loc).toContain("team=T1") // pre-selects the connected workspace
  })

  it("stores a link on callback, bound to the user in the signed state", async () => {
    const { app, meta } = make("slack-link-cb")
    await connect(meta)
    stubOidc("U777", "T1")
    const state = signState({ org: "default", uid: owner.id }, KEY)
    const r = await app.request(
      `/v1/slack/link/callback?code=abc&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: as(owner.email) },
    )
    expect(r.status).toBe(302)
    // The account-link affordance lives under You → Notifications now.
    expect(r.headers.get("location")).toBe("/settings/notifications")
    const link = await meta.getSlackUserLinkBySlackId("T1", "U777")
    expect(link?.user_id).toBe(owner.id)
    // Reverse + forward lookups both resolve.
    expect((await meta.getSlackUserLinkByUser("T1", owner.id))?.slack_user_id).toBe("U777")
    // Status now reports linked for that user.
    const status = await (await app.request("/v1/slack", { headers: as(owner.email) })).json()
    expect(status.linked).toBe(true)
  })

  it("rejects a linked identity from a different Slack team than the install", async () => {
    const { app, meta } = make("slack-link-team")
    await connect(meta, "T1")
    stubOidc("U777", "T-OTHER") // userinfo says a different team
    const state = signState({ org: "default", uid: owner.id }, KEY)
    const r = await app.request(
      `/v1/slack/link/callback?code=abc&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: as(owner.email) },
    )
    expect(r.status).toBe(302)
    expect(r.headers.get("location")).toContain("error=link_team")
    expect(await meta.getSlackUserLinkBySlackId("T-OTHER", "U777")).toBe(null)
    expect(await meta.getSlackUserLinkByUser("T1", owner.id)).toBe(null)
  })

  it("rejects a callback whose session isn't the user in the signed state (link-CSRF guard)", async () => {
    const { app, meta } = make("slack-link-csrf")
    await connect(meta)
    stubOidc("U777", "T1")
    // State was minted for `owner`, but `editor` completes the callback — must not link.
    const state = signState({ org: "default", uid: owner.id }, KEY)
    const r = await app.request(
      `/v1/slack/link/callback?code=abc&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: as(editor.email) },
    )
    expect(r.status).toBe(302)
    expect(r.headers.get("location")).toContain("error=link")
    expect(await meta.getSlackUserLinkBySlackId("T1", "U777")).toBe(null)
    expect(await meta.getSlackUserLinkByUser("T1", owner.id)).toBe(null)
  })

  it("unlinks the caller's Slack identity", async () => {
    const { app, meta } = make("slack-link-unlink")
    await connect(meta)
    await meta.setSlackUserLink({
      id: "sul-1",
      org_id: "default",
      user_id: owner.id,
      team_id: "T1",
      slack_user_id: "U777",
      origin: "oauth" as const,
      checked_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    const r = await app.request("/v1/slack/link", { method: "DELETE", headers: as(owner.email) })
    expect(r.status).toBe(204)
    expect(await meta.getSlackUserLinkByUser("T1", owner.id)).toBe(null)
  })
})

describe("slack events endpoint", () => {
  it("rejects an unsigned/badly-signed request", async () => {
    const { app } = make("slack-ev-badsig")
    const r = await app.request("/v1/slack/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "url_verification", challenge: "x" }),
    })
    expect(r.status).toBe(401)
  })

  const seedThread = async (
    meta: MetaStore,
    ids: { artifact: string; short: string; thread: string; ts: string },
  ) => {
    const artifact = await meta.createArtifact({
      id: ids.artifact,
      short_id: ids.short,
      org_id: "default",
      slug: null,
      title: "Doc",
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
      kind: "file",
      spa: 0,
    })
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    await meta.upsertSlackSubscription({
      id: `sub-${ids.thread}`,
      org_id: "default",
      channel_id: "C1",
    })
    await meta.setSlackThreadLink({
      id: `stl-${ids.thread}`,
      org_id: "default",
      artifact_id: artifact.id,
      thread_id: ids.thread,
      channel: "C1",
      message_ts: ids.ts,
      created_at: new Date().toISOString(),
    })
    return artifact
  }

  it("acks fast and defers a linked thread reply to the outbox, which then mirrors it", async () => {
    const { app, meta } = make("slack-ev-reply")
    const artifact = await seedThread(meta, {
      artifact: "a-slack-reply",
      short: "slkreply",
      thread: "t-root",
      ts: "111.1",
    })
    // Slack users.info lookup → display name (only hit on drain, never in the request).
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, user: { profile: { display_name: "Dana" } } }), {
            status: 200,
          }),
      ),
    )

    const r = await postEvent(
      app,
      JSON.stringify({
        type: "event_callback",
        event: {
          type: "message",
          user: "U777",
          text: "from slack",
          channel: "C1",
          ts: "222.2",
          thread_ts: "111.1",
        },
      }),
    )
    expect(r.status).toBe(200)
    // The endpoint acked without doing the ingest work (no users.info fetch, no comment yet).
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
    expect(await meta.listComments(artifact.id)).toHaveLength(0)

    // The worker drains the enqueued slack_ingest delivery and mirrors the reply.
    await drainIngest(meta)
    const mirrored = (await meta.listComments(artifact.id)).find((c) => c.thread_id === "t-root")
    expect(mirrored?.author).toBe("Dana")
    expect(mirrored?.author_id).toBe("slack:U777")
    expect(mirrored?.body_md).toBe("from slack")
  })

  it("repairs an agent wake when an ingest retry finds the already-committed Slack answer", async () => {
    const { meta } = make("slack-ingest-recover-wake")
    const artifact = await seedThread(meta, {
      artifact: "a-slack-recover-wake",
      short: "slkwake",
      thread: "t-wake",
      ts: "555.1",
    })
    const agent = await meta.createAgent({
      id: "ag-slack-wake",
      org_id: "default",
      name: "Research agent",
      token: "agent-token",
      role: "editor",
      created_by: owner.id,
    })
    await meta.createComment({
      id: "c-agent-question",
      artifact_id: artifact.id,
      thread_id: "t-wake",
      base_version: 0,
      path: null,
      anchor: null,
      body_md: "Could you confirm this?",
      author: agent.name,
      author_id: agent.id,
    })
    // This simulates the crash window: the comment INSERT committed, but the process died
    // before it made the agent's inbox row. The retried delivery must recover that wake.
    const answer = await meta.createComment({
      id: "c-slack-answer",
      artifact_id: artifact.id,
      thread_id: "t-wake",
      base_version: 0,
      path: null,
      anchor: null,
      body_md: "Yes, confirmed.",
      author: editor.name ?? "Editor",
      author_id: editor.id,
      meta: JSON.stringify({ slack: { ts: "555.2", channel: "C1" } }),
    })
    await meta.setSlackUserLink({
      id: "sul-editor-wake",
      org_id: "default",
      user_id: editor.id,
      team_id: "T1",
      slack_user_id: "UEDITOR",
      origin: "oauth",
      checked_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, user: { profile: {} } }))),
    )
    const publish = vi.fn()
    const send = makeSlackIngestSender(meta, KEY, { publish })
    const result = await send({
      payload: JSON.stringify({
        channel: "C1",
        threadTs: "555.1",
        userId: "UEDITOR",
        text: answer.body_md,
        ts: "555.2",
      }),
    } as DeliveryRecord)

    expect(result).toMatchObject({ ok: true, status: "skipped: own or duplicate" })
    const inbox = await meta.listPendingAgentMentions(agent.id, 10)
    expect(inbox).toMatchObject([
      { comment_id: answer.id, kind: "thread_reply", body: "Yes, confirmed." },
    ])
    expect(publish).toHaveBeenCalledWith(artifact.id, { type: "comment.created" })

    // Repeating the recovery is safe: stable inbox identity + conflict-ignore gives the agent
    // one item, not a duplicate task.
    await notifyThreadReplyAgents({ meta, bus: { publish } }, artifact, answer, editor.id)
    expect(await meta.listPendingAgentMentions(agent.id, 10)).toHaveLength(1)
  })

  it("the deferred ingest ignores our own bot's messages (loop prevention)", async () => {
    const { app, meta } = make("slack-ev-bot")
    const artifact = await seedThread(meta, {
      artifact: "a-slack-bot",
      short: "slkbot01",
      thread: "t-bot",
      ts: "333.3",
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    )
    const r = await postEvent(
      app,
      JSON.stringify({
        type: "event_callback",
        event: {
          type: "message",
          user: "UBOT",
          text: "echo",
          channel: "C1",
          ts: "444.4",
          thread_ts: "333.3",
        },
      }),
    )
    expect(r.status).toBe(200)
    await drainIngest(meta)
    expect(await meta.listComments(artifact.id)).toHaveLength(0)
  })

  it("a redelivered reply (at-least-once) still yields exactly one comment", async () => {
    const { app, meta } = make("slack-ev-dedupe")
    const artifact = await seedThread(meta, {
      artifact: "a-slack-dup",
      short: "slkdup01",
      thread: "t-dup",
      ts: "555.5",
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, user: { profile: { display_name: "Dana" } } }), {
            status: 200,
          }),
      ),
    )
    const body = JSON.stringify({
      type: "event_callback",
      event: {
        type: "message",
        user: "U9",
        text: "hi",
        channel: "C1",
        ts: "666.6",
        thread_ts: "555.5",
      },
    })
    // Slack redelivers the same event → two enqueued deliveries, drained together.
    expect((await postEvent(app, body)).status).toBe(200)
    expect((await postEvent(app, body)).status).toBe(200)
    await drainIngest(meta)
    await drainIngest(meta)
    const mirrored = (await meta.listComments(artifact.id)).filter((c) => c.thread_id === "t-dup")
    expect(mirrored).toHaveLength(1)
  })

  it("attributes a reply from a linked Slack user to their Derive account", async () => {
    const { app, meta } = make("slack-ev-linked")
    const artifact = await seedThread(meta, {
      artifact: "a-slk-lnk",
      short: "slklnk01",
      thread: "t-lnk",
      ts: "888.1",
    })
    // U777 has linked their Slack identity to `owner` (display name "O").
    await meta.setSlackUserLink({
      id: "sul-x",
      org_id: "default",
      user_id: owner.id,
      team_id: "T1",
      slack_user_id: "U777",
      origin: "oauth" as const,
      checked_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: true, user: { profile: { display_name: "SlackName" } } }),
            { status: 200 },
          ),
      ),
    )
    await postEvent(
      app,
      JSON.stringify({
        type: "event_callback",
        event: {
          type: "message",
          user: "U777",
          text: "hi",
          channel: "C1",
          ts: "889.2",
          thread_ts: "888.1",
        },
      }),
    )
    await drainIngest(meta)
    const cm = (await meta.listComments(artifact.id)).find((c) => c.thread_id === "t-lnk")
    expect(cm?.author_id).toBe(owner.id) // the Derive user, not "slack:U777"
    expect(cm?.author).toBe("O") // the Derive display name, not the Slack one
  })

  it("enqueues nothing for a reply on a channel with no Derive thread link", async () => {
    const { app, meta } = make("slack-ev-nolink")
    const r = await postEvent(
      app,
      JSON.stringify({
        type: "event_callback",
        event: {
          type: "message",
          user: "U1",
          text: "hi",
          channel: "CZZZ",
          ts: "9.9",
          thread_ts: "8.8",
        },
      }),
    )
    expect(r.status).toBe(200)
    // No thread link ⇒ no delivery enqueued (we don't flood the outbox with channel chatter).
    const rows = await meta.claimDueDeliveries(
      new Date(Date.now() + 60_000).toISOString(),
      100,
      new Date(Date.now() + 120_000).toISOString(),
    )
    expect(rows.some((d) => d.kind === "slack_ingest")).toBe(false)
  })

  // Removing the app in Slack, or revoking its token, kills the bot token — but Derive only
  // found out the next time a delivery failed. A workspace with no Slack traffic showed
  // "connected" indefinitely and its Settings page offered no reconnect. Slack tells us
  // directly if we subscribe, and neither event costs a scope.
  const uninstallCases = [
    { type: "app_uninstalled", event: { type: "app_uninstalled" }, label: "the app is removed" },
    {
      type: "tokens_revoked",
      event: { type: "tokens_revoked", tokens: { bot: ["UBOT"] } },
      label: "the BOT token is revoked",
    },
  ]
  for (const { type, event, label } of uninstallCases) {
    it(`flags the install for re-auth when ${label}`, async () => {
      const { app, meta } = make(`slack-ev-${type}`)
      await meta.setSlackInstall({
        org_id: "default",
        team_id: "T1",
        team_name: "Acme",
        bot_token: encryptSecret("xoxb-1", KEY),
        bot_user_id: "UBOT",
        created_at: new Date().toISOString(),
      })
      await meta.upsertSlackSubscription({ id: newId("sub"), org_id: "default", channel_id: "C1" })
      const r = await postEvent(
        app,
        JSON.stringify({ type: "event_callback", team_id: "T1", event }),
      )
      expect(r.status).toBe(200)
      const install = await meta.getSlackInstall("default")
      expect(install?.needs_reauth).toBe(1)
      // Flagged, never deleted: the workspace's channel subscriptions and the members' account
      // links must survive a reconnect, and the banner is what prompts one.
      expect(await meta.listSlackSubscriptions("default")).toHaveLength(1)
    })
  }

  // tokens_revoked carries WHICH tokens died: `oauth` = per-user tokens, `bot` = the bot's.
  // A member who linked their Slack identity and later revokes that authorization (or is
  // deactivated, which revokes it for them) produces an oauth-only revocation while the bot
  // token keeps working. Treating that as a dead install let any unprivileged member raise a
  // sticky, workspace-wide "Slack rejected the connection" banner that only a full reconnect
  // clears — and they could re-link and do it again.
  const seedInstall = (
    meta: Awaited<ReturnType<typeof make>>["meta"],
    org = "default",
    botUserId: string | null = "UBOT",
  ) =>
    meta.setSlackInstall({
      org_id: org,
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: botUserId,
      created_at: new Date().toISOString(),
    })

  it("ignores a revocation that only killed per-user tokens", async () => {
    const { app, meta } = make("slack-ev-oauth-only")
    await seedInstall(meta)
    const r = await postEvent(
      app,
      JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event: { type: "tokens_revoked", tokens: { oauth: ["U123"] } },
      }),
    )
    expect(r.status).toBe(200)
    expect((await meta.getSlackInstall("default"))?.needs_reauth).toBe(0)
  })

  it("ignores a revocation naming a different app's bot", async () => {
    const { app, meta } = make("slack-ev-other-bot")
    await seedInstall(meta)
    const r = await postEvent(
      app,
      JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event: { type: "tokens_revoked", tokens: { bot: ["USOMEONEELSE"] } },
      }),
    )
    expect(r.status).toBe(200)
    expect((await meta.getSlackInstall("default"))?.needs_reauth).toBe(0)
  })

  // The whole reason the lookup returns a LIST: two Derive workspaces can connect the same
  // Slack team, and an uninstall kills the app for both. With one install seeded, every test
  // above would pass a lookup that returned only its first match.
  it("flags EVERY workspace connected to that team", async () => {
    const { app, meta } = make("slack-ev-uninstall-plural")
    await seedInstall(meta, "default")
    await seedInstall(meta, "second-org")
    const r = await postEvent(
      app,
      JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event: { type: "app_uninstalled" },
      }),
    )
    expect(r.status).toBe(200)
    expect((await meta.getSlackInstall("default"))?.needs_reauth).toBe(1)
    expect((await meta.getSlackInstall("second-org"))?.needs_reauth).toBe(1)
  })

  it("leaves another workspace's install alone", async () => {
    const { app, meta } = make("slack-ev-uninstall-scope")
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    const r = await postEvent(
      app,
      JSON.stringify({
        type: "event_callback",
        team_id: "T-OTHER",
        event: { type: "app_uninstalled" },
      }),
    )
    expect(r.status).toBe(200)
    expect((await meta.getSlackInstall("default"))?.needs_reauth).toBe(0)
  })
})

describe("a click only acts on the channel it came from", () => {
  // The whole point of keying links (thread, channel): a thread mirrored into #eng must not be
  // resolvable by a click that claims to come from somewhere it was never posted.
  const seedFor = async (meta: MetaStore) => {
    const artifact = await meta.createArtifact({
      id: "a-wc",
      short_id: "wc000001",
      org_id: "default",
      slug: null,
      title: "Doc",
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
      kind: "file",
      spa: 0,
    })
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    await meta.upsertSlackSubscription({ id: "sub-wc", org_id: "default", channel_id: "C1" })
    await meta.setSlackThreadLink({
      id: "stl-wc",
      org_id: "default",
      artifact_id: artifact.id,
      thread_id: "th-wc",
      channel: "C1",
      message_ts: "1700000000.9",
      created_at: new Date().toISOString(),
    })
    await meta.createComment({
      id: "c-wc",
      artifact_id: artifact.id,
      thread_id: "th-wc",
      base_version: 0,
      path: null,
      anchor: null,
      body_md: "root",
      author: "Ada",
      author_id: owner.id,
    })
    return artifact
  }

  it("refuses a Resolve click whose channel isn't where the thread is mirrored", async () => {
    const { app, meta } = make("int-wrong-channel")
    const artifact = await seedFor(meta)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    )
    const r = await postInteract(
      app,
      threadAction(artifact.id, "th-wc", SLACK_THREAD_ACTION.resolve, "T1", "C-ELSEWHERE"),
    )
    expect(r.status).toBe(200)
    expect((await meta.getComment("c-wc"))?.state).toBe("open")
  })
})

describe("unsubscribing really disconnects a channel", () => {
  // Deleting the workspace-wide `slackPost` toggle removed the only kill switch for INBOUND
  // Slack writes. Thread links outlive an unsubscribe — nothing deletes them — so both of these
  // kept working in a channel an admin had deliberately cut off, while /derive unsubscribe
  // answered "Derive won't post here".
  const seed = async (meta: MetaStore, name: string) => {
    const artifact = await meta.createArtifact({
      id: `a-${name}`,
      short_id: `s${name}`.slice(0, 8),
      org_id: "default",
      slug: null,
      title: "Doc",
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
      kind: "file",
      spa: 0,
    })
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    await meta.setSlackThreadLink({
      id: `stl-${name}`,
      org_id: "default",
      artifact_id: artifact.id,
      thread_id: `th-${name}`,
      channel: "C1",
      message_ts: "1700000000.1",
      created_at: new Date().toISOString(),
    })
    await meta.createComment({
      id: `c-${name}`,
      artifact_id: artifact.id,
      thread_id: `th-${name}`,
      base_version: 0,
      path: null,
      anchor: null,
      body_md: "root",
      author: "Ada",
      author_id: owner.id,
    })
    return artifact
  }

  it("stops ingesting replies once no channel subscription remains", async () => {
    const { app, meta } = make("unsub-ingest")
    const artifact = await seed(meta, "ing")
    const before = (await meta.listComments(artifact.id)).length
    await postEvent(
      app,
      JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event: {
          type: "message",
          user: "U9",
          text: "a reply",
          channel: "C1",
          ts: "1700000001.5",
          thread_ts: "1700000000.1",
        },
      }),
    )
    await drainIngest(meta)
    // No subscription was ever created, so the reply must not become a Derive comment.
    expect((await meta.listComments(artifact.id)).length).toBe(before)
  })

  it("stops honouring Resolve clicks once no channel subscription remains", async () => {
    const { app, meta } = make("unsub-click")
    const artifact = await seed(meta, "clk")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    )
    const r = await postInteract(
      app,
      threadAction(artifact.id, "th-clk", SLACK_THREAD_ACTION.resolve),
    )
    expect(r.status).toBe(200)
    expect((await meta.getComment("c-clk"))?.state).toBe("open")
  })
})

describe("/derive subscription subcommands", () => {
  const linked = async (meta: Awaited<ReturnType<typeof make>>["meta"], role = "owner") => {
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    await meta.setSlackUserLink({
      id: newId("sul"),
      org_id: "default",
      user_id: role === "owner" ? owner.id : editor.id,
      team_id: "T1",
      slack_user_id: "U1",
      origin: "oauth" as const,
      checked_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
  }
  const cmd = (app: Parameters<typeof postCommand>[0], text: string) =>
    postCommand(app, {
      team_id: "T1",
      user_id: "U1",
      channel_id: "C-eng",
      channel_name: "eng",
      text,
      response_url: "https://hooks.slack.test/r",
    })

  // Run in the channel it acts on, so there is never a raw channel id to type — the reason
  // GitHub's `/github subscribe` reads better than pasting one into a settings form.
  it("subscribes the channel it was run in", async () => {
    const { app, meta } = make("cmd-subscribe")
    await linked(meta)
    const r = await (await cmd(app, "subscribe")).json()
    expect(String(r.text)).toContain("whole workspace")
    const subs = await meta.listSlackSubscriptions("default")
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({
      channel_id: "C-eng",
      channel_name: "eng",
      scope_kind: "workspace",
    })
  })

  it("scopes to a collection by name", async () => {
    const { app, meta } = make("cmd-subscribe-col")
    await linked(meta)
    await meta.createCollection({
      id: "col_brand",
      org_id: "default",
      title: "Brand",
      created_by: owner.id,
    })
    const r = await (await cmd(app, "subscribe Brand")).json()
    expect(String(r.text)).toContain("Brand")
    expect((await meta.listSlackSubscriptions("default"))[0]).toMatchObject({
      scope_kind: "collection",
      scope_id: "col_brand",
    })
    // An unknown name is a clear refusal, not a silent workspace-wide subscribe.
    const miss = await (await cmd(app, "subscribe Nope")).json()
    expect(String(miss.text)).toContain("No collection")
    expect(await meta.listSlackSubscriptions("default")).toHaveLength(1)
  })

  // A private channel the app was never invited to accepts the subscription and then drops every
  // delivery into the dead-letter queue with nothing saying why.
  it("refuses to subscribe a channel it cannot post in, and says how to fix it", async () => {
    const { app, meta } = make("cmd-unreachable")
    await linked(meta)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) =>
        String(u).includes("conversations.info")
          ? new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    )
    const r = await (await cmd(app, "subscribe")).json()
    expect(String(r.text)).toContain("/invite @Derive")
    expect(await meta.listSlackSubscriptions("default")).toHaveLength(0)
  })

  it("unsubscribes the channel, and reports settings", async () => {
    const { app, meta } = make("cmd-unsubscribe")
    await linked(meta)
    await cmd(app, "subscribe")
    const shown = await (await cmd(app, "settings")).json()
    expect(JSON.stringify(shown.blocks)).toContain("whole workspace")
    await cmd(app, "unsubscribe")
    expect(await meta.listSlackSubscriptions("default")).toHaveLength(0)
    const empty = await (await cmd(app, "settings")).json()
    expect(JSON.stringify(empty.blocks)).toContain("doesn't post in this channel")
  })

  // Changing what a channel receives is an admin action, so being linked is not enough.
  it("refuses a non-admin", async () => {
    const { app, meta } = make("cmd-nonadmin")
    await linked(meta, "editor")
    const r = await (await cmd(app, "subscribe")).json()
    expect(String(r.text)).toContain("admin")
    expect(await meta.listSlackSubscriptions("default")).toHaveLength(0)
  })
})

describe("slack link unfurls", () => {
  // The route-level wiring: a signed link_shared reaches chat.unfurl with the right target.
  // The decision ladder itself is unit-tested in slack-unfurl.test.ts.
  it("unfurls a shared artifact link for a linked sharer", async () => {
    const { app, meta } = make("slack-unfurl-route")
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    await meta.setSlackUserLink({
      id: newId("sul"),
      org_id: "default",
      user_id: owner.id,
      team_id: "T1",
      slack_user_id: "U1",
      origin: "oauth" as const,
      checked_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    const artifact = await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s").slice(0, 8),
      org_id: "default",
      slug: null,
      title: "Q4 roadmap",
      workspace_access: "member",
      link_role: "viewer",
      listed: "workspace",
      kind: "file",
      spa: 0,
    })

    // The unfurl runs behind the ack (runAfterAck), so settle on the stub rather than a sleep.
    let fired: (v: unknown) => void = () => {}
    const called = new Promise((r) => {
      fired = r
    })
    const seen: Record<string, unknown>[] = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (String(url).includes("chat.unfurl")) {
        seen.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        fired(null)
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    const r = await postEvent(
      app,
      JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event: {
          type: "link_shared",
          user: "U1",
          channel: "C9",
          message_ts: "1700000000.1",
          links: [{ url: `http://derive.test/artifacts/${artifact.short_id}` }],
        },
      }),
    )
    expect(r.status).toBe(200)
    await called
    expect(seen[0]?.channel).toBe("C9")
    expect(seen[0]?.ts).toBe("1700000000.1")
    // A Work Object, not blocks: a typed entity Slack renders itself, keyed on the artifact's
    // stable short id (the key its search and related-conversation aggregation both use).
    const ents = (seen[0]?.metadata as { entities?: Record<string, unknown>[] })?.entities
    expect(ents).toHaveLength(1)
    const ent = ents?.[0] as Record<string, unknown>
    expect(ent.entity_type).toBe("slack#/entities/content_item")
    expect((ent.external_ref as { id: string }).id).toBe(artifact.short_id)
    expect(JSON.stringify(ent.entity_payload)).toContain("Q4 roadmap")
    // Every image carries alt_text. Its absence is this API's documented SILENT failure: a 200
    // with a buried warning, and an empty channel.
    const payload = JSON.stringify(ent.entity_payload)
    for (const m of payload.matchAll(/"url":"[^"]*"/g)) void m
    expect(payload).toContain('"alt_text"')
  })

  // THE SCREENSHOT ON THE CARD.
  //
  // Slack fetches preview images anonymously, so for anything short of world-readable the card
  // used to show /v1/og's title-less padlock — on precisely the docs people paste most. A
  // signed, version-pinned token (lib/og-token.ts) buys that one image without loosening the
  // endpoint for anyone else. The line is drawn at ACCESS: `workspace_access === "member"`
  // means every member of the org may read it — the default team draft included — and a channel
  // in that org's own Slack is substantially that audience. An artifact granting the workspace
  // nothing is what somebody chose when they meant private, and it must stay a padlock.
  const unfurlEntity = async (
    name: string,
    access: {
      listed: "workspace" | "none" | "public"
      workspace_access?: "member" | "none"
    },
    rendered = true,
  ) => {
    const { listed, workspace_access = "member" } = access
    const { app, meta } = make(name)
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    await meta.setSlackUserLink({
      id: newId("sul"),
      org_id: "default",
      user_id: owner.id,
      team_id: "T1",
      slack_user_id: "U1",
      origin: "oauth" as const,
      checked_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    const artifact = await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s").slice(0, 8),
      org_id: "default",
      slug: null,
      title: "Q4 roadmap",
      workspace_access,
      link_role: listed === "public" ? "viewer" : "none",
      listed,
      kind: "file",
      spa: 0,
    })
    // A doc granting the workspace nothing is readable only through an explicit share — give
    // the sharer one, so the test exercises the broadcast gate rather than the read check
    // (a sharer without standing skips long before any card is considered).
    if (workspace_access === "none")
      await meta.setArtifactMember({
        id: newId("am"),
        artifact_id: artifact.id,
        user_id: owner.id,
        role: "viewer",
      })
    // `createArtifact` alone leaves current_version = 0 and no version row — a shape production
    // never has, because publishing makes v1. Give it one, then decide whether it has rendered:
    // renders are enqueued in the BACKGROUND after a publish, so the unrendered window is real
    // and gets its own test below.
    const v = await addV(meta, artifact.id)
    if (rendered)
      await meta.setVersionPreview(artifact.id, v, {
        preview_key: "blob-og",
        preview_status: "ready",
      })
    let fired: (v: unknown) => void = () => {}
    const called = new Promise((r) => {
      fired = r
    })
    const seen: Record<string, unknown>[] = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (String(url).includes("chat.unfurl")) {
        seen.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        fired(null)
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    await postEvent(
      app,
      JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event: {
          type: "link_shared",
          user: "U1",
          channel: "C9",
          message_ts: "1700000000.1",
          links: [{ url: `http://derive.test/artifacts/${artifact.short_id}` }],
        },
      }),
    )
    await called
    const ents = (seen[0]?.metadata as { entities?: Record<string, unknown>[] })?.entities
    return { entity: ents?.[0] as Record<string, unknown> | undefined, artifact }
  }

  const fullSizePreview = (entity: Record<string, unknown> | undefined) =>
    (
      (entity?.entity_payload as { attributes?: Record<string, unknown> })?.attributes as {
        full_size_preview?: { preview_url?: string }
      }
    )?.full_size_preview

  it("carries a signed screenshot URL for a workspace-listed doc", async () => {
    const { entity, artifact } = await unfurlEntity("slack-unfurl-preview-ws", {
      listed: "workspace",
    })
    const url = new URL(fullSizePreview(entity)?.preview_url ?? "")
    expect(url.pathname).toContain(`/v1/og/${artifact.short_id}`)
    // The token is the whole mechanism — without it Slack's anonymous fetch gets the padlock.
    expect(url.searchParams.get("t")).toBeTruthy()
  })

  it("carries a signed screenshot URL for a team draft — access broadcasts, not listing", async () => {
    // The default publish shape: workspace_access=member, listed=none. Every member of the
    // workspace behind this Slack team may open it, so the card shows the real thing — title
    // and tokened screenshot — exactly as a workspace-LISTED doc does. `listed` is discovery,
    // not access, and must not decide a broadcast.
    const { entity, artifact } = await unfurlEntity("slack-unfurl-preview-draft", {
      listed: "none",
      workspace_access: "member",
    })
    expect(JSON.stringify(entity)).toContain("Q4 roadmap")
    const url = new URL(fullSizePreview(entity)?.preview_url ?? "")
    expect(url.pathname).toContain(`/v1/og/${artifact.short_id}`)
    expect(url.searchParams.get("t")).toBeTruthy()
  })

  it("carries NO screenshot for a doc somebody kept private", async () => {
    // Grants the workspace nothing and is unlisted → the locked card, which is title-less by
    // construction — so there is nothing to mint a token for, and nothing that could be minted
    // by mistake.
    const { entity } = await unfurlEntity("slack-unfurl-preview-none", {
      listed: "none",
      workspace_access: "none",
    })
    expect(JSON.stringify(entity)).not.toContain("full_size_preview")
    expect(JSON.stringify(entity)).not.toContain("Q4 roadmap")
  })

  it("waits for the render rather than showing a padlock as the picture", async () => {
    // The window this closes: a link pasted moments after publishing. `/v1/og` answers an
    // anonymous fetch for an unrendered workspace doc with the TITLE-LESS padlock, so offering
    // the URL would put a padlock graphic on the card beside the title we are already showing —
    // the exact outcome the block card avoided by carrying no image at all.
    const { entity } = await unfurlEntity(
      "slack-unfurl-preview-pending",
      { listed: "workspace" },
      false,
    )
    expect(JSON.stringify(entity)).toContain("Q4 roadmap")
    expect(JSON.stringify(entity)).not.toContain("full_size_preview")
  })

  // An unlinked sharer gets Slack's own sign-in prompt instead of a card — the only per-person
  // surface chat.unfurl offers, and the first proactive nudge to link an account.
  it("prompts an unlinked sharer to connect, with no cards", async () => {
    const { app, meta } = make("slack-unfurl-unlinked-route")
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    let fired: (v: unknown) => void = () => {}
    const called = new Promise((r) => {
      fired = r
    })
    const seen: Record<string, unknown>[] = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (String(url).includes("chat.unfurl")) {
        seen.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        fired(null)
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    await postEvent(
      app,
      JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event: {
          type: "link_shared",
          user: "U-NOTLINKED",
          channel: "C9",
          message_ts: "1700000000.2",
          links: [{ url: "http://derive.test/artifacts/whatever1" }],
        },
      }),
    )
    await called
    expect(seen[0]?.user_auth_required).toBe(true)
    expect(String(seen[0]?.user_auth_url)).toContain("/v1/slack/link")
    expect(seen[0]?.unfurls).toEqual({})
  })
})

describe("slack interactivity endpoint (resolve/reopen from a button)", () => {
  // Seed an artifact + connected install + a thread link + a root comment to act on.
  const seedResolvable = async (
    meta: MetaStore,
    ids: { artifact: string; short: string; thread: string },
  ) => {
    const artifact = await meta.createArtifact({
      id: ids.artifact,
      short_id: ids.short,
      org_id: "default",
      slug: null,
      title: "Doc",
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
      kind: "file",
      spa: 0,
    })
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    await meta.upsertSlackSubscription({
      id: `sub-${ids.thread}`,
      org_id: "default",
      channel_id: "C1",
    })
    await meta.setSlackThreadLink({
      id: `stl-${ids.thread}`,
      org_id: "default",
      artifact_id: artifact.id,
      thread_id: ids.thread,
      channel: "C1",
      message_ts: `${ids.thread}.1`,
      created_at: new Date().toISOString(),
    })
    // A root comment (thread_id === id) so there's a thread to flip and assert on.
    await meta.createComment({
      id: ids.thread,
      artifact_id: artifact.id,
      thread_id: ids.thread,
      base_version: 0,
      path: null,
      anchor: null,
      body_md: "hi",
      author: "A",
      author_id: "u1",
    })
    return artifact
  }

  it("rejects an unsigned or wrongly-signed interactivity request", async () => {
    const { app } = make("slack-int-badsig")
    const unsigned = await app.request("/v1/slack/interactivity", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "payload=%7B%7D",
    })
    expect(unsigned.status).toBe(401)
    // A present-but-wrong signature is also rejected (constant-time compare, not "any v0=").
    const ts = String(Math.floor(Date.now() / 1000))
    const wrong = await app.request("/v1/slack/interactivity", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": "v0=deadbeef",
      },
      body: "payload=%7B%7D",
    })
    expect(wrong.status).toBe(401)
  })

  it("ignores a click whose Slack team does not own the thread's org (cross-org guard)", async () => {
    const { app, meta } = make("slack-int-xorg")
    const artifact = await seedResolvable(meta, {
      artifact: "a-int-x",
      short: "intxor01",
      thread: "c-int-x",
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    )
    // Signed + valid ids, but the acting team ("T-EVIL") isn't the org's install team ("T1").
    const r = await postInteract(
      app,
      threadAction(artifact.id, "c-int-x", SLACK_THREAD_ACTION.resolve, "T-EVIL"),
    )
    expect(r.status).toBe(200)
    const cm = (await meta.listComments(artifact.id)).find((c) => c.id === "c-int-x")
    expect(cm?.state).toBe("open") // not resolved — the team bind blocked it
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it("a signed Resolve click resolves the thread and updates the message", async () => {
    const { app, meta } = make("slack-int-resolve")
    const artifact = await seedResolvable(meta, {
      artifact: "a-int-r",
      short: "intres01",
      thread: "c-int-r",
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    )

    const r = await postInteract(
      app,
      threadAction(artifact.id, "c-int-r", SLACK_THREAD_ACTION.resolve),
    )
    expect(r.status).toBe(200)
    const cm = (await meta.listComments(artifact.id)).find((c) => c.id === "c-int-r")
    expect(cm?.state).toBe("resolved")

    // The card was replaced via response_url with a Reopen button.
    const call = vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes("hooks.slack.test"))
    expect(call).toBeTruthy()
    const sent = JSON.parse(String(call?.[1]?.body))
    expect(sent.replace_original).toBe(true)
    expect(JSON.stringify(sent.blocks)).toContain(SLACK_THREAD_ACTION.reopen)
  })

  it("escapes the acting Slack username in the replaced card (no mrkdwn injection)", async () => {
    const { app, meta } = make("slack-int-escape-who")
    const artifact = await seedResolvable(meta, {
      artifact: "a-int-w",
      short: "intwho01",
      thread: "c-int-w",
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    )
    // A crafted Slack display name lands in the card footer's mrkdwn context block.
    const payload = {
      ...threadAction(artifact.id, "c-int-w", SLACK_THREAD_ACTION.resolve),
      user: { username: "<!channel>" },
    }
    const r = await postInteract(app, payload)
    expect(r.status).toBe(200)
    const call = vi.mocked(fetch).mock.calls.find(([u]) => String(u).includes("hooks.slack.test"))
    const sent = JSON.stringify(JSON.parse(String(call?.[1]?.body)).blocks)
    expect(sent).not.toContain("<!channel>")
    expect(sent).toContain("&lt;!channel&gt;")
  })

  it("a Reopen click reopens a resolved thread", async () => {
    const { app, meta } = make("slack-int-reopen")
    const artifact = await seedResolvable(meta, {
      artifact: "a-int-o",
      short: "intreo01",
      thread: "c-int-o",
    })
    await meta.setThreadState(artifact.id, "c-int-o", "resolved")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    )

    const r = await postInteract(
      app,
      threadAction(artifact.id, "c-int-o", SLACK_THREAD_ACTION.reopen),
    )
    expect(r.status).toBe(200)
    const cm = (await meta.listComments(artifact.id)).find((c) => c.id === "c-int-o")
    expect(cm?.state).toBe("open")
  })

  it("ignores a click whose thread has no link (no forged targets)", async () => {
    const { app, meta } = make("slack-int-nolink")
    // An artifact + comment, but NO slack_thread_link for the thread.
    const artifact = await meta.createArtifact({
      id: "a-int-n",
      short_id: "intnol01",
      org_id: "default",
      slug: null,
      title: "Doc",
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
      kind: "file",
      spa: 0,
    })
    await meta.createComment({
      id: "c-int-n",
      artifact_id: artifact.id,
      thread_id: "c-int-n",
      base_version: 0,
      path: null,
      anchor: null,
      body_md: "hi",
      author: "A",
      author_id: "u1",
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    )
    const r = await postInteract(
      app,
      threadAction(artifact.id, "c-int-n", SLACK_THREAD_ACTION.resolve),
    )
    expect(r.status).toBe(200)
    const cm = (await meta.listComments(artifact.id)).find((c) => c.id === "c-int-n")
    expect(cm?.state).toBe("open")
  })
})

describe("slack slash command (/derive)", () => {
  // An account link alone is no longer enough: the command also requires Slack to still be
  // CONNECTED, because disconnecting drops the install while leaving every member's link, and
  // a disconnected workspace was still answering /derive.
  const link = async (meta: MetaStore, slackUserId = "U777", userId = owner.id) => {
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    await meta.setSlackUserLink({
      id: `sul-${slackUserId}`,
      org_id: "default",
      user_id: userId,
      team_id: "T1",
      slack_user_id: slackUserId,
      origin: "oauth" as const,
      checked_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
  }

  const seedArtifact = (
    meta: MetaStore,
    id: string,
    short: string,
    title: string,
    listed: "public" | "none",
  ) =>
    meta.createArtifact({
      id,
      short_id: short,
      org_id: "default",
      slug: null,
      title,
      workspace_access: listed === "public" ? "member" : "none",
      link_role: listed === "public" ? "viewer" : "none",
      listed,
      kind: "file",
      spa: 0,
    })

  it("rejects an unsigned command", async () => {
    const { app } = make("slack-cmd-badsig")
    const r = await app.request("/v1/slack/commands", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "team_id=T1&user_id=U1",
    })
    expect(r.status).toBe(401)
  })

  it("prompts an unlinked user to link their account", async () => {
    const { app } = make("slack-cmd-nolink")
    const r = await postCommand(app, { team_id: "T1", user_id: "U-UNLINKED", text: "hello" })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.response_type).toBe("ephemeral")
    expect(JSON.stringify(body.blocks)).toContain("Link your Slack account")
  })

  it("bare /derive lists only artifacts the linked user can see", async () => {
    const { app, meta } = make("slack-cmd-recent")
    await link(meta)
    await seedArtifact(meta, "a-pub", "pubart01", "Public Doc", "public")
    await seedArtifact(meta, "a-priv", "privat01", "Private Draft", "none")
    const r = await postCommand(app, { team_id: "T1", user_id: "U777", text: "" })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.response_type).toBe("ephemeral")
    const s = JSON.stringify(body.blocks)
    expect(s).toContain("Public Doc")
    expect(s).not.toContain("Private Draft") // visibility-scoped to the linked user
  })

  it("escapes mrkdwn control chars in artifact titles (no link injection)", async () => {
    const { app, meta } = make("slack-cmd-escape")
    await link(meta)
    await seedArtifact(meta, "a-evil", "evilart1", "Pwn> <https://phish|click", "public")
    const r = await postCommand(app, { team_id: "T1", user_id: "U777", text: "" })
    const s = JSON.stringify((await r.json()).blocks)
    expect(s).toContain("Pwn&gt;") // the title's > was escaped
    expect(s).not.toContain("<https://phish") // the injected link's < was neutralized to &lt;
  })
})

// The REST surface the Settings page drives. The slash-command path had tests from the start
// and the store layer has its contract, but the HTTP endpoints in between had none — so the
// admin gate, the channel-id validation and the cross-workspace collection check were all
// asserted only through code review.
describe("subscription CRUD over REST", () => {
  const install = async (meta: Awaited<ReturnType<typeof make>>["meta"]) => {
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
  }
  const post = (app: ReturnType<typeof make>["app"], body: unknown, who = owner.email) =>
    app.request("/v1/slack/subscriptions", jsonAs(as(who), body))
  const list = async (app: ReturnType<typeof make>["app"], who = owner.email) =>
    (await (await app.request("/v1/slack/subscriptions", { headers: as(who) })).json()) as {
      subscriptions: Array<Record<string, unknown>>
      event_options: string[]
    }

  it("creates, lists, patches and deletes", async () => {
    const { app, meta } = make("sub-crud")
    await install(meta)
    const created = await post(app, { channel_id: "C0ENG123", channel_name: "eng" })
    expect(created.status).toBe(201)
    const sub = (await created.json()) as Record<string, string>
    // created_by is an internal user id and has no business on a config row the client renders.
    expect(sub.created_by).toBeUndefined()

    const shown = await list(app)
    expect(shown.subscriptions).toHaveLength(1)
    // The client must not carry its own copy of the event list — it would drift.
    expect(shown.event_options.length).toBeGreaterThan(0)
    expect(shown.subscriptions[0]).toMatchObject({
      channel_id: "C0ENG123",
      scope_kind: "workspace",
      authors: "all",
      active: 1,
    })

    const patched = await app.request(`/v1/slack/subscriptions/${sub.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(owner.email) },
      // `active` goes in as a boolean and comes back as 0|1 — the stored shape mirrors
      // webhook.active, and the Switch that drives this hands over a boolean.
      body: JSON.stringify({ authors: "agent", events: ["comment.created"], active: false }),
    })
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({
      authors: "agent",
      events: "comment.created",
      active: 0,
    })

    const gone = await app.request(`/v1/slack/subscriptions/${sub.id}`, {
      method: "DELETE",
      headers: as(owner.email),
    })
    expect(gone.status).toBe(204)
    expect((await list(app)).subscriptions).toHaveLength(0)
  })

  it("refuses a collection from another workspace", async () => {
    const { app, meta } = make("sub-crud-xorg")
    await install(meta)
    await meta.createCollection({
      id: "col_other",
      org_id: "someone-else",
      title: "Theirs",
      created_by: owner.id,
    })
    const r = await post(app, { channel_id: "C0ENG123", collection: "col_other" })
    expect(r.status).toBe(404)
    expect(await meta.listSlackSubscriptions("default")).toHaveLength(0)
  })

  it("rejects a #name where a channel id belongs", async () => {
    const { app, meta } = make("sub-crud-name")
    await install(meta)
    // Storing "#general" would make every threading lookup miss forever — links are written
    // with the id Slack echoes back — so each comment would post a new top-level message.
    const r = await post(app, { channel_id: "#general" })
    expect(r.status).toBe(400)
    expect(await meta.listSlackSubscriptions("default")).toHaveLength(0)
  })

  it("is admin-only, on every verb", async () => {
    const { app, meta } = make("sub-crud-role")
    await install(meta)
    const created = await post(app, { channel_id: "C0ENG123" })
    const sub = (await created.json()) as Record<string, string>
    expect((await post(app, { channel_id: "C0OPS123" }, editor.email)).status).toBe(403)
    expect(
      (await app.request("/v1/slack/subscriptions", { headers: as(editor.email) })).status,
    ).toBe(403)
    expect(
      (
        await app.request(`/v1/slack/subscriptions/${sub.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", ...as(editor.email) },
          body: JSON.stringify({ active: 0 }),
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request(`/v1/slack/subscriptions/${sub.id}`, {
          method: "DELETE",
          headers: as(editor.email),
        })
      ).status,
    ).toBe(403)
    // Nothing an editor sent may have taken effect.
    const rows = await meta.listSlackSubscriptions("default")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ channel_id: "C0ENG123", active: 1 })
  })
})

// "Save to Derive" — the capture path. Three interactions, none of them a block_actions: a
// message_action opens the modal, a block_suggestion feeds its picker, a view_submission writes.
describe("Save to Derive", () => {
  const setup = async (name: string, opts: { link?: boolean } = {}) => {
    const { app, meta } = make(name)
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    if (opts.link !== false)
      await meta.setSlackUserLink({
        id: newId("sul"),
        org_id: "default",
        user_id: owner.id,
        team_id: "T1",
        slack_user_id: "U1",
        origin: "oauth" as const,
        checked_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      })
    const artifact = await meta.createArtifact({
      id: `a-${name}`,
      short_id: `c${name}`.slice(0, 8),
      org_id: "default",
      slug: null,
      title: "The Spec",
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
      kind: "file",
      spa: 0,
    })
    return { app, meta, artifact }
  }
  const message = {
    ts: "1700000001.1",
    user: "U9",
    username: "Dana",
    text: "we should ship the smaller version",
  }
  const shortcut = {
    type: "message_action",
    callback_id: "derive_capture",
    trigger_id: "trig-1",
    team: { id: "T1" },
    user: { id: "U1" },
    channel: { id: "C-eng", name: "eng" },
    message,
  }
  const submission = (artifactId: string, note = "") => ({
    type: "view_submission",
    team: { id: "T1" },
    user: { id: "U1" },
    view: {
      callback_id: "derive_capture",
      private_metadata: JSON.stringify({
        channel: "C-eng",
        channelName: "eng",
        ts: message.ts,
        author: "Dana",
        text: message.text,
        permalink: "https://acme.slack.com/archives/C-eng/p1700000001",
      }),
      state: {
        values: {
          derive_capture_artifact: {
            derive_capture_pick: { selected_option: { value: artifactId } },
          },
          derive_capture_note_block: { derive_capture_note: { value: note } },
        },
      },
    },
  })

  it("asks an unlinked user to connect instead of writing as nobody", async () => {
    const { app } = await setup("cap-unlinked", { link: false })
    const calls: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init: RequestInit) => {
        calls.push({ url: String(u), body: JSON.parse(String(init?.body ?? "{}")) })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }),
    )
    await postInteract(app, shortcut)
    const open = calls.find((x) => String(x.url).endsWith("/views.open"))
    expect(JSON.stringify(open)).toContain("Connect your Derive account")
  })

  it("suggests only artifacts the linked account can see", async () => {
    const { app, meta } = await setup("cap-suggest")
    // A second workspace's artifact must never appear in the picker.
    await meta.createArtifact({
      id: "a-other",
      short_id: "other1",
      org_id: "someone-else",
      slug: null,
      title: "Their Spec",
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
      kind: "file",
      spa: 0,
    })
    const r = await postInteract(app, {
      type: "block_suggestion",
      team: { id: "T1" },
      user: { id: "U1" },
      value: "Spec",
      view: { callback_id: "derive_capture" },
    })
    const body = (await r.json()) as { options: { text: { text: string }; value: string }[] }
    expect(body.options.map((o) => o.text.text)).toContain("The Spec")
    expect(body.options.map((o) => o.text.text)).not.toContain("Their Spec")
  })

  it("saves the message as a quoted comment, authored by the linked account", async () => {
    const { app, meta, artifact } = await setup("cap-save")
    const r = await postInteract(app, submission(artifact.id, "worth capturing"))
    expect(r.status).toBe(200)
    // The modal is replaced in place — no ephemeral message, so no dependency on the bot being
    // a member of the channel the shortcut was fired in.
    expect((await r.json()).response_action).toBe("update")

    const comments = await meta.listComments(artifact.id)
    expect(comments).toHaveLength(1)
    const cm = comments[0]
    expect(cm?.author_id).toBe(owner.id)
    expect(cm?.body_md).toContain("worth capturing")
    // Quoted line by line, so the message can't break out of its blockquote, and cited.
    expect(cm?.body_md).toContain("> we should ship the smaller version")
    expect(cm?.body_md).toContain("Dana in #eng")
    // Tagged with its Slack origin — which is what stops the mirror posting it straight back
    // into every subscribed channel.
    expect(JSON.parse(cm?.meta ?? "{}").slack?.ts).toBe(message.ts)
  })

  it("does not echo a captured message back into the channel", async () => {
    const { app, meta, artifact } = await setup("cap-noecho")
    await meta.upsertSlackSubscription({
      id: newId("sub"),
      org_id: "default",
      channel_id: "C-eng",
    })
    await postInteract(app, submission(artifact.id))
    // The comment really was written — otherwise "nothing was mirrored" proves nothing.
    expect(await meta.listComments(artifact.id)).toHaveLength(1)
    const due = await meta.claimDueDeliveries(
      new Date(Date.now() + 60_000).toISOString(),
      100,
      new Date(Date.now() + 120_000).toISOString(),
    )
    expect(due.filter((d) => d.kind === "slack_app")).toHaveLength(0)
  })

  // The artifact id rides in the modal's state, which is client-supplied. It is re-resolved and
  // re-checked on submit — the picker's filter is not the authorization.
  it("refuses an artifact from another workspace", async () => {
    const { app, meta } = await setup("cap-xorg")
    const theirs = await meta.createArtifact({
      id: "a-theirs",
      short_id: "theirs1",
      org_id: "someone-else",
      slug: null,
      title: "Theirs",
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
      kind: "file",
      spa: 0,
    })
    const r = await postInteract(app, submission(theirs.id))
    expect(JSON.stringify(await r.json())).toContain("isn't available")
    expect(await meta.listComments(theirs.id)).toHaveLength(0)
  })

  it("refuses a submission from an unlinked user", async () => {
    const { app, meta, artifact } = await setup("cap-sub-unlinked", { link: false })
    const r = await postInteract(app, submission(artifact.id))
    expect(JSON.stringify(await r.json())).toContain("Connect your Derive account")
    expect(await meta.listComments(artifact.id)).toHaveLength(0)
  })

  // Disconnecting Slack leaves the members' account links behind, so the link alone is not
  // enough to keep writing into the workspace.
  it("refuses once the workspace has disconnected Slack", async () => {
    const { app, meta, artifact } = await setup("cap-disconnected")
    await meta.deleteSlackInstall("default")
    const r = await postInteract(app, submission(artifact.id))
    expect(JSON.stringify(await r.json())).toContain("Connect your Derive account")
    expect(await meta.listComments(artifact.id)).toHaveLength(0)
  })
})

// A pasted question link and a personal mention DM share this reply path. The action only names
// a thread; the route re-authorizes the current Slack/Derive account before opening the modal,
// then makes the view submission idempotent because Slack can replay it after a lost ack.
describe("question Reply actions", () => {
  const setup = async (name: string, opts: { link?: boolean } = {}) => {
    const { app, meta } = make(name)
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    if (opts.link !== false)
      await meta.setSlackUserLink({
        id: newId("sul"),
        org_id: "default",
        user_id: owner.id,
        team_id: "T1",
        slack_user_id: "U1",
        origin: "oauth" as const,
        checked_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      })
    const artifact = await meta.createArtifact({
      id: `a-question-${name}`,
      short_id: `q${name}`.slice(0, 8),
      org_id: "default",
      slug: null,
      title: "The question doc",
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
      kind: "file",
      spa: 0,
    })
    const threadId = newId("c")
    const root = await meta.createComment({
      id: threadId,
      artifact_id: artifact.id,
      // Every new thread's root id IS its thread id; `getComment` then provides the indexed
      // lookup the Work Object action needs without scanning every comment on the artifact.
      thread_id: threadId,
      base_version: artifact.current_version,
      path: null,
      anchor: null,
      body_md: "Which rollout should we choose?",
      author: "Derive",
      author_id: "derive",
    })
    return { app, meta, artifact, threadId: root.id }
  }

  const action = (artifactId: string, threadId: string) => ({
    type: "block_actions",
    trigger_id: "question-trigger",
    team: { id: "T1" },
    user: { id: "U1" },
    actions: [
      {
        action_id: "derive_question_reply",
        value: JSON.stringify({ artifactId, threadId }),
      },
    ],
  })

  it("opens a reply modal and de-duplicates a replayed view submission", async () => {
    const { app, meta, artifact, threadId } = await setup("question-reply")
    const opened: Record<string, unknown>[] = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/views.open")) opened.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    expect((await postInteract(app, action(artifact.id, threadId))).status).toBe(200)
    const modal = opened[0]?.view as { private_metadata?: string } | undefined
    const replyMeta = JSON.parse(modal?.private_metadata ?? "{}") as Record<string, string>
    expect(replyMeta).toMatchObject({ artifactId: artifact.id, threadId })
    expect(replyMeta.submissionId).toBeTruthy()

    const submission = {
      type: "view_submission",
      team: { id: "T1" },
      user: { id: "U1" },
      view: {
        callback_id: "derive_question_reply",
        private_metadata: JSON.stringify(replyMeta),
        state: {
          values: {
            derive_question_reply_body: {
              derive_question_reply_input: { value: "Ship the smaller rollout." },
            },
          },
        },
      },
    }
    const first = await postInteract(app, submission)
    expect(JSON.stringify(await first.json())).toContain("Reply added")
    const second = await postInteract(app, submission)
    expect(JSON.stringify(await second.json())).toContain("Reply already added")

    const comments = await meta.listComments(artifact.id)
    expect(comments.filter((cm) => cm.thread_id === threadId)).toHaveLength(2)
    expect(comments.find((cm) => cm.body_md.includes("smaller rollout"))?.author_id).toBe(owner.id)
  })
})

// The flexpane — the per-viewer half. `chat.unfurl` never had a `user` parameter, so the
// broadcast card has always had to assume the most cautious reader in the channel. This surface
// carries the clicking user, so the answer can finally depend on who is asking.
describe("entity_details_requested (the flexpane)", () => {
  const withInstall = async (
    name: string,
    opts: { link?: boolean; listed?: string; workspace_access?: "member" | "none" } = {},
  ) => {
    const { app, meta } = make(name)
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    if (opts.link !== false)
      await meta.setSlackUserLink({
        id: newId("sul"),
        org_id: "default",
        user_id: owner.id,
        team_id: "T1",
        slack_user_id: "U1",
        origin: "oauth" as const,
        checked_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      })
    const artifact = await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s").slice(0, 8),
      org_id: "default",
      slug: null,
      title: "Secret plan",
      workspace_access: opts.workspace_access ?? "member",
      link_role: "viewer",
      listed: (opts.listed ?? "workspace") as "workspace",
      kind: "file",
      spa: 0,
    })
    // A doc granting the workspace nothing is readable only through an explicit share; the
    // viewer needs one so the private-doc tests exercise the minting gate, not the read check.
    if (opts.workspace_access === "none")
      await meta.setArtifactMember({
        id: newId("am"),
        artifact_id: artifact.id,
        user_id: owner.id,
        role: "viewer",
      })
    await meta.setVersionPreview(artifact.id, await addV(meta, artifact.id), {
      preview_key: "blob-og",
      preview_status: "ready",
    })
    return { app, meta, artifact }
  }

  const clickAndCapture = async (
    app: ReturnType<typeof make>["app"],
    shortId: string,
    user = "U1",
  ) => {
    const seen: Record<string, unknown>[] = []
    let fired: (v: unknown) => void = () => {}
    const called = new Promise((r) => {
      fired = r
    })
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (String(url).includes("entity.presentDetails")) {
        seen.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        fired(null)
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    await postEvent(
      app,
      JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event: {
          type: "entity_details_requested",
          user,
          trigger_id: "trig-1",
          external_ref: { id: shortId, type: "artifact" },
        },
      }),
    )
    await called
    return seen[0] ?? {}
  }

  it("asks an unlinked viewer to connect — privately, not to the channel", async () => {
    const { app, artifact } = await withInstall("flex-unlinked", { link: false })
    const body = await clickAndCapture(app, artifact.short_id)
    expect(body.user_auth_required).toBe(true)
    expect(String(body.user_auth_url)).toContain("/v1/slack/link")
  })

  // THE ONE PATH WHERE A PRIVATE DOC CAN REACH THE MINTER.
  //
  // The unfurl never does — decideUnfurl answers a doc that grants the workspace nothing with
  // the locked card long before a preview is considered. The flexpane resolves an artifact
  // itself, so a private doc arrives at the same function, and only its own access check stops
  // a token being minted.
  //
  // Which it must, even though this panel is per-viewer and this viewer just passed a read
  // check. The panel is private; the IMAGE URL is not — Slack fetches it anonymously and its
  // proxy caches the bytes. Being entitled to read something is not the same as consenting to
  // a copy of it living in another company's cache.
  it("mints no screenshot URL for a private doc, even for a viewer who may read it", async () => {
    const { app, artifact } = await withInstall("flex-private-preview", {
      listed: "none",
      workspace_access: "none",
    })
    const body = await clickAndCapture(app, artifact.short_id)
    // The viewer IS entitled — the panel opens and names the doc.
    expect(JSON.stringify(body)).toContain("Secret plan")
    expect(JSON.stringify(body)).not.toContain("full_size_preview")
  })

  // The default team draft, by contrast, mints one here exactly as the channel card does: the
  // workspace may read it, and the flexpane viewer is a member of that workspace.
  it("mints a screenshot URL for a team draft in the flexpane", async () => {
    const { app, artifact } = await withInstall("flex-draft-preview", { listed: "none" })
    const body = await clickAndCapture(app, artifact.short_id)
    expect(JSON.stringify(body)).toContain("Secret plan")
    expect(JSON.stringify(body)).toContain("full_size_preview")
  })

  it("does mint one for a workspace-listed doc, which is the whole point", async () => {
    const { app, artifact } = await withInstall("flex-ws-preview", { listed: "workspace" })
    const body = await clickAndCapture(app, artifact.short_id)
    const json = JSON.stringify(body)
    expect(json).toContain("full_size_preview")
    expect(json).toContain(`/v1/og/${artifact.short_id}`)
    expect(json).toContain("t=")
  })

  // The point of the whole change: a viewer entitled to a doc sees it, even when the broadcast
  // card is deliberately saying nothing.
  it("shows the real detail to a viewer who may read it", async () => {
    const { app, artifact } = await withInstall("flex-allowed")
    const body = await clickAndCapture(app, artifact.short_id)
    expect(JSON.stringify(body.metadata)).toContain("Secret plan")
    expect(body.error).toBeUndefined()
  })

  // …and someone without access is told so in a panel only THEY see, while the channel's card
  // continues to reveal nothing.
  it("returns a restricted view to a linked viewer without access", async () => {
    const { app, meta } = await withInstall("flex-denied")
    const theirs = await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s").slice(0, 8),
      org_id: "someone-else",
      slug: null,
      title: "Not yours",
      workspace_access: "member",
      link_role: "none",
      listed: "workspace",
      kind: "file",
      spa: 0,
    })
    const body = await clickAndCapture(app, theirs.short_id)
    expect((body.error as { status: string }).status).toBe("custom_partial_view")
    expect(JSON.stringify(body)).not.toContain("Not yours")
  })
})

// A DIRECT MESSAGE to the app. The Messages tab is where there is nobody to @mention, so the
// event has to route on its own — and the guards below are the ones that stop a bot answering
// its own answer for ever.

describe("slack DMs reach the chat lane", () => {
  const dm = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "event_callback",
      team_id: "T-dm",
      event: {
        type: "message",
        channel_type: "im",
        channel: "D-1",
        user: "U-asker",
        text: "what changed this week?",
        ts: "1.1",
        ...over,
      },
    })

  it("IGNORES the app's own messages, both shapes Slack uses", async () => {
    // The loop this prevents: Derive posts an answer into the DM, Slack delivers that back as a
    // new message.im, and it answers its own answer. Slack marks the bot's own posts with
    // bot_id, and edits/deletes/joins with a subtype — neither is a question.
    const { app } = make("slack-dm-self")
    expect((await postEvent(app, dm({ bot_id: "B-self" }))).status).toBe(200)
    expect((await postEvent(app, dm({ subtype: "message_changed" }))).status).toBe(200)
  })
})

// The loop's blocking moment, settled from Slack. The same two actions ride the Work Object
// card, the review-request DM and the channel card — and a Work Object click carries no `value`,
// which the interactivity guard used to require, making those buttons a no-op.
describe("review buttons reach the handler from every surface", () => {
  const ready = async (name: string) => {
    const { app, meta } = make(name)
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    await meta.setSlackUserLink({
      id: newId("sul"),
      org_id: "default",
      user_id: owner.id,
      team_id: "T1",
      slack_user_id: "U1",
      // A deliberate sign-in, not an email inference — the strongest identity, so the test
      // exercises the button rather than the identity policy.
      origin: "oauth",
      created_at: new Date().toISOString(),
      checked_at: new Date().toISOString(),
    })
    const artifact = await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s").slice(0, 8),
      org_id: "default",
      slug: null,
      title: "Spec",
      workspace_access: "member",
      link_role: "viewer",
      listed: "workspace",
      kind: "file",
      spa: 0,
    })
    const round = await meta.createReviewRound({
      id: newId("rr"),
      artifact_id: artifact.id,
      version: 1,
      requested_by: "ag-1",
      requested_for: owner.id,
      note: null,
    })
    return { app, meta, artifact, round }
  }
  const click = (app: ReturnType<typeof make>["app"], extra: Record<string, unknown>) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    )
    return postInteract(app, {
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U1" },
      channel: { id: "C1" },
      response_url: "https://hooks.slack.test/x",
      actions: [{ action_id: "derive_review_send_back", ...extra }],
    })
  }

  // A DM or channel-card button: the target travels in `value`.
  it("settles the round from a value-carrying button", async () => {
    const { app, meta, artifact } = await ready("review-btn-value")
    const r = await click(app, { value: JSON.stringify({ a: artifact.id }) })
    expect(r.status).toBe(200)
    await vi.waitFor(async () => expect(await meta.getPendingRound(artifact.id)).toBeNull())
  })

  // A Work Object button: no value at all, the entity is echoed back instead. The old guard
  // required `value` and returned ok before this branch, so the card's buttons did nothing.
  it("settles the round from a valueless Work Object click", async () => {
    const { app, meta, artifact } = await ready("review-btn-entity")
    const r = await click(app, { entity: undefined })
    expect(r.status).toBe(200)
    void r
    const withEntity = await postInteract(app, {
      type: "block_actions",
      team: { id: "T1" },
      user: { id: "U1" },
      channel: { id: "C1" },
      response_url: "https://hooks.slack.test/x",
      entity: { external_ref: { id: artifact.short_id, type: "artifact" } },
      actions: [{ action_id: "derive_review_send_back" }],
    })
    expect(withEntity.status).toBe(200)
    await vi.waitFor(async () => expect(await meta.getPendingRound(artifact.id)).toBeNull())
  })
})

// Which channels a document event fans out to: the event mask, the human/agent author
// filter, the collection scope, and the broadcast rule that a private artifact never
// reaches a channel however it was subscribed.
describe("which channels a document event fans out to", () => {
  const setup = async (name: string, listed: "none" | "workspace" = "workspace") => {
    const { meta } = quotaApp(name, { defaultOrgId: "default" }, [], [])
    const artifact = (await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s").slice(0, 8),
      org_id: "default",
      slug: null,
      title: "Doc",
      workspace_access: "member",
      link_role: "viewer",
      listed,
      kind: "file",
      spa: 0,
    })) as ArtifactRecord
    return { meta, artifact }
  }

  const sub = (over: Record<string, unknown> = {}) => ({
    id: newId("sub"),
    org_id: "default",
    channel_id: "C1",
    ...over,
  })

  describe("resolveChannels", () => {
    it("delivers a workspace-scoped subscription for any artifact", async () => {
      const { meta, artifact } = await setup("res-ws")
      await meta.upsertSlackSubscription(sub())
      const got = await resolveChannels(meta, artifact, "comment.created", "human")
      expect(got.map((s) => s.channel_id)).toEqual(["C1"])
    })

    it("skips a paused subscription", async () => {
      const { meta, artifact } = await setup("res-paused")
      await meta.upsertSlackSubscription(sub({ active: 0 }))
      expect(await resolveChannels(meta, artifact, "comment.created", "human")).toHaveLength(0)
    })

    it("honours the event mask, and '*' means all", async () => {
      const { meta, artifact } = await setup("res-events")
      await meta.upsertSlackSubscription(sub({ channel_id: "C-pub", events: "version.published" }))
      await meta.upsertSlackSubscription(sub({ channel_id: "C-all", events: "*" }))
      expect(
        (await resolveChannels(meta, artifact, "comment.created", "human")).map(
          (s) => s.channel_id,
        ),
      ).toEqual(["C-all"])
      expect(
        (await resolveChannels(meta, artifact, "version.published", "human"))
          .map((s) => s.channel_id)
          .sort(),
      ).toEqual(["C-all", "C-pub"])
    })

    // The axis no other product's integration has: agents are first-class authors here, so a
    // channel usually wants one or the other.
    it("honours the human/agent author filter", async () => {
      const { meta, artifact } = await setup("res-authors")
      await meta.upsertSlackSubscription(sub({ channel_id: "C-humans", authors: "human" }))
      await meta.upsertSlackSubscription(sub({ channel_id: "C-agents", authors: "agent" }))
      await meta.upsertSlackSubscription(sub({ channel_id: "C-both", authors: "all" }))
      expect(
        (await resolveChannels(meta, artifact, "comment.created", "human"))
          .map((s) => s.channel_id)
          .sort(),
      ).toEqual(["C-both", "C-humans"])
      expect(
        (await resolveChannels(meta, artifact, "comment.created", "agent"))
          .map((s) => s.channel_id)
          .sort(),
      ).toEqual(["C-agents", "C-both"])
    })

    it("delivers a collection scope only for artifacts in that collection", async () => {
      const { meta, artifact } = await setup("res-collection")
      const collection = await meta.createCollection({
        id: newId("col"),
        org_id: "default",
        title: "Brand",
        created_by: "u-1",
      })
      await meta.upsertSlackSubscription(
        sub({ channel_id: "C-brand", scope_kind: "collection", scope_id: collection.id }),
      )
      expect(await resolveChannels(meta, artifact, "comment.created", "human")).toHaveLength(0)
      await meta.addCollectionItem(collection.id, artifact.id)
      expect(
        (await resolveChannels(meta, artifact, "comment.created", "human")).map(
          (s) => s.channel_id,
        ),
      ).toEqual(["C-brand"])
    })

    // The broadcast rule survives subscriptions: a private draft never reaches a channel, however
    // it was subscribed.
    it("never delivers a private artifact", async () => {
      const { meta, artifact } = await setup("res-private", "none")
      await meta.upsertSlackSubscription(sub())
      expect(await resolveChannels(meta, artifact, "comment.created", "human")).toHaveLength(0)
    })
  })

  describe("authorKind", () => {
    it("classifies an OAuth grant's synthetic id as an agent", async () => {
      const { meta } = await setup("kind-oauth")
      expect(await authorKind(meta, "default", "oauth:cli")).toBe("agent")
    })

    // Fail open to human: a filter must never silently hide a person's activity.
    it("treats an unknown or absent author as human", async () => {
      const { meta } = await setup("kind-human")
      expect(await authorKind(meta, "default", "u-someone")).toBe("human")
      expect(await authorKind(meta, "default", null)).toBe("human")
    })
  })
})
