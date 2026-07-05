import { newId, type SlackInstallRecord } from "@derive/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { decryptSecret, encryptSecret, signState, verifyState } from "../lib/crypto"
import { fail, readJson } from "../lib/http"
import { notifyMentions } from "../lib/mentions"
import { approveProposalAction, requestChangesAction } from "../lib/proposal-actions"
import {
  exchangeSlackOAuth,
  exchangeSlackOpenId,
  replaceOriginal,
  respondEphemeral,
  slackAuthorizeUrl,
  slackOpenIdAuthorizeUrl,
  slackUserName,
  verifySlackSignature,
} from "../lib/slack"
import type { ButtonValue } from "../lib/slack-cards"
import { ingestSlackReply, resolveSlackMentions } from "../lib/slack-comments"
import { enqueueSlackDm, wantsMentionDm } from "../lib/slack-dm"
import { log } from "../log"

/** Slack App: connect a workspace (OAuth) and receive its Events API (reply-back). The
 *  events endpoint is signature-gated (no session) — it's in the app's anon-write allow
 *  list. The connect endpoints require a signed-in workspace admin. */
export const slackRoutes = (ctx: AppContext) => {
  const { meta, deps, bus, blobs, notify, background, authorizeUser, requireUser } = ctx
  const { activeWorkspace, workspaceCan } = ctx
  const app = new Hono()
  const slack = deps.slack
  const redirectUri = new URL("/v1/slack/oauth/callback", deps.baseUrl).toString()
  const linkRedirectUri = new URL("/v1/slack/link/callback", deps.baseUrl).toString()

  // Run one interactive action out-of-band (backgrounded from the fast ack). Proposal
  // buttons execute inline for a linked user who's authorized in Derive (same `can` check
  // as the HTTP route, via authorizeUser), then swap the card for a result line. An
  // unlinked user, an unauthorized user, or a settled proposal gets an ephemeral reply
  // only they see — the action is never taken on an unverified identity.
  const runInteraction = async (
    action: SlackInteractionAction,
    responseUrl: string,
    slackUserId: string | undefined,
  ): Promise<void> => {
    if (!action.action_id?.startsWith("slack_act:") || !action.value) return
    let v: ButtonValue
    try {
      v = JSON.parse(action.value) as ButtonValue
    } catch {
      return
    }

    if (v.act === "approve" || v.act === "request_changes") {
      const link = slackUserId ? await meta.getSlackUserLinkBySlackId(v.org, slackUserId) : null
      if (link?.status !== "confirmed") {
        // Not linked: point them into Derive (where their session authorizes the action).
        await respondEphemeral(responseUrl, ephemeralForAction(action, deps.baseUrl) ?? v.url)
        return
      }
      const proposal = await meta.getProposal(v.id)
      const artifact = proposal ? await meta.getArtifactById(proposal.artifact_id) : null
      if (!proposal || !artifact) {
        await respondEphemeral(responseUrl, "That proposal is no longer available.")
        return
      }
      if (!(await authorizeUser(link.user_id, "approve", artifact))) {
        await respondEphemeral(responseUrl, "You do not have permission to review this in Derive.")
        return
      }
      if (proposal.state !== "open") {
        await respondEphemeral(responseUrl, `This proposal is already ${proposal.state}.`)
        return
      }
      const [user] = await meta.getUsers([link.user_id])
      const who = user?.name ?? user?.username ?? "Someone"
      const actionDeps = { meta, blobs, bus, notify }
      if (v.act === "approve") {
        await approveProposalAction(actionDeps, artifact, proposal, who, null)
        await replaceOriginal(responseUrl, `:white_check_mark: Approved by ${who} — published.`)
      } else {
        await requestChangesAction(actionDeps, artifact, proposal, who, null)
        await replaceOriginal(responseUrl, `:leftwards_arrow_with_hook: ${who} requested changes.`)
      }
      return
    }

    // link_account (or anything else): ephemeral guidance only.
    const text = ephemeralForAction(action, deps.baseUrl)
    if (text) await respondEphemeral(responseUrl, text)
  }

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
      // Preserve an existing default channel + links across a reconnect (re-auth for a new
      // scope shouldn't wipe the workspace's config).
      const existing = await meta.getSlackInstall(state.org)
      await meta.setSlackInstall({
        org_id: state.org,
        team_id: r.teamId,
        team_name: r.teamName,
        bot_token: encryptSecret(r.botToken, deps.encryptionKey),
        bot_user_id: r.botUserId,
        default_channel: existing?.default_channel ?? null,
        granted_scopes: r.scopes,
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
          if (created) {
            bus.publish(created.artifact_id, { type: "comment.created" })
            // @mentions of linked teammates in the Slack reply notify them in Derive.
            const mentions = await resolveSlackMentions(meta, link.org_id, ev.text)
            const artifact = mentions.length ? await meta.getArtifactById(link.artifact_id) : null
            if (artifact) {
              const actor = await meta.getSlackUserLinkBySlackId(link.org_id, ev.user)
              await notifyMentions(
                { meta, bus },
                artifact,
                created,
                mentions,
                actor?.user_id ?? null,
              )
            }
          }
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
      const slackUserId = payload.user?.id
      // Run out-of-band so the 200 ack stays well under Slack's 3s window.
      for (const action of payload.actions ?? [])
        background(runInteraction(action, responseUrl, slackUserId))
    }
    return c.json({})
  })

  // Connection status for the Settings UI: whether Slack is configured at all, whether
  // this workspace has connected one, and its team + default channel.
  app.get("/v1/slack", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const org = await activeWorkspace(c)
    const install = await meta.getSlackInstall(org)
    // Whether the signed-in user has linked their own Slack account in this workspace.
    const link = install ? await meta.getSlackUserLinkByUser(org, me.id) : null
    // Read the DM preference regardless of connection state so the reported value always
    // reflects what's stored (the toggle can be set before/after connecting).
    const pref = await meta.getUserNotificationPref(org, me.id)
    return c.json({
      available: !!slack,
      connected: !!install,
      team_name: install?.team_name ?? null,
      default_channel: install?.default_channel ?? null,
      needs_reauth: install?.needs_reauth === 1,
      linked: link?.status === "confirmed",
      mention_dm: wantsMentionDm(pref?.prefs),
    })
  })

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

  // Send the caller a test DM (verifies their link + the bot's im:write scope).
  app.post("/v1/slack/test-dm", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const org = await activeWorkspace(c)
    const link = await meta.getSlackUserLinkByUser(org, me.id)
    if (link?.status !== "confirmed") return fail(c, 400, "link your Slack account first")
    await enqueueSlackDm(meta, org, me.id, "Derive test DM — notifications are working.", [
      {
        type: "section",
        text: { type: "mrkdwn", text: ":wave: This is a test DM from Derive. You're all set." },
      },
    ])
    deps.pokeWebhooks?.()
    return c.json({ ok: true })
  })

  // Account linking: prove which Slack user the signed-in Derive user is, via Slack's
  // OpenID Connect ("Sign in with Slack"). Separate from the bot install — this only
  // establishes identity, so Slack-side actions and DMs can act as / reach this user.
  app.get("/v1/slack/link", async (c) => {
    if (!slack || !deps.encryptionKey) return fail(c, 404, "Slack is not configured")
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const org = await activeWorkspace(c)
    const install = await meta.getSlackInstall(org)
    if (!install) return fail(c, 404, "Slack is not connected")
    const state = signState({ org, uid: me.id }, deps.encryptionKey)
    return c.redirect(
      slackOpenIdAuthorizeUrl(slack.clientId, linkRedirectUri, state, install.team_id),
    )
  })

  app.get("/v1/slack/link/callback", async (c) => {
    if (!slack || !deps.encryptionKey) return fail(c, 404, "Slack is not configured")
    const code = c.req.query("code")
    const stateRaw = c.req.query("state")
    const state = stateRaw ? verifyState<ConnectState>(stateRaw, deps.encryptionKey) : null
    if (!code || !state) return fail(c, 400, "invalid Slack callback")
    try {
      const install = await meta.getSlackInstall(state.org)
      if (!install) return c.redirect("/settings/integrations?error=link")
      const id = await exchangeSlackOpenId(
        slack.clientId,
        slack.clientSecret,
        code,
        linkRedirectUri,
      )
      // The linked Slack identity must belong to the workspace's connected team.
      if (id.teamId !== install.team_id) return c.redirect("/settings/integrations?error=link_team")
      await meta.setSlackUserLink({
        id: newId("sul"),
        org_id: state.org,
        slack_user_id: id.slackUserId,
        user_id: state.uid,
        status: "confirmed",
        dm_channel_id: null,
        created_at: new Date().toISOString(),
      })
      return c.redirect("/settings/integrations?linked=1")
    } catch (err) {
      log.warn("slack link failed", { error: err instanceof Error ? err.message : String(err) })
      return c.redirect("/settings/integrations?error=link")
    }
  })

  // Unlink the signed-in user's own Slack account.
  app.delete("/v1/slack/link", async (c) => {
    const me = await requireUser(c)
    if (me instanceof Response) return me
    const org = await activeWorkspace(c)
    const link = await meta.getSlackUserLinkByUser(org, me.id)
    if (link) await meta.deleteSlackUserLink(org, link.slack_user_id)
    return c.body(null, 204)
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

  // Channel routing: which channel a workspace's event cards post to, by target (a
  // collection's artifacts, or the workspace default). Admin only.
  app.get("/v1/slack/routes", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    return c.json({ routes: await meta.listSlackChannelRoutes(await activeWorkspace(c)) })
  })

  app.put("/v1/slack/routes", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const b = await readJson(
      c,
      z.object({
        target_type: z.enum(["collection", "default"]),
        target_id: z.string().default(""),
        channel_id: z.string().min(1),
      }),
    )
    if (b instanceof Response) return b
    // A default route has no target; a collection route needs one.
    const targetId = b.target_type === "default" ? "" : b.target_id.trim()
    if (b.target_type === "collection" && !targetId) return fail(c, 400, "target_id required")
    await meta.setSlackChannelRoute({
      id: newId("scr"),
      org_id: await activeWorkspace(c),
      target_type: b.target_type,
      target_id: targetId,
      channel_id: b.channel_id.trim(),
      created_at: new Date().toISOString(),
    })
    return c.json({ ok: true })
  })

  app.delete("/v1/slack/routes", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const b = await readJson(
      c,
      z.object({
        target_type: z.enum(["collection", "default"]),
        target_id: z.string().default(""),
      }),
    )
    if (b instanceof Response) return b
    await meta.deleteSlackChannelRoute(await activeWorkspace(c), b.target_type, b.target_id)
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
