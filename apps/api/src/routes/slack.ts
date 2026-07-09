import { newId, type SlackInstallRecord } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { decryptSecret, encryptSecret, signState, verifyState } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"
import {
  exchangeSlackOAuth,
  slackAuthorizeUrl,
  slackUserName,
  verifySlackSignature,
} from "../lib/slack"
import { ingestSlackReply } from "../lib/slack-comments"
import { enqueueSlackDm, wantsMentionDm } from "../lib/slack-dm"
import { log } from "../log"
import { buildSlackManifest, slackSetupHTML } from "../slack-app-setup"

/** Slack App: connect a workspace (OAuth), receive its Events API (comment reply-back),
 *  and post notifications for Derive activity (via the notify() event stream — see
 *  lib/slack-events.ts). The events endpoint is signature-gated (no session) — it's in
 *  the app's anon-write allow list. The connect endpoints require a signed-in workspace
 *  admin. The SlackStatus response schema is the single source for the web client's
 *  type; the OAuth redirects and the Slack Events webhook stay plain routes (not typed
 *  JSON). */
export const slackRoutes = (ctx: AppContext) => {
  const { meta, deps, bus, requireUser } = ctx
  const { activeWorkspace, workspaceCan } = ctx
  const app = new OpenAPIHono<BlankEnv>()
  const slack = deps.slack
  const redirectUri = new URL("/v1/slack/oauth/callback", deps.baseUrl).toString()

  interface ConnectState {
    org: string
    uid: string
    iat: number
  }

  const SlackStatus = z
    .object({
      available: z.boolean(),
      connected: z.boolean(),
      team_name: z.string().nullable(),
      default_channel: z.string().nullable(),
      /** Whether the stored bot token needs a re-auth (an auth error since connecting). */
      needs_reauth: z.boolean(),
      /** The caller's "DM me when I'm @mentioned" preference. */
      mention_dm: z.boolean(),
    })
    .openapi("SlackStatus")

  // Start the connect flow: redirect an admin to Slack's OAuth consent, binding the
  // install to this workspace + user via signed state (same pattern as GitHub install).
  app.get("/v1/slack/install", async (c) => {
    if (!slack || !deps.encryptionKey) return fail(c, 404, "Slack is not configured")
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const state = signState({ org: await activeWorkspace(c), uid: me.id }, deps.encryptionKey)
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
      const link = await meta.getSlackThreadLinkByTs(ev.channel, ev.thread_ts)
      if (link && deps.encryptionKey && (await meta.getOrgSettings(link.org_id)).slackPost) {
        const install = await meta.getSlackInstall(link.org_id)
        if (install) {
          const token = decryptSecret(install.bot_token, deps.encryptionKey)
          const name = await slackUserName(token, ev.user)
          const created = await ingestSlackReply(meta, link, {
            ts: ev.ts ?? "",
            userId: ev.user,
            userName: name,
            text: ev.text,
            botUserId: install.bot_user_id,
          })
          if (created) bus.publish(created.artifact_id, { type: "comment.created" })
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
      return c.json({
        available: !!slack,
        connected: !!install,
        team_name: install?.team_name ?? null,
        default_channel: install?.default_channel ?? null,
        needs_reauth: install?.needs_reauth === 1,
        mention_dm: wantsMentionDm(pref?.prefs),
      })
    },
  )

  // Toggle the caller's "DM me when I'm @mentioned" preference.
  app.patch("/v1/slack/prefs", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const b = await readJson(c, z.object({ mention_dm: z.boolean() }))
    if (b instanceof Response) return b
    const org = await activeWorkspace(c)
    const cur = await meta.getUserNotificationPref(org, me.id)
    let existing: Record<string, unknown> = {}
    try {
      if (cur) existing = JSON.parse(cur.prefs) as Record<string, unknown>
    } catch {}
    const prefs = { ...existing, slackMentionDm: b.mention_dm }
    await meta.setUserNotificationPref({
      id: cur?.id ?? newId("unp"),
      org_id: org,
      user_id: me.id,
      prefs: JSON.stringify(prefs),
      created_at: cur?.created_at ?? new Date().toISOString(),
    })
    return c.json({ mention_dm: b.mention_dm })
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
      if (!(await workspaceCan(c, "manage"))) return bail(fail(c, 403, "forbidden"))
      const org = await activeWorkspace(c)
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
      if (!(await workspaceCan(c, "manage"))) return bail(fail(c, 403, "forbidden"))
      await meta.deleteSlackInstall(await activeWorkspace(c))
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
