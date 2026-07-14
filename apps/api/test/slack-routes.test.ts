import { createHmac } from "node:crypto"
import type { CommentRecord, MetaStore, NewComment, SlackThreadLinkRecord } from "@derive/core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { encryptSecret } from "../src/lib/crypto"
import { ingestSlackReply, makeSlackIngestSender } from "../src/lib/slack-comments"
import { runDeliveryTick } from "../src/webhooks"
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
      default_channel: "C1",
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
      default_channel: "C1",
      created_at: new Date().toISOString(),
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
})
