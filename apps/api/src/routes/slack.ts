import type { SlackInstallRecord } from "@derive/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { decryptSecret, encryptSecret, signState, verifyState } from "../lib/crypto"
import { fail, readJson } from "../lib/http"
import {
  exchangeSlackOAuth,
  respondEphemeral,
  slackAuthorizeUrl,
  slackUserName,
  verifySlackSignature,
} from "../lib/slack"
import type { ButtonValue } from "../lib/slack-cards"
import { ingestSlackReply } from "../lib/slack-comments"
import { log } from "../log"

/** Slack App: connect a workspace (OAuth) and receive its Events API (reply-back). The
 *  events endpoint is signature-gated (no session) — it's in the app's anon-write allow
 *  list. The connect endpoints require a signed-in workspace admin. */
export const slackRoutes = (ctx: AppContext) => {
  const { meta, deps, bus, background, requireUser, activeWorkspace, workspaceCan } = ctx
  const app = new Hono()
  const slack = deps.slack
  const redirectUri = new URL("/v1/slack/oauth/callback", deps.baseUrl).toString()

  interface ConnectState {
    org: string
    uid: string
    iat: number
  }

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

  // OAuth callback: exchange the code for a bot token and store the install (encrypted).
  app.get("/v1/slack/oauth/callback", async (c) => {
    if (!slack || !deps.encryptionKey) return fail(c, 404, "Slack is not configured")
    const code = c.req.query("code")
    const stateRaw = c.req.query("state")
    const state = stateRaw ? verifyState<ConnectState>(stateRaw, deps.encryptionKey) : null
    if (!code || !state) return fail(c, 400, "invalid Slack callback")
    try {
      const r = await exchangeSlackOAuth(slack.clientId, slack.clientSecret, code, redirectUri)
      await meta.setSlackInstall({
        org_id: state.org,
        team_id: r.teamId,
        team_name: r.teamName,
        bot_token: encryptSecret(r.botToken, deps.encryptionKey),
        bot_user_id: r.botUserId,
        default_channel: null,
        created_at: new Date().toISOString(),
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

  // Interactive components (Block Kit button clicks). Signature-gated like the events
  // endpoint (no session). Slack posts application/x-www-form-urlencoded with a single
  // `payload` field (URL-encoded JSON) and expects a fast 200; the real reply is sent
  // out-of-band to the payload's response_url. In PR-1 (before Slack↔Derive identity
  // linking) an action button just points the clicker back into Derive to act; PR-2 makes
  // approve / request-changes / resolve execute inline once the user is linked.
  // authz-exempt: Slack signs every request with the signing secret (verifySlackSignature); no session on an interaction.
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

    const encoded = new URLSearchParams(raw).get("payload")
    if (!encoded) return c.json({})
    let payload: SlackInteractionPayload
    try {
      payload = JSON.parse(encoded) as SlackInteractionPayload
    } catch {
      return fail(c, 400, "invalid payload")
    }

    if (payload.type === "block_actions" && payload.response_url) {
      const responseUrl = payload.response_url
      for (const action of payload.actions ?? []) {
        const text = ephemeralForAction(action, deps.baseUrl)
        // Reply out-of-band so the 200 ack stays well under Slack's 3s window.
        if (text) background(respondEphemeral(responseUrl, text))
      }
    }
    return c.json({})
  })

  // Connection status for the Settings UI: whether Slack is configured at all, whether
  // this workspace has connected one, and its team + default channel.
  app.get("/v1/slack", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const install = await meta.getSlackInstall(await activeWorkspace(c))
    return c.json({
      available: !!slack,
      connected: !!install,
      team_name: install?.team_name ?? null,
      default_channel: install?.default_channel ?? null,
    })
  })

  // Set the channel Derive posts to (Slack channel id, e.g. "C0123ABC"). Admin only.
  app.patch("/v1/slack", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const org = await activeWorkspace(c)
    const install = await meta.getSlackInstall(org)
    if (!install) return fail(c, 404, "Slack is not connected")
    const b = await readJson(c, z.object({ default_channel: z.string().nullable() }))
    if (b instanceof Response) return b
    const channel = b.default_channel?.trim() ? b.default_channel.trim() : null
    await meta.setSlackInstall({ ...install, default_channel: channel })
    return c.json({ default_channel: channel })
  })

  // Disconnect Slack (admin). Drops the install; thread links are left inert.
  app.delete("/v1/slack", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    await meta.deleteSlackInstall(await activeWorkspace(c))
    return c.body(null, 204)
  })

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

interface SlackInteractionAction {
  action_id?: string
  value?: string
}
interface SlackInteractionPayload {
  type?: string
  response_url?: string
  user?: { id?: string }
  actions?: SlackInteractionAction[]
}

/** Parse an interaction button and return the ephemeral message to send back, or null to
 *  ignore it. PR-1 always points the clicker into Derive to act (identity linking, which
 *  lets approve / request-changes / resolve run inline, lands in PR-2). */
const ephemeralForAction = (action: SlackInteractionAction, baseUrl: string): string | null => {
  if (!action.action_id?.startsWith("slack_act:") || !action.value) return null
  let v: ButtonValue
  try {
    v = JSON.parse(action.value) as ButtonValue
  } catch {
    return null
  }
  const settings = `${baseUrl.replace(/\/$/, "")}/settings/integrations`
  switch (v.act) {
    case "approve":
      return `Open this proposal in Derive to approve it: ${v.url}`
    case "request_changes":
      return `Open this proposal in Derive to request changes: ${v.url}`
    case "resolve":
      return `Open this thread in Derive to resolve it: ${v.url}`
    case "link_account":
      return `Link your Slack account to act from here: ${settings}`
    default:
      return null
  }
}
