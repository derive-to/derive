import { newId, type SlackInstallRecord } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { encryptSecret, signState, verifyState } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"
import {
  exchangeSlackOAuth,
  exchangeSlackOidc,
  postSlackResponseUrl,
  slackAuthorizeUrl,
  slackOidcAuthorizeUrl,
  slackOidcUserinfo,
  verifySlackSignature,
} from "../lib/slack"
import {
  enqueueSlackReplyIngest,
  SLACK_THREAD_ACTION,
  threadStateBlocks,
} from "../lib/slack-comments"
import { enqueueSlackDm, wantsSlackDm } from "../lib/slack-dm"
import { resolveThreadAction } from "../lib/thread-actions"
import { log } from "../log"
import { buildSlackManifest, slackSetupHTML } from "../slack-app-setup"

/** Slack App: connect a workspace (OAuth), receive its Events API (comment reply-back),
 *  and DM a workspace member for the same interrupts email does — mentions, review
 *  requests, shares (see lib/slack-dm.ts). The events endpoint is signature-gated (no
 *  session) — it's in the app's anon-write allow list. The connect endpoints require a
 *  signed-in workspace admin. The SlackStatus response schema is the single source for
 *  the web client's type; the OAuth redirects and the Slack Events webhook stay plain
 *  routes (not typed JSON). */
export const slackRoutes = (ctx: AppContext) => {
  const { meta, deps, bus, notify, requireUser } = ctx
  const { activeWorkspace, workspaceCan, requireWorkspace } = ctx
  const app = new OpenAPIHono<BlankEnv>()
  const slack = deps.slack
  const redirectUri = new URL("/v1/slack/oauth/callback", deps.baseUrl).toString()
  const linkRedirectUri = new URL("/v1/slack/link/callback", deps.baseUrl).toString()

  interface ConnectState {
    org: string
    uid: string
    iat: number
  }

  const SlackStatus = z
    .object({
      available: z.boolean().describe("True if this instance has Slack configured at all"),
      connected: z.boolean().describe("True if this workspace has connected a Slack team"),
      team_name: z
        .string()
        .nullable()
        .describe("The connected Slack team's name, or null if not connected"),
      default_channel: z
        .string()
        .nullable()
        .describe("The channel Derive posts to, or null if unset"),
      needs_reauth: z
        .boolean()
        .describe("Whether the stored bot token needs a re-auth (an auth error since connecting)"),
      slack_dm: z
        .boolean()
        .describe(
          'The caller\'s "DM me for interrupts" preference (mentions, review requests, shares)',
        ),
      linked: z
        .boolean()
        .describe("Whether the caller has linked their Slack identity for the connected team"),
    })
    .openapi("SlackStatus")

  // Start the connect flow: redirect an admin to Slack's OAuth consent, binding the
  // install to this workspace + user via signed state (same pattern as GitHub install).
  app.get("/v1/slack/install", async (c) => {
    if (!slack || !deps.encryptionKey) return fail(c, 404, "Slack is not configured")
    const org = await requireWorkspace(c, "manage")
    if (org instanceof Response) return org
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const state = signState({ org, uid: me.id }, deps.encryptionKey)
    return c.redirect(slackAuthorizeUrl(slack.clientId, redirectUri, state))
  })

  // One-place setup for a fresh deployment: the app manifest, already pointed at this
  // instance's URL, plus the three steps to a live app. Works BEFORE Slack creds exist
  // (that's the point — you create the app here, then set the secrets). Admin-only,
  // top-level nav like the GitHub App setup page.
  app.get("/settings/slack/app/new", async (c) => {
    if (!(await workspaceCan(c, "manage")))
      return c.redirect("/login?return_to=/settings/slack/app/new")
    return c.html(slackSetupHTML(deps.baseUrl))
  })

  // The same manifest as JSON, filled for this instance — the copy-paste source (and
  // what the setup page renders). No secrets in it, but admin-gated for tidiness.
  app.get("/v1/slack/manifest.json", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    return c.json(buildSlackManifest(deps.baseUrl))
  })

  // OAuth callback: exchange the code for a bot token and store the install (encrypted).
  app.get("/v1/slack/oauth/callback", async (c) => {
    if (!slack || !deps.encryptionKey) return fail(c, 404, "Slack is not configured")
    const code = c.req.query("code")
    const stateRaw = c.req.query("state")
    const state = stateRaw ? verifyState<ConnectState>(stateRaw, deps.encryptionKey) : null
    if (!code || !state) return fail(c, 400, "invalid Slack callback")
    try {
      const r = await exchangeSlackOAuth(slack.clientId, slack.clientSecret, code, redirectUri)
      // Preserve an existing default channel across a reconnect.
      const existing = await meta.getSlackInstall(state.org)
      await meta.setSlackInstall({
        org_id: state.org,
        team_id: r.teamId,
        team_name: r.teamName,
        bot_token: encryptSecret(r.botToken, deps.encryptionKey),
        bot_user_id: r.botUserId,
        default_channel: existing?.default_channel ?? null,
        needs_reauth: 0,
        created_at: existing?.created_at ?? new Date().toISOString(),
      } satisfies SlackInstallRecord)
      // Slack lives under the Integrations section (there is no standalone Slack page).
      return c.redirect("/settings/integrations")
    } catch (err) {
      log.warn("slack oauth failed", { error: err instanceof Error ? err.message : String(err) })
      return c.redirect("/settings/integrations?error=oauth")
    }
  })

  // Per-user "Link Slack account" — a lightweight OIDC (Sign in with Slack) flow, separate
  // from the admin bot install: it maps the signed-in Derive user to their Slack identity so
  // DMs/attribution resolve to the real account instead of guessing by email. Any signed-in
  // member (not just admins) may link their own account; the signed state binds the callback
  // to them. Pre-selects the workspace's connected team so they link the right identity.
  app.get("/v1/slack/link", async (c) => {
    if (!slack || !deps.encryptionKey) return fail(c, 404, "Slack is not configured")
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const org = await activeWorkspace(c)
    const install = await meta.getSlackInstall(org)
    if (!install) return c.redirect("/settings/integrations?error=not_connected")
    const state = signState({ org, uid: me.id }, deps.encryptionKey)
    return c.redirect(
      slackOidcAuthorizeUrl(
        slack.clientId,
        linkRedirectUri,
        state,
        newId("nonce"),
        install.team_id,
      ),
    )
  })

  // OIDC callback: recover the signed-in user from the signed state, resolve their Slack
  // identity, and store the link — but only if that identity belongs to the workspace's
  // connected team (else someone could link an identity from an unrelated workspace).
  app.get("/v1/slack/link/callback", async (c) => {
    if (!slack || !deps.encryptionKey) return fail(c, 404, "Slack is not configured")
    const me = await requireUser(c)
    const code = c.req.query("code")
    const stateRaw = c.req.query("state")
    const state = stateRaw ? verifyState<ConnectState>(stateRaw, deps.encryptionKey) : null
    // Bind the completion to the SAME signed-in user who started the flow. The signed state
    // proves who INITIATED it, but it rides the browser URL (leakable / replayable for its
    // 15-min window), so a session is required and must match — otherwise someone who got a
    // victim's state could complete the link and route the victim's DMs to their own Slack.
    if (me instanceof Response || !code || !state || me.id !== state.uid)
      return c.redirect("/settings/integrations?error=link")
    try {
      const { accessToken } = await exchangeSlackOidc(
        slack.clientId,
        slack.clientSecret,
        code,
        linkRedirectUri,
      )
      const identity = await slackOidcUserinfo(accessToken)
      const install = await meta.getSlackInstall(state.org)
      if (!install || install.team_id !== identity.teamId)
        return c.redirect("/settings/integrations?error=link_team")
      // One link per user per team: clear any prior link, then store the new one, bound to the
      // Derive user from the signed state (never from the OAuth response).
      await meta.deleteSlackUserLink(identity.teamId, state.uid)
      await meta.setSlackUserLink({
        id: newId("sul"),
        org_id: state.org,
        user_id: state.uid,
        team_id: identity.teamId,
        slack_user_id: identity.slackUserId,
        created_at: new Date().toISOString(),
      })
      return c.redirect("/settings/integrations")
    } catch (err) {
      log.warn("slack link failed", { error: err instanceof Error ? err.message : String(err) })
      return c.redirect("/settings/integrations?error=link")
    }
  })

  // Unlink the caller's Slack identity for the active workspace's team.
  app.delete("/v1/slack/link", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return bail(me)
    const org = await activeWorkspace(c)
    const install = await meta.getSlackInstall(org)
    if (install) await meta.deleteSlackUserLink(install.team_id, me.id)
    return c.body(null, 204)
  })

  // Inbound Events API: url_verification challenge + threaded message replies → Derive.
  // Respond fast and do the work best-effort. Same model as the GitHub App webhook.
  // authz-exempt: Slack signs every request with the signing secret (verifySlackSignature); no session on a webhook.
  app.post("/v1/slack/events", async (c) => {
    if (!slack) return fail(c, 404, "Slack is not configured")
    const raw = await c.req.text()
    if (
      !verifySlackSignature(
        slack.signingSecret,
        c.req.header("x-slack-request-timestamp"),
        raw,
        c.req.header("x-slack-signature"),
      )
    )
      return fail(c, 401, "bad signature")

    let body: SlackEventEnvelope
    try {
      body = JSON.parse(raw) as SlackEventEnvelope
    } catch {
      return fail(c, 400, "invalid payload")
    }
    if (body.type === "url_verification") return c.json({ challenge: body.challenge })

    const ev = body.event
    // Only human thread replies: a message with a thread_ts, no bot_id, not an edit/delete.
    if (
      body.type === "event_callback" &&
      ev?.type === "message" &&
      !ev.bot_id &&
      !ev.subtype &&
      ev.thread_ts &&
      ev.channel &&
      ev.user &&
      ev.text
    ) {
      // Gate on a cheap indexed lookup (only replies under a message we posted map to a
      // Derive thread) so channel chatter never floods the outbox, then defer the slow work
      // — users.info + the comment write — to the worker. That keeps this handler well under
      // Slack's 3s ack deadline, and the outbox retries a transient failure instead of
      // dropping the reply (the old inline path did all of it before acking).
      const link = await meta.getSlackThreadLinkByTs(ev.channel, ev.thread_ts)
      if (link) {
        await enqueueSlackReplyIngest(meta, {
          channel: ev.channel,
          threadTs: ev.thread_ts,
          userId: ev.user,
          text: ev.text,
          ts: ev.ts ?? "",
        })
        deps.pokeWebhooks?.()
      }
    }
    return c.json({ ok: true })
  })

  // Block Kit interactivity: a button on a comment card resolves / reopens that thread. Trust,
  // like reply-back, is by data not a Derive principal — but the target here comes from the
  // (attacker-influenceable) button value, so we bind it three ways: (1) the Slack signature
  // authenticates the request; (2) a slack_thread_link maps threadId→artifact→org; (3) the
  // ACTING Slack team must equal that org's connected install — so one signed workspace can't
  // act on another org's thread by carrying its ids (the events path is immune to this because
  // it keys on Slack-assigned channel+ts, not a value). Then the org's slackPost opt-in gates it.
  // Deliberately NOT gated on a Derive role: any member of the connected channel can resolve, the
  // same collaboration boundary reply-back already grants for posting — and resolve is reversible.
  // The state flip is applied + fanned out inline (durable before we ack); the cosmetic Slack
  // card update is fired without awaiting, so a slow response_url can't push us past the 3s ack.
  // authz-exempt: Slack signs every request with the signing secret (verifySlackSignature).
  app.post("/v1/slack/interactivity", async (c) => {
    if (!slack) return fail(c, 404, "Slack is not configured")
    const raw = await c.req.text()
    if (
      !verifySlackSignature(
        slack.signingSecret,
        c.req.header("x-slack-request-timestamp"),
        raw,
        c.req.header("x-slack-signature"),
      )
    )
      return fail(c, 401, "bad signature")

    // Interactivity is form-encoded: a single `payload` field holding URL-encoded JSON.
    const payloadStr = new URLSearchParams(raw).get("payload")
    if (!payloadStr) return c.json({ ok: true })
    let payload: SlackInteractionPayload
    try {
      payload = JSON.parse(payloadStr) as SlackInteractionPayload
    } catch {
      return fail(c, 400, "invalid payload")
    }

    const action = payload.actions?.[0]
    const op =
      action?.action_id === SLACK_THREAD_ACTION.resolve
        ? "resolved"
        : action?.action_id === SLACK_THREAD_ACTION.reopen
          ? "open"
          : undefined
    // Not a thread action we handle (or a malformed value) → ack and ignore.
    if (payload.type !== "block_actions" || !op || !action?.value) return c.json({ ok: true })
    let target: { a?: string; t?: string }
    try {
      target = JSON.parse(action.value) as { a?: string; t?: string }
    } catch {
      return c.json({ ok: true })
    }
    const { a: artifactId, t: threadId } = target
    if (!artifactId || !threadId) return c.json({ ok: true })

    // Re-establish trust from data (never the button value alone): the thread link maps this
    // thread to this artifact + org, the acting Slack team owns that org's install, and the
    // org's channel mirror is on. Any miss → ack and no-op (a click that changes nothing).
    const link = await meta.getSlackThreadLinkByThread(threadId)
    if (link && link.artifact_id === artifactId) {
      const install = await meta.getSlackInstall(link.org_id)
      const teamOwnsThread = !!install && !!payload.team?.id && install.team_id === payload.team.id
      if (teamOwnsThread && (await meta.getOrgSettings(link.org_id)).slackPost) {
        const artifact = await meta.getArtifactById(artifactId)
        if (artifact) {
          await resolveThreadAction({ meta, bus, notify }, artifact, threadId, op)
          // Reflect the new state in Slack: keep the comment section, swap the button + footer.
          // Fire-and-forget — the resolve above is already durable, so a slow/failed cosmetic
          // update must not sit on the ack path (waitUntil on Workers; in-process on Node).
          const who = payload.user?.username || payload.user?.name || undefined
          const section0 = payload.message?.blocks?.[0]
          const blocks = [section0, ...threadStateBlocks(op, action.value, who)].filter(Boolean)
          if (payload.response_url) {
            const update = postSlackResponseUrl(payload.response_url, {
              text: op === "resolved" ? "Thread resolved" : "Thread reopened",
              blocks,
              replace_original: true,
            })
            try {
              c.executionCtx.waitUntil(update)
            } catch {
              void update // Node has no executionCtx; the promise runs in-process
            }
          }
        }
      }
    }
    return c.json({ ok: true })
  })

  // Connection status for the Settings UI: whether Slack is configured at all, whether
  // this workspace has connected one, and its team + default channel.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/slack",
      tags: ["Slack"],
      summary: "Slack connection status for the signed-in user's workspace.",
      responses: {
        200: {
          description: "Whether Slack is available + connected, and the team + default channel.",
          content: { "application/json": { schema: SlackStatus } },
        },
      },
    }),
    async (c) => {
      const me = await requireUser(c)
      if (me instanceof Response) return bail(me)
      const org = await activeWorkspace(c)
      const install = await meta.getSlackInstall(org)
      // Read the DM preference regardless of connection state so the reported value always
      // reflects what's stored (the toggle can be set before/after connecting).
      const pref = await meta.getUserNotificationPref(org, me.id)
      // Whether THIS user has linked their Slack identity for the connected team.
      const linked = install ? !!(await meta.getSlackUserLinkByUser(install.team_id, me.id)) : false
      return c.json({
        available: !!slack,
        connected: !!install,
        team_name: install?.team_name ?? null,
        default_channel: install?.default_channel ?? null,
        needs_reauth: install?.needs_reauth === 1,
        slack_dm: wantsSlackDm(pref?.prefs),
        linked,
      })
    },
  )

  // Toggle the caller's "DM me for interrupts" preference.
  app.patch("/v1/slack/prefs", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const b = await readJson(c, z.object({ slack_dm: z.boolean() }))
    if (b instanceof Response) return b
    const org = await activeWorkspace(c)
    const cur = await meta.getUserNotificationPref(org, me.id)
    let existing: Record<string, unknown> = {}
    try {
      if (cur) existing = JSON.parse(cur.prefs) as Record<string, unknown>
    } catch {}
    const prefs = { ...existing, slackDm: b.slack_dm }
    await meta.setUserNotificationPref({
      id: cur?.id ?? newId("unp"),
      org_id: org,
      user_id: me.id,
      prefs: JSON.stringify(prefs),
      created_at: cur?.created_at ?? new Date().toISOString(),
    })
    return c.json({ slack_dm: b.slack_dm })
  })

  // Send the caller a test DM (verifies their account email matches a Slack account +
  // the bot's im:write scope).
  app.post("/v1/slack/test-dm", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const org = await activeWorkspace(c)
    if (!(await meta.getSlackInstall(org))) return fail(c, 400, "Slack is not connected")
    await enqueueSlackDm(meta, org, me.id, "Derive test DM — notifications are working.", [
      {
        type: "section",
        text: { type: "mrkdwn", text: ":wave: This is a test DM from Derive. You're all set." },
      },
    ])
    deps.pokeWebhooks?.()
    return c.json({ ok: true })
  })

  // Set the channel Derive posts to (Slack channel id, e.g. "C0123ABC"). Admin only.
  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/slack",
      tags: ["Slack"],
      summary: "Set the channel Derive posts to (Admin only).",
      responses: {
        200: {
          description: "The new default channel (or null to clear it).",
          content: {
            "application/json": { schema: z.object({ default_channel: z.string().nullable() }) },
          },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const install = await meta.getSlackInstall(org)
      if (!install) return bail(fail(c, 404, "Slack is not connected"))
      const b = await readJson(c, z.object({ default_channel: z.string().nullable() }))
      if (b instanceof Response) return bail(b)
      const channel = b.default_channel?.trim() ? b.default_channel.trim() : null
      await meta.setSlackInstall({ ...install, default_channel: channel })
      return c.json({ default_channel: channel })
    },
  )

  // Disconnect Slack (admin). Drops the install; thread links are left inert.
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/slack",
      tags: ["Slack"],
      summary: "Disconnect Slack from the workspace (Admin only).",
      responses: { 204: { description: "Slack was disconnected." } },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      await meta.deleteSlackInstall(org)
      return c.body(null, 204)
    },
  )

  return app
}

interface SlackEventEnvelope {
  type?: string
  challenge?: string
  event?: {
    type?: string
    subtype?: string
    bot_id?: string
    user?: string
    text?: string
    channel?: string
    ts?: string
    thread_ts?: string
  }
}

/** The Block Kit interactivity payload (the JSON inside the form's `payload` field). Only the
 *  fields the thread-action handler reads; `message.blocks` is the original card, reused so
 *  the resolved/reopened card keeps its comment section. */
interface SlackInteractionPayload {
  type?: string
  response_url?: string
  /** The workspace the click came from; bound to the thread's org install for authz. */
  team?: { id?: string }
  user?: { id?: string; username?: string; name?: string }
  actions?: Array<{ action_id?: string; value?: string }>
  message?: { blocks?: unknown[] }
}
