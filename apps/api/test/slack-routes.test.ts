import { createHmac } from "node:crypto"
import {
  type CommentRecord,
  DEFAULT_ORG_SETTINGS,
  type MetaStore,
  type NewComment,
  newId,
  type SlackThreadLinkRecord,
} from "@derive/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { encryptSecret, signState } from "../src/lib/crypto"
import {
  ingestSlackReply,
  makeSlackIngestSender,
  SLACK_PROPOSAL_ACTION,
  SLACK_THREAD_ACTION,
} from "../src/lib/slack-comments"
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

const proposalAction = (artifactId: string, proposalId: string, actionId: string) => ({
  type: "block_actions",
  response_url: "https://hooks.slack.test/response",
  team: { id: "T1" },
  user: { id: "U777", username: "dana" },
  actions: [{ action_id: actionId, value: JSON.stringify({ a: artifactId, p: proposalId }) }],
  message: { blocks: [{ type: "section", text: { type: "mrkdwn", text: "a proposal" } }] },
})

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

describe("slack status + admin routes", () => {
  it("reports available + not connected before an install, connected after", async () => {
    const { app, meta } = make("slack-status")
    const before = await (await app.request("/v1/slack", { headers: as(owner.email) })).json()
    expect(before).toMatchObject({ available: true, connected: false })

    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    const after = await (await app.request("/v1/slack", { headers: as(owner.email) })).json()
    expect(after).toMatchObject({ connected: true, team_name: "Acme" })
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

describe("slack DM prefs (email-resolved, no linking)", () => {
  it("status reports slack_dm; defaults on even before Slack is connected", async () => {
    const { app } = make("slack-dm-status")
    const before = await (await app.request("/v1/slack", { headers: as(owner.email) })).json()
    expect(before).toMatchObject({ slack_dm: true })
  })

  it("toggles the caller's Slack-DM pref and reflects it in status", async () => {
    const { app, meta } = make("slack-dm-toggle")
    const off = await app.request("/v1/slack/prefs", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ slack_dm: false }),
    })
    expect(off.status).toBe(200)
    expect(await off.json()).toEqual({ slack_dm: false })

    const status = await (await app.request("/v1/slack", { headers: as(owner.email) })).json()
    expect(status.slack_dm).toBe(false)

    const pref = await meta.getUserNotificationPref("default", owner.id)
    expect(pref && JSON.parse(pref.prefs)).toMatchObject({ slackDm: false })
  })

  it("test DM requires Slack to be connected, then enqueues a slack_dm", async () => {
    const { app, meta } = make("slack-dm-test")
    const denied = await app.request("/v1/slack/test-dm", {
      method: "POST",
      headers: as(owner.email),
    })
    expect(denied.status).toBe(400)

    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    const ok = await app.request("/v1/slack/test-dm", { method: "POST", headers: as(owner.email) })
    expect(ok.status).toBe(200)
    const rows = await meta.claimDueDeliveries(
      new Date(Date.now() + 60_000).toISOString(),
      100,
      new Date(Date.now() + 120_000).toISOString(),
    )
    expect(rows.some((r) => r.kind === "slack_dm")).toBe(true)
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
    expect(r.headers.get("location")).toBe("/settings/integrations")
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
      created_at: new Date().toISOString(),
    })
    const r = await app.request("/v1/slack/link", { method: "DELETE", headers: as(owner.email) })
    expect(r.status).toBe(204)
    expect(await meta.getSlackUserLinkByUser("T1", owner.id)).toBe(null)
  })
})

describe("slack events endpoint", () => {
  it("answers the url_verification challenge when signed", async () => {
    const { app } = make("slack-ev-challenge")
    const ts = String(Math.floor(Date.now() / 1000))
    const body = JSON.stringify({ type: "url_verification", challenge: "ch-1" })
    const r = await app.request("/v1/slack/events", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sign(ts, body),
      },
      body,
    })
    expect(r.status).toBe(200)
    expect((await r.json()).challenge).toBe("ch-1")
  })

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

  it("ingestSlackReply writes the Slack dedupe marker IN the comment insert (atomic)", async () => {
    // A focused unit test with a hand-built store (not the real adapter): the atomicity is
    // that the {slack.ts} marker rides the createComment INSERT, not a follow-up write a
    // crash-retry could skip. The old two-write path called createComment with no meta and
    // then updateComment — the fake has no updateComment, so that path throws here. Both the
    // "marker present" and "no second write" facts are pinned, on any adapter.
    const inserts: NewComment[] = []
    const link: SlackThreadLinkRecord = {
      id: "l",
      org_id: "o",
      artifact_id: "a",
      thread_id: "t",
      channel: "C1",
      message_ts: "111.1",
      created_at: "",
    }
    const fakeMeta = {
      listComments: async () => [],
      createComment: async (c: NewComment) => {
        inserts.push(c)
        return {
          ...c,
          state: "open",
          created_at: "",
          meta: c.meta ?? null,
        } as unknown as CommentRecord
      },
    } as unknown as MetaStore
    const created = await ingestSlackReply(fakeMeta, link, {
      ts: "222.2",
      userId: "U1",
      userName: "Dana",
      text: "hi",
      botUserId: "UBOT",
    })
    expect(created).not.toBeNull()
    expect(inserts).toHaveLength(1)
    expect(JSON.parse(inserts[0]?.meta ?? "{}")).toMatchObject({
      slack: { ts: "222.2", channel: "C1" },
    })
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

  // The subcommands live in exactly two places a person can find them: the slash-command
  // autocomplete (one line, from the manifest) and this. Nothing else lists them.
  it("answers /derive help — and answers it without an account link", async () => {
    const { app, meta } = make("cmd-help")
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      created_at: new Date().toISOString(),
    })
    // Deliberately NO setSlackUserLink: someone who has not linked yet is exactly who needs to
    // read what the command does, so help must not sit behind the link prompt.
    const body = JSON.stringify((await (await cmd(app, "help")).json()).blocks)
    for (const verb of ["subscribe", "unsubscribe", "settings", "Save to Derive"])
      expect(body).toContain(verb)
    expect(body).not.toContain("Connect your Derive account")
  })

  // Naming the collection matters most here: a channel can carry several subscriptions, and the
  // card used to print the opaque scope_id, which identifies nothing to a human.
  it("names the collection in /derive settings rather than printing its id", async () => {
    const { app, meta } = make("cmd-settings-title")
    await linked(meta)
    await meta.createCollection({
      id: "col_9f2ac1",
      org_id: "default",
      title: "API docs",
      created_by: owner.id,
    })
    await cmd(app, "subscribe API docs")
    const shown = JSON.stringify((await (await cmd(app, "settings")).json()).blocks)
    expect(shown).toContain("API docs")
    expect(shown).not.toContain("col_9f2ac1")
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

  // A PUBLIC channel needs no membership — the sender self-joins on its first not_in_channel —
  // so the guard must not stand in the way of the common case.
  it("subscribes a public channel the bot has not joined yet", async () => {
    const { app, meta } = make("cmd-public-ok")
    await linked(meta)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) =>
        String(u).includes("conversations.info")
          ? new Response(
              JSON.stringify({ ok: true, channel: { is_private: false, is_member: false } }),
              { status: 200 },
            )
          : new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    )
    await cmd(app, "subscribe")
    expect(await meta.listSlackSubscriptions("default")).toHaveLength(1)
  })

  // Slack unreachable must not block an admin from configuring their own workspace.
  it("subscribes anyway when Slack could not be asked", async () => {
    const { app, meta } = make("cmd-reach-unknown")
    await linked(meta)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      }),
    )
    await cmd(app, "subscribe")
    expect(await meta.listSlackSubscriptions("default")).toHaveLength(1)
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
    expect(JSON.stringify(seen[0]?.unfurls)).toContain("Q4 roadmap")
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

  it('acks (not 500s) a button value of "null" — JSON.parse succeeds but yields null', async () => {
    const { app } = make("slack-int-null-value")
    // Regression: the old inline decode destructured the parse result OUTSIDE its try, so a
    // literal "null" (valid JSON, parses to null) threw a TypeError → 500 instead of acking.
    for (const actionId of [SLACK_THREAD_ACTION.resolve, SLACK_PROPOSAL_ACTION.approve]) {
      const r = await postInteract(app, {
        type: "block_actions",
        response_url: "https://hooks.slack.test/response",
        team: { id: "T1" },
        user: { id: "U777", username: "dana" },
        actions: [{ action_id: actionId, value: "null" }],
        message: { blocks: [] },
      })
      expect(r.status).toBe(200)
    }
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

  it("acks a proposal Approve interaction (dispatched off the ack path)", async () => {
    const { app } = make("slack-int-proposal")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    )
    // The approve work runs via response_url off the ack path; the endpoint just acks 200
    // (authorization + execution are covered by slack-proposal.test.ts).
    const r = await postInteract(app, proposalAction("a-x", "p-x", SLACK_PROPOSAL_ACTION.approve))
    expect(r.status).toBe(200)
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

  it("answers a search inline when there's no response_url (fallback)", async () => {
    const { app, meta } = make("slack-cmd-search")
    await link(meta)
    const r = await postCommand(app, { team_id: "T1", user_id: "U777", text: "anything" })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.response_type).toBe("ephemeral")
    expect(Array.isArray(body.blocks)).toBe(true)
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

  it("acks a search with 'Searching…' and defers the work to response_url", async () => {
    const { app, meta } = make("slack-cmd-defer")
    await link(meta)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    )
    const r = await postCommand(app, {
      team_id: "T1",
      user_id: "U777",
      text: "anything",
      response_url: "https://hooks.slack.test/cmd",
    })
    expect(r.status).toBe(200)
    const body = await r.json()
    // The search runs off the ack path — the immediate reply is just the placeholder.
    expect(body.text).toBe("Searching…")
    expect(body.blocks).toBeUndefined()
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

  it("names the scoped collection so two rows on one channel can be told apart", async () => {
    const { app, meta } = make("sub-crud-scope")
    await install(meta)
    await meta.createCollection({
      id: "col_api",
      org_id: "default",
      title: "API docs",
      created_by: owner.id,
    })
    await post(app, { channel_id: "C0ENG123", channel_name: "eng", collection: "col_api" })
    await post(app, { channel_id: "C0ENG123", channel_name: "eng" })
    const rows = (await list(app)).subscriptions
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.scope_title).sort()).toEqual(["API docs", null])
    // And the create response carries it too, so the UI needn't refetch to render the new row.
    const again = await post(app, { channel_id: "C0DES123", collection: "col_api" })
    expect(await again.json()).toMatchObject({ scope_title: "API docs" })
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

  it("opens a picker modal on the message, quoting it", async () => {
    const { app } = await setup("cap-open")
    const calls: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init: RequestInit) => {
        if (String(u).includes("chat.getPermalink"))
          return new Response(JSON.stringify({ ok: true, permalink: "https://s/p" }), {
            status: 200,
          })
        calls.push({ url: String(u), body: JSON.parse(String(init?.body ?? "{}")) })
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }),
    )
    expect((await postInteract(app, shortcut)).status).toBe(200)
    const open = calls.find((x) => String(x.url).endsWith("/views.open"))
    expect(open).toBeTruthy()
    const view = JSON.stringify((open as { body: { view: unknown } }).body.view)
    expect(view).toContain("Save to Derive")
    expect(view).toContain("we should ship the smaller version")
    // The message travels in private_metadata: a view_submission arrives with no channel and
    // no message, so anything not carried here is gone by the time Save is pressed.
    expect(view).toContain("private_metadata")
    expect(view).toContain("1700000001.1")
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
