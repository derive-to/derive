import { createHmac } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { encryptSecret, signState } from "../src/lib/crypto"
import { as, quotaApp, type TestUser } from "./helpers"

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
      default_channel: "C1",
      created_at: new Date().toISOString(),
    })
    const after = await (await app.request("/v1/slack", { headers: as(owner.email) })).json()
    expect(after).toMatchObject({ connected: true, team_name: "Acme", default_channel: "C1" })
  })

  it("an admin sets the default channel; a non-admin cannot", async () => {
    const { app, meta } = make("slack-channel")
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      default_channel: null,
      created_at: new Date().toISOString(),
    })
    const ok = await app.request("/v1/slack", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ default_channel: "C0ABC" }),
    })
    expect(ok.status).toBe(200)
    expect((await meta.getSlackInstall("default"))?.default_channel).toBe("C0ABC")

    const denied = await app.request("/v1/slack", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(editor.email) },
      body: JSON.stringify({ default_channel: "C9" }),
    })
    expect(denied.status).toBe(403)
  })

  it("an admin disconnects Slack", async () => {
    const { app, meta } = make("slack-disconnect")
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      default_channel: "C1",
      created_at: new Date().toISOString(),
    })
    const r = await app.request("/v1/slack", { method: "DELETE", headers: as(owner.email) })
    expect(r.status).toBe(204)
    expect(await meta.getSlackInstall("default")).toBe(null)
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

  it("mirrors a signed thread reply into a Derive comment on the linked thread", async () => {
    const { app, meta } = make("slack-ev-reply")
    // Seed an artifact + a thread link for an existing Derive thread.
    const artifact = await meta.createArtifact({
      id: "a-slack-reply",
      short_id: "slkreply",
      org_id: "default",
      slug: null,
      title: "Doc",
      visibility: "link",
      kind: "file",
      spa: 0,
    })
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      default_channel: "C1",
      created_at: new Date().toISOString(),
    })
    await meta.setSlackThreadLink({
      id: "stl-1",
      org_id: "default",
      artifact_id: artifact.id,
      thread_id: "t-root",
      channel: "C1",
      message_ts: "111.1",
      created_at: new Date().toISOString(),
    })
    // Slack users.info lookup → display name.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, user: { profile: { display_name: "Dana" } } }), {
            status: 200,
          }),
      ),
    )

    const ts = String(Math.floor(Date.now() / 1000))
    const body = JSON.stringify({
      type: "event_callback",
      event: {
        type: "message",
        user: "U777",
        text: "from slack",
        channel: "C1",
        ts: "222.2",
        thread_ts: "111.1",
      },
    })
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
    const comments = await meta.listComments(artifact.id)
    const mirrored = comments.find((c) => c.thread_id === "t-root")
    expect(mirrored?.author).toBe("Dana")
    expect(mirrored?.author_id).toBe("slack:U777")
    expect(mirrored?.body_md).toBe("from slack")
  })

  it("ignores our own bot's messages (loop prevention)", async () => {
    const { app, meta } = make("slack-ev-bot")
    const artifact = await meta.createArtifact({
      id: "a-slack-bot",
      short_id: "slkbot01",
      org_id: "default",
      slug: null,
      title: "Doc",
      visibility: "link",
      kind: "file",
      spa: 0,
    })
    await meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      default_channel: "C1",
      created_at: new Date().toISOString(),
    })
    await meta.setSlackThreadLink({
      id: "stl-2",
      org_id: "default",
      artifact_id: artifact.id,
      thread_id: "t-bot",
      channel: "C1",
      message_ts: "333.3",
      created_at: new Date().toISOString(),
    })
    const ts = String(Math.floor(Date.now() / 1000))
    const body = JSON.stringify({
      type: "event_callback",
      event: {
        type: "message",
        user: "UBOT",
        text: "echo",
        channel: "C1",
        ts: "444.4",
        thread_ts: "333.3",
      },
    })
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
    expect(await meta.listComments(artifact.id)).toHaveLength(0)
  })
})

describe("slack interactivity endpoint", () => {
  // Slack posts interactive actions as form-encoded `payload=<urlencoded JSON>`.
  const interact = (obj: unknown) => `payload=${encodeURIComponent(JSON.stringify(obj))}`

  it("rejects a badly-signed interaction", async () => {
    const { app } = make("slack-int-badsig")
    const r = await app.request("/v1/slack/interactivity", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: interact({ type: "block_actions" }),
    })
    expect(r.status).toBe(401)
  })

  it("acks a proposal button and replies with a deep link into Derive (PR-1 fallback)", async () => {
    const { app } = make("slack-int-approve")
    // Capture the out-of-band ephemeral reply Slack would receive on response_url.
    const replies: { url: string; body: unknown }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        replies.push({ url, body: JSON.parse(init?.body ?? "{}") })
        return new Response("{}", { status: 200 })
      }),
    )
    const ts = String(Math.floor(Date.now() / 1000))
    const body = interact({
      type: "block_actions",
      user: { id: "U1" },
      response_url: "https://hooks.slack.com/actions/resp-1",
      actions: [
        {
          action_id: "slack_act:approve",
          value: JSON.stringify({
            v: 1,
            act: "approve",
            org: "default",
            id: "p1",
            url: "https://derive.to/artifacts/x",
          }),
        },
      ],
    })
    const r = await app.request("/v1/slack/interactivity", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sign(ts, body),
      },
      body,
    })
    expect(r.status).toBe(200)
    expect(replies).toHaveLength(1)
    expect(replies[0]?.url).toBe("https://hooks.slack.com/actions/resp-1")
    const reply = replies[0]?.body as { response_type: string; text: string }
    expect(reply.response_type).toBe("ephemeral")
    expect(reply.text).toContain("https://derive.to/artifacts/x")
    expect(reply.text.toLowerCase()).toContain("approve")
  })

  it("ignores unknown action ids without replying", async () => {
    const { app } = make("slack-int-unknown")
    const replies: unknown[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        replies.push(1)
        return new Response("{}", { status: 200 })
      }),
    )
    const ts = String(Math.floor(Date.now() / 1000))
    const body = interact({
      type: "block_actions",
      response_url: "https://hooks.slack.com/actions/resp-2",
      actions: [{ action_id: "not_ours", value: "{}" }],
    })
    const r = await app.request("/v1/slack/interactivity", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sign(ts, body),
      },
      body,
    })
    expect(r.status).toBe(200)
    expect(replies).toHaveLength(0)
  })
})

describe("slack account linking + status", () => {
  const install = (meta: Awaited<ReturnType<typeof make>>["meta"]) =>
    meta.setSlackInstall({
      org_id: "default",
      team_id: "T1",
      team_name: "Acme",
      bot_token: encryptSecret("xoxb-1", KEY),
      bot_user_id: "UBOT",
      default_channel: "C1",
      created_at: new Date().toISOString(),
    })

  it("status reports needs_reauth and the caller's link state", async () => {
    const { app, meta } = make("slack-link-status")
    await install(meta)
    const before = await (await app.request("/v1/slack", { headers: as(owner.email) })).json()
    expect(before).toMatchObject({ connected: true, needs_reauth: false, linked: false })

    const cur = await meta.getSlackInstall("default")
    if (!cur) throw new Error("expected an install")
    await meta.setSlackInstall({ ...cur, needs_reauth: 1 })
    await meta.setSlackUserLink({
      id: "sul-1",
      org_id: "default",
      slack_user_id: "U-owner",
      user_id: owner.id,
      status: "confirmed",
      dm_channel_id: null,
      created_at: new Date().toISOString(),
    })
    const after = await (await app.request("/v1/slack", { headers: as(owner.email) })).json()
    expect(after).toMatchObject({ needs_reauth: true, linked: true })
  })

  it("starts the link OAuth pinned to the connected team", async () => {
    const { app, meta } = make("slack-link-start")
    await install(meta)
    const r = await app.request("/v1/slack/link", { headers: as(owner.email), redirect: "manual" })
    expect(r.status).toBe(302)
    const loc = new URL(r.headers.get("location") ?? "")
    expect(loc.origin + loc.pathname).toBe("https://slack.com/openid/connect/authorize")
    expect(loc.searchParams.get("team")).toBe("T1")
    expect(loc.searchParams.get("scope")).toContain("openid")
  })

  it("callback creates a confirmed link for the same team, and rejects a different team", async () => {
    const { app, meta } = make("slack-link-cb")
    await install(meta)
    const openId = (teamId: string) =>
      vi.fn(async (url: string) => {
        if (url.endsWith("/openid.connect.token"))
          return new Response(JSON.stringify({ ok: true, access_token: "xoxp-1" }))
        return new Response(
          JSON.stringify({
            ok: true,
            "https://slack.com/user_id": "U-linked",
            "https://slack.com/team_id": teamId,
            email: owner.email,
          }),
        )
      })

    // Same team → confirmed link.
    vi.stubGlobal("fetch", openId("T1"))
    const state = signState({ org: "default", uid: owner.id }, KEY)
    const ok = await app.request(
      `/v1/slack/link/callback?code=c&state=${encodeURIComponent(state)}`,
      {
        redirect: "manual",
      },
    )
    expect(ok.headers.get("location")).toContain("linked=1")
    const link = await meta.getSlackUserLinkByUser("default", owner.id)
    expect(link).toMatchObject({ slack_user_id: "U-linked", status: "confirmed" })

    // Different team → rejected, no clobber.
    await meta.deleteSlackUserLink("default", "U-linked")
    vi.stubGlobal("fetch", openId("T-other"))
    const bad = await app.request(
      `/v1/slack/link/callback?code=c&state=${encodeURIComponent(state)}`,
      {
        redirect: "manual",
      },
    )
    expect(bad.headers.get("location")).toContain("error=link_team")
    expect(await meta.getSlackUserLinkByUser("default", owner.id)).toBe(null)
  })

  it("unlinks the caller's own account", async () => {
    const { app, meta } = make("slack-unlink")
    await install(meta)
    await meta.setSlackUserLink({
      id: "sul-2",
      org_id: "default",
      slack_user_id: "U-owner",
      user_id: owner.id,
      status: "confirmed",
      dm_channel_id: null,
      created_at: new Date().toISOString(),
    })
    const r = await app.request("/v1/slack/link", { method: "DELETE", headers: as(owner.email) })
    expect(r.status).toBe(204)
    expect(await meta.getSlackUserLinkByUser("default", owner.id)).toBe(null)
  })
})
