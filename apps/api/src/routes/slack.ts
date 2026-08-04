import {
  type ArtifactRecord,
  candidateShortIds,
  newId,
  roleAllows,
  type SlackInstallRecord,
  type UnfurlInfo,
} from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { Context } from "hono"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { type ArtifactStatus, artifactStatus } from "../lib/artifact-status"
import { commentCreatedAction } from "../lib/comment-actions"
import { commentDeepLink } from "../lib/comments"
import { encryptSecret, signState, verifyState } from "../lib/crypto"
import { bail, fail, readJson } from "../lib/http"
import { OG_TOKEN_TTL_MS, signOgToken } from "../lib/og-token"
import { searchMatcher, searchWorkspace, toSearchHits } from "../lib/search"
import {
  exchangeSlackOAuth,
  exchangeSlackOidc,
  listSlackChannels,
  openSlackView,
  postSlackResponseUrl,
  presentSlackEntityDetails,
  slackAuthorizeUrl,
  slackChannelReach,
  slackOidcAuthorizeUrl,
  slackOidcUserinfo,
  slackPermalink,
  slackUserName,
  unfurlSlackEntities,
  unfurlSlackLinks,
  verifySlackSignature,
} from "../lib/slack"
import {
  type CapturePrivateMeta,
  captureLinkPromptModal,
  captureModal,
  captureOptions,
  captureResultModal,
  SLACK_CAPTURE_ACTION,
  SLACK_CAPTURE_BLOCK,
  SLACK_CAPTURE_CALLBACK,
  SLACK_CAPTURE_NOTE_ACTION,
  SLACK_CAPTURE_NOTE_BLOCK,
  writeCaptureComment,
} from "../lib/slack-capture"
import { mrkdwnLabel } from "../lib/slack-cards"
import {
  deriveRecentBlocks,
  deriveResultsBlocks,
  helpBlocks,
  notLinkedBlocks,
  subscriptionBlocks,
} from "../lib/slack-commands"
import {
  decodeProposalAction,
  decodeThreadAction,
  enqueueSlackReplyIngest,
  SLACK_PROPOSAL_ACTION,
  SLACK_THREAD_ACTION,
  threadStateBlocks,
} from "../lib/slack-comments"
import { flagSlackReauth, resolveBotToken } from "../lib/slack-delivery"
import { enqueueSlackDm, wantsSlackDm } from "../lib/slack-dm"
import { isVerifiedLink, linkToActMessage } from "../lib/slack-identity"
import { handleSlackMention } from "../lib/slack-mention"
import { runSlackProposalAction } from "../lib/slack-proposal"
import { runSlackReviewAction } from "../lib/slack-review"
import {
  channelIsSubscribed,
  SLACK_SUBSCRIBABLE_EVENTS,
  subscribableEvents,
} from "../lib/slack-subscriptions"
import { artifactRefFromUrl, decideUnfurl, type UnfurlDecision } from "../lib/slack-unfurl"
import {
  artifactDetails,
  artifactEntity,
  DERIVE_ENTITY_TYPE,
  decodeReviewAction,
  SLACK_REVIEW_ACTION,
} from "../lib/slack-work-object"
import { resolveThreadAction } from "../lib/thread-actions"
import { unfurlInfoFor } from "../lib/unfurl-info"
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
  const { meta, deps, bus, notify, background, requireUser, authorizeUserStanding } = ctx
  const { activeWorkspace, workspaceCan, requireWorkspace } = ctx
  const { blobs, sourceText, search, notifyRender, billingBlocked } = ctx
  const app = new OpenAPIHono<BlankEnv>()
  const slack = deps.slack
  const redirectUri = new URL("/v1/slack/oauth/callback", deps.baseUrl).toString()
  const linkRedirectUri = new URL("/v1/slack/link/callback", deps.baseUrl).toString()

  // Every Slack webhook (events, interactivity, commands) is authenticated the same way: Slack
  // HMACs the raw request body with the signing secret. Factored into one guard so the three
  // handlers can't drift — a subtly weaker check on any one endpoint would be a real auth hole.
  // Returns the raw body to parse, or a Response the caller returns as-is (404 unconfigured /
  // 401 bad signature) — mirrors the requireUser/readJson `X | Response` convention.
  const verifiedSlackBody = async (c: Context): Promise<string | Response> => {
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
    return raw
  }

  // Run best-effort work AFTER we've acked Slack (which demands a reply within 3s). On Workers,
  // waitUntil keeps the isolate alive until it settles; on Node the promise just runs in-process.
  // Either way a terminal .catch() is attached FIRST: an
  // unawaited reject (e.g. a lookup throwing inside a deferred proposal action, which runs its
  // early lookups outside its own try/catch) would otherwise escape as an unhandledRejection.
  // Not fatal here — node.ts installs a log-only last-resort handler — but that logs a bare,
  // contextless line and only exists on the Node path; catching at the call site attributes the
  // failure to the Slack deferral on both runtimes instead of leaning on the global net.
  const runAfterAck = (work: Promise<unknown>): void => {
    const guarded = work.catch((err) =>
      log.warn("slack deferred work failed", { err: String(err) }),
    )
    // Via ctx.background, NOT c.executionCtx.
    //
    // The worker calls Hono as `ready.fetch(req)` — one argument — and stashes the real
    // ExecutionContext in an AsyncLocalStorage instead (worker.ts, edgeCtx.run). Hono therefore
    // never receives a ctx, and `c.executionCtx` THROWS on Workers, not only on Node as the old
    // comment assumed. The catch swallowed that into fire-and-forget, so the response returned
    // and the isolate was torn down at the promise's FIRST await — with no log and no exception,
    // because everything worth logging happens after it.
    //
    // Link previews were dead in production for a day on exactly this: link_shared arrived, the
    // synchronous prefix ran, and nothing downstream ever executed. Proposal decisions, the
    // interactivity repaint and the deferred /derive search shared the fault; the response_url
    // ones only appeared to work because their fetch is dispatched before the first await.
    //
    // ctx.background reads the SAME AsyncLocalStorage the worker populates, which is why the
    // comment mirror — its only other user — never had this problem.
    void background(guarded)
  }

  // Render previews for the Derive links in one `link_shared` event.
  //
  // The unfurl is attached to the MESSAGE and seen by the whole channel (Slack has no per-viewer
  // variant), so the gate is "may this be broadcast" — decideUnfurl owns that ladder. The one
  // per-person surface is the sign-in prompt, which Slack shows only to the person who posted
  // the link; that's what an unlinked sharer gets, since without a link there is no principal to
  // authorize against.
  const unfurlSharedLinks = async (teamId: string, ev: SlackEventPayload): Promise<void> => {
    // Every exit below is silent by design — Slack is told nothing, so the channel shows nothing.
    // That is correct behaviour and undiagnosable behaviour at the same time: "I pasted a link
    // and got no preview" has eight possible causes here and, without this, no way to tell them
    // apart short of reasoning through the ladder. One line naming the rung turns that into a
    // log search. Info, not warn: most of these are the system working.
    const why = (reason: string, extra: Record<string, unknown> = {}) =>
      log.info("unfurl skipped", { reason, team: teamId, channel: ev.channel, ...extra })

    const links = (ev.links ?? []).slice(0, 10) // one paste shouldn't fan out unbounded
    if (!links.length || !ev.user) return why(!ev.user ? "no sharer on the event" : "no links")
    // Slack dispatches link_shared for EVERY channel in the workspace, not just the ones the bot
    // is in. Unfurling everywhere would put an artifact's title wherever any member happened to
    // paste a link — so this stays where an admin has actually invited Derive, which is the same
    // consent boundary the channel subscriptions use. Absent (older payloads) is treated as
    // present so this can't silently disable previews.
    if (ev.is_bot_user_member === false) return why("bot is not in this channel")
    const installs = await meta.listSlackInstallsByTeam(teamId)
    if (!installs.length) return why("no Derive workspace is connected to this Slack team")
    const userLink = await meta.getSlackUserLinkBySlackId(teamId, ev.user)
    // One Slack team can back more than one Derive workspace; unfurl into the sharer's own when
    // we know it, else the sole/first install for the team.
    const install = installs.find((i) => i.org_id === userLink?.org_id) ?? installs[0]
    if (!install) return why("no install resolved for the team")
    const bot = await resolveBotToken(meta, install.org_id, deps.encryptionKey)
    if (!bot) return why("no usable bot token", { org: install.org_id })
    const target = {
      channel: ev.channel,
      ts: ev.message_ts,
      unfurlId: ev.unfurl_id,
      source: ev.source,
    }

    // Not linked: prompt once, and only when they actually shared an artifact link — a paste of
    // some other page on our domain shouldn't nag them to connect an account.
    if (!userLink) {
      if (!links.some((l) => artifactRefFromUrl(deps.baseUrl, l.url)))
        return why("sharer has no linked Derive account, and no link was an artifact")
      await unfurlSlackLinks(
        bot.token,
        target,
        {},
        {
          url: new URL("/v1/slack/link", deps.baseUrl).toString(),
          message: "Connect your Derive account to preview links here.",
        },
      )
      return
    }

    const unfurls: Record<string, unknown> = {}
    const entities: unknown[] = []
    for (const l of links) {
      const d = await decideUnfurl(
        {
          meta,
          baseUrl: deps.baseUrl,
          orgId: install.org_id,
          canRead: (userId, artifact) => authorizeUserStanding(userId, "read", artifact),
        },
        l.url,
        userLink.user_id,
      )
      // `skip` is the ladder's catch-all — not ours, gone, another workspace, or not readable by
      // this viewer — and it is the rung that most often surprises someone. Naming the URL is
      // what makes it actionable.
      if (d.kind === "skip" || d.kind === "auth") {
        why(`decision: ${d.kind}`, { url: l.url, viewer: userLink.user_id })
        continue
      }
      unfurls[d.url] = { blocks: d.blocks }
      entities.push(await entityFor(d, l.url))
    }
    if (!Object.keys(unfurls).length) return why("no link produced a card", { links: links.length })

    // Work Object first; the block card is the fallback. unfurlSlackEntities throws on a WARNING
    // as well as an error, because this API answers 200-with-a-warning when the payload is subtly
    // wrong or Work Objects are not enabled on the app — a silent nothing in the channel. Falling
    // back means a workspace without the feature still gets the card it got yesterday.
    try {
      await unfurlSlackEntities(bot.token, target, entities)
      log.info("unfurl sent", {
        team: teamId,
        channel: ev.channel,
        count: entities.length,
        kind: "entity",
      })
    } catch (err) {
      log.warn("work object unfurl refused; falling back to blocks", {
        team: teamId,
        channel: ev.channel,
        err: String(err),
      })
      await unfurlSlackLinks(bot.token, target, unfurls)
      log.info("unfurl sent", {
        team: teamId,
        channel: ev.channel,
        count: Object.keys(unfurls).length,
        kind: "blocks",
      })
    }
  }

  /**
   * The image a Slack card may show for this artifact, or null.
   *
   * Slack fetches preview images anonymously, so the question is never "may this viewer see it"
   * but "may this be fetched with no credential at all" — and the answer, for anything short of
   * world-readable, used to be no. A workspace-listed doc therefore rendered the title-less
   * padlock, which is why the cards people paste most carried no picture.
   *
   * A signed token settles it without loosening `/v1/og` for anyone else: it buys that one
   * version's rendered image, expires, and retires itself on the next publish. The reasoning for
   * why a workspace-listed doc is the right place to draw this line is the product's own —
   * `workspace` means the org may see it, a Slack channel in that org's own workspace is
   * substantially that audience, and anything genuinely sensitive is marked `none`, which never
   * reaches this function.
   *
   * ONE RULE, both visibilities: offer a URL only when a rendered PNG is actually behind it.
   *
   * Renders are enqueued in the BACKGROUND after a publish, so a link pasted moments later finds
   * one pending, and `/v1/og` answers meanwhile with an SVG — the doc's own card for a public
   * artifact, the TITLE-LESS PADLOCK for a workspace one. Offering either is a card that
   * declares `mime_type: "image/png"` and serves something else, and for the workspace case it
   * puts a padlock graphic beside the title we are already showing: exactly what the block card
   * avoided by carrying no image at all.
   *
   * Verified against the API, and the reason this is a check rather than a hope: `chat.unfurl`
   * accepts a `preview_url` WITHOUT fetching it, answering `ok: true` with no warning. Nothing
   * downstream will tell us the picture was wrong. So the card promises an image only when we
   * know there is one, and otherwise says nothing — the fields and title stand on their own.
   */
  const previewUrlFor = async (
    artifact: ArtifactRecord,
    info: UnfurlInfo,
    status: ArtifactStatus,
  ): Promise<string | null> => {
    if (artifact.listed !== "public" && artifact.listed !== "workspace") return null
    if (!status.previewReady) return null
    // A world-readable doc needs no capability: /v1/og already serves its PNG to anyone.
    if (artifact.listed === "public") return info.imageUrl
    if (!deps.encryptionKey) return null
    const token = await signOgToken(
      deps.encryptionKey,
      artifact.id,
      artifact.current_version,
      Date.now() + OG_TOKEN_TTL_MS,
    )
    const u = new URL(info.imageUrl)
    u.searchParams.set("t", token)
    return u.toString()
  }

  /** The Work Object for one decided link. A locked artifact still gets an entity — a title-less
   *  one, exactly as broadcast-safe as the block card it replaces — because the entity is what
   *  makes the card CLICKABLE, and the flexpane behind it is per-viewer. That is how someone
   *  entitled to a private doc finally sees it while the channel still sees nothing. */
  const entityFor = async (
    d: Extract<UnfurlDecision, { kind: "card" | "locked" }>,
    pastedUrl: string,
  ): Promise<unknown> => {
    const iconUrl = new URL("/icon.png", deps.baseUrl).toString()
    if (d.kind === "locked")
      return {
        app_unfurl_url: pastedUrl,
        url: `${deps.baseUrl}/artifacts/${encodeURIComponent(d.artifact.short_id)}`,
        external_ref: { id: d.artifact.short_id, type: DERIVE_ENTITY_TYPE },
        entity_type: "slack#/entities/content_item",
        entity_payload: {
          attributes: {
            title: { text: "A private Derive artifact" },
            display_type: "Private",
            product_name: "Derive",
            product_icon: { url: iconUrl, alt_text: "Derive" },
          },
          fields: {},
        },
      }
    const status = await artifactStatus(meta, d.artifact)
    return artifactEntity({
      pastedUrl,
      artifact: d.artifact,
      info: d.info,
      status,
      // The screenshot. Slack fetches preview images ANONYMOUSLY, so a world-readable artifact
      // links its OG image directly and a workspace-listed one carries a signed, version-pinned
      // token that buys that image and nothing else (lib/og-token.ts). `listed: "none"` never
      // reaches here — decideUnfurl answered it with the locked card above — which is the line
      // this feature deliberately does not cross: a doc someone marked private stays a padlock.
      previewUrl: await previewUrlFor(d.artifact, d.info, status),
      withActions: status.review?.state === "pending",
      iconUrl,
    })
  }

  /** Fill the flexpane for one viewer.
   *
   *  Three answers, and the middle one is the reason Work Objects are worth adopting. An
   *  unlinked viewer is asked to connect — privately, where the old broadcast prompt shouted at
   *  the whole channel. A linked viewer without access is told so plainly, in a panel only they
   *  see, while the card in the channel keeps revealing nothing. And a viewer who may read it
   *  gets the real thing, INCLUDING for an artifact whose broadcast card is deliberately
   *  title-less. Authorization is the same standing-only rule decideUnfurl applies: a link role
   *  is personal to whoever holds the URL and must never be what unlocks a preview.
   */
  const presentEntityDetails = async (teamId: string, ev: SlackEventPayload): Promise<void> => {
    const ref = ev.external_ref?.id
    const trigger = ev.trigger_id
    if (!ref || !trigger || !ev.user) return
    const installs = await meta.listSlackInstallsByTeam(teamId)
    const userLink = await meta.getSlackUserLinkBySlackId(teamId, ev.user)
    const install = installs.find((i) => i.org_id === userLink?.org_id) ?? installs[0]
    if (!install) return
    const bot = await resolveBotToken(meta, install.org_id, deps.encryptionKey)
    if (!bot) return
    const iconUrl = new URL("/icon.png", deps.baseUrl).toString()

    const say = async (
      b: Parameters<typeof presentSlackEntityDetails>[2],
      reason: string,
    ): Promise<void> => {
      try {
        await presentSlackEntityDetails(bot.token, trigger, b)
        log.info("flexpane presented", { team: teamId, ref, outcome: reason })
      } catch (err) {
        log.warn("flexpane failed", { team: teamId, ref, reason, err: String(err) })
      }
    }

    if (!userLink)
      return say(
        { kind: "auth", url: new URL("/v1/slack/link", deps.baseUrl).toString() },
        "not linked",
      )

    let artifact: ArtifactRecord | null = null
    for (const id of candidateShortIds(ref)) {
      artifact = await meta.getByShortId(id)
      if (artifact) break
    }
    if (!artifact || artifact.removed_at || artifact.org_id !== install.org_id)
      return say(
        { kind: "restricted", title: "Not available", message: "This doc no longer exists." },
        "gone",
      )
    if (!(await authorizeUserStanding(userLink.user_id, "read", artifact)))
      return say(
        {
          kind: "restricted",
          title: "No access",
          message: "You don't have access to this doc in Derive. Ask its owner to share it.",
        },
        "no access",
      )

    const info = await unfurlInfoFor(meta, deps.baseUrl, artifact)
    const status = await artifactStatus(meta, artifact)
    return say(
      {
        kind: "details",
        metadata: artifactDetails(
          artifact,
          info,
          status,
          userLink.user_id,
          iconUrl,
          await previewUrlFor(artifact, info, status),
        ),
      },
      "details",
    )
  }

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
      needs_reauth: z
        .boolean()
        .describe(
          "Whether the stored bot token needs a re-auth — a failed auth/scope call, or Slack reporting the app uninstalled or its token revoked",
        ),
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
      // A reconnect keeps the workspace's channel subscriptions (they live in their own table)
      // and its created_at; only the credentials are replaced.
      const existing = await meta.getSlackInstall(state.org)
      await meta.setSlackInstall({
        org_id: state.org,
        team_id: r.teamId,
        team_name: r.teamName,
        bot_token: encryptSecret(r.botToken, deps.encryptionKey),
        bot_user_id: r.botUserId,
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
        // DELIBERATE, so it outranks anything inferred — and this write replaces a `miss`
        // row on the same (team_id, slack_user_id), which is exactly how linking fixes a
        // person the email path could not place.
        origin: "oauth" as const,
        checked_at: new Date().toISOString(),
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
    const raw = await verifiedSlackBody(c)
    if (raw instanceof Response) return raw

    let body: SlackEventEnvelope
    try {
      body = JSON.parse(raw) as SlackEventEnvelope
    } catch {
      return fail(c, 400, "invalid payload")
    }
    if (body.type === "url_verification") return c.json({ challenge: body.challenge })

    const ev = body.event
    // What Slack ACTUALLY sent. Every branch below is conditional on `ev.type`, and every
    // non-match falls through to a bare ok — so an event we don't handle, or one that arrives
    // in a shape a condition rejects, is indistinguishable from an event that never arrived.
    // That cost a long afternoon: link previews were silent, and the only way to ask "is Slack
    // even sending link_shared?" was to reason backwards from the absence of a downstream log.
    // One line makes it a fact. Cheap — Slack events are not high-frequency — and the shape
    // fields are here because a rejected condition is as interesting as an unknown type.
    log.info("slack event", {
      type: body.type,
      event: ev?.type,
      team: body.team_id ?? null,
      channel: ev?.channel ?? null,
      user: ev?.user ?? null,
      links: ev?.links?.length ?? 0,
    })
    // Install lifecycle: the app was removed, or a token was revoked. Flag the affected installs
    // for re-auth and let the Settings banner ask for a reconnect. Flag rather than delete — the
    // members' account links must survive, and a reconnect then restores service without redoing
    // setup. (Channel subscriptions are keyed by org_id in their own table, so they survive
    // either way; it is the install row and its links that deleting would cost.) Slack names the workspace by team_id only, hence the
    // by-team lookup, and one Slack team can back more than one Derive workspace.
    if (
      body.type === "event_callback" &&
      (ev?.type === "app_uninstalled" || ev?.type === "tokens_revoked") &&
      body.team_id
    ) {
      // `tokens_revoked` says WHICH tokens died, and the distinction matters: `oauth` entries are
      // per-user tokens (a member's "Sign in with Slack" grant), which leave the bot working. A
      // member who unlinks — or is deactivated, which revokes it for them — would otherwise raise
      // a workspace-wide "Slack rejected the connection" banner that only a full reconnect
      // clears, and could raise it again at will. Only a `bot` entry naming THIS install's bot
      // means the install is dead; app_uninstalled kills everything unconditionally.
      const revokedBots = ev.type === "tokens_revoked" ? (ev.tokens?.bot ?? []) : null
      if (!revokedBots || revokedBots.length > 0)
        for (const install of await meta.listSlackInstallsByTeam(body.team_id)) {
          // An install predating bot_user_id can't be matched, so flag it rather than miss a
          // genuinely dead token.
          if (revokedBots && install.bot_user_id && !revokedBots.includes(install.bot_user_id))
            continue
          await flagSlackReauth(meta, install.org_id)
        }
      return c.json({ ok: true })
    }
    // Someone clicked a Work Object card, opening the flexpane. THIS is the per-viewer surface
    // chat.unfurl never had: the event names the clicking `user`, so the answer can finally
    // depend on who is asking rather than on the most cautious reader in the channel.
    if (
      body.type === "event_callback" &&
      ev?.type === "entity_details_requested" &&
      body.team_id &&
      ev.user &&
      ev.trigger_id
    ) {
      runAfterAck(presentEntityDetails(body.team_id, ev))
      return c.json({ ok: true })
    }
    // A Derive link was pasted (or is being typed). Render a preview for it. Deferred behind the
    // ack like every other slow path here: resolving each link reads the artifact, its versions
    // and its comments, and Slack still wants a reply inside 3s.
    if (body.type === "event_callback" && ev?.type === "link_shared" && body.team_id && ev.user) {
      runAfterAck(unfurlSharedLinks(body.team_id, ev))
      return c.json({ ok: true })
    }
    // @Derive, anywhere the bot is invited. Deferred behind the ack like every other slow path:
    // a turn takes seconds and Slack wants a reply inside three.
    //
    // Ordered BEFORE the thread-reply branch on purpose: Slack delivers an app_mention as its
    // own event type, and this lane answers with the workspace chat rather than mirroring a
    // comment, so treating it as a plain message would send it down the wrong path.
    if (
      body.type === "event_callback" &&
      ev?.type === "app_mention" &&
      body.team_id &&
      ev.channel &&
      ev.user &&
      ev.text &&
      !ev.bot_id
    ) {
      // Built here rather than injected: this route already holds the whole AppContext, and the
      // turn needs it (the tool surface is constructed per asker). No model on the deploy means
      // no answerer, which is the honest "nothing answers" state rather than a silent failure.
      if (deps.models)
        runAfterAck(
          handleSlackMention(
            {
              meta,
              bus,
              baseUrl: deps.baseUrl,
              models: deps.models,
              encryptionKey: deps.encryptionKey,
              ctx,
              chatAllowlist: deps.chatAllowlist,
              askLimiter: ctx.askLimiter,
            },
            {
              teamId: body.team_id,
              channel: ev.channel,
              ts: ev.ts ?? "",
              threadTs: ev.thread_ts,
              userId: ev.user,
              text: ev.text,
            },
          ),
        )
      return c.json({ ok: true })
    }
    // A DIRECT MESSAGE to the app — the Messages tab, where there is nobody to @mention.
    //
    // Same lane as a mention, deliberately: a DM is the same question asked somewhere more
    // private, so it gets the same gate, the same tools and the same turn. What differs is only
    // that there is no mention to strip and no channel audience, both of which handleSlackMention
    // already copes with (questionFrom leaves un-mentioned text alone, and a DM channel threads
    // the same way).
    //
    // Ordered BEFORE the thread-reply branch because a DM can carry a thread_ts too, and that
    // branch would otherwise try to mirror it as a comment on a document it has nothing to do
    // with. The bot_id and subtype guards are what stop OUR OWN reply arriving back here as a new
    // question, which is how a bot ends up talking to itself for ever.
    if (
      body.type === "event_callback" &&
      ev?.type === "message" &&
      ev.channel_type === "im" &&
      !ev.bot_id &&
      !ev.subtype &&
      body.team_id &&
      ev.channel &&
      ev.user &&
      ev.text
    ) {
      if (deps.models)
        runAfterAck(
          handleSlackMention(
            {
              meta,
              bus,
              baseUrl: deps.baseUrl,
              models: deps.models,
              encryptionKey: deps.encryptionKey,
              ctx,
              chatAllowlist: deps.chatAllowlist,
              askLimiter: ctx.askLimiter,
            },
            {
              teamId: body.team_id,
              channel: ev.channel,
              ts: ev.ts ?? "",
              threadTs: ev.thread_ts,
              userId: ev.user,
              text: ev.text,
            },
          ),
        )
      return c.json({ ok: true })
    }
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

  // ── "Save to Derive" ────────────────────────────────────────────────────────────────────
  // A message shortcut, so it reaches any message in any channel — not only replies under a
  // mirrored card, which is all the reply-back path can see. See lib/slack-capture.ts for why
  // the destination is a comment rather than a new artifact.

  /** The Derive account behind a Slack user, plus the install that vouches for the team. Both
   *  are required: the account is who the comment is authored as, and the install is what binds
   *  the acting Slack team to a Derive workspace, exactly as the button path does. */
  const captureActor = async (payload: SlackInteractionPayload) => {
    const teamId = payload.team?.id
    const slackUserId = payload.user?.id
    if (!teamId || !slackUserId) return null
    const link = await meta.getSlackUserLinkBySlackId(teamId, slackUserId)
    // Verified only: a capture is a comment authored AS this person. An email match is enough to
    // know who they probably are, not enough to write under their name.
    if (!link || !isVerifiedLink(link)) return null
    const install = await meta.getSlackInstall(link.org_id)
    // A workspace that disconnected keeps its members' account links, so re-check the install —
    // without it the shortcut would keep writing into a workspace that cut Slack off.
    if (!install || install.team_id !== teamId) return null
    const [user] = await meta.getUsers([link.user_id])
    return user ? { orgId: link.org_id, user } : null
  }

  const openCaptureModal = async (c: Context, payload: SlackInteractionPayload) => {
    const triggerId = payload.trigger_id
    const msg = payload.message
    if (!triggerId || !msg?.ts || !payload.channel?.id) return c.json({ ok: true })
    const actor = await captureActor(payload)
    // No linked account → still open a modal, but one that asks them to connect. Falling back to
    // the first install for the team is only used to find a bot token to open it WITH; nothing
    // is written on this path.
    const orgForToken =
      actor?.orgId ?? (await meta.listSlackInstallsByTeam(payload.team?.id ?? ""))[0]?.org_id
    if (!orgForToken) return c.json({ ok: true })
    const bot = await resolveBotToken(meta, orgForToken, deps.encryptionKey)
    if (!bot) return c.json({ ok: true })

    const view = actor
      ? captureModal({
          channel: payload.channel.id,
          channelName: payload.channel.name ?? null,
          ts: msg.ts,
          // A message shortcut carries the author's id but not always a name; `username` is
          // present for bot/app messages, so prefer it and only spend a users.info lookup when
          // there is an id to look up.
          author:
            msg.username || (msg.user ? await slackUserName(bot.token, msg.user) : "") || "Someone",
          text: msg.text ?? "",
          permalink: await slackPermalink(bot.token, payload.channel.id, msg.ts),
        })
      : captureLinkPromptModal(deps.baseUrl)
    try {
      await openSlackView(bot.token, triggerId, view)
    } catch {
      // The trigger expired or Slack refused the view. Nothing has been written, and there is
      // no surface left to complain on — a message shortcut has no response_url.
    }
    return c.json({ ok: true })
  }

  /** Typeahead for the modal's artifact picker.
   *
   *  One indexed listArtifacts, not the full-text search behind `/derive <query>`: picking a doc
   *  is a name lookup, and it has to answer on every keystroke inside Slack's 3s. `q` matches on
   *  title through the same visibility gate the list uses, so the picker can only ever offer what
   *  this account may already see. An empty query lists their recent artifacts, which makes the
   *  picker useful before anything is typed at all. */
  const captureSuggestions = async (c: Context, payload: SlackInteractionPayload) => {
    const actor = await captureActor(payload)
    if (!actor) return c.json({ options: [] })
    const q = (payload.value ?? "").trim()
    const rows = await meta.listArtifacts({
      orgId: actor.orgId,
      viewerId: actor.user.id,
      publicOnly: !(await meta.getMembership(actor.orgId, actor.user.id)),
      excludeRemoved: true,
      limit: 20,
      ...(q ? { q } : {}),
    })
    return c.json(captureOptions(rows))
  }

  const submitCapture = async (c: Context, payload: SlackInteractionPayload) => {
    const actor = await captureActor(payload)
    if (!actor) return c.json(captureResultModal("Connect your Derive account and try again."))
    let m: CapturePrivateMeta
    try {
      m = JSON.parse(payload.view?.private_metadata ?? "") as CapturePrivateMeta
    } catch {
      return c.json(captureResultModal("Something went wrong reading that message."))
    }
    const values = payload.view?.state?.values ?? {}
    const artifactId = values[SLACK_CAPTURE_BLOCK]?.[SLACK_CAPTURE_ACTION]?.selected_option?.value
    const note = values[SLACK_CAPTURE_NOTE_BLOCK]?.[SLACK_CAPTURE_NOTE_ACTION]?.value ?? ""
    if (!artifactId) return c.json(captureResultModal("Pick a doc to save this to."))

    const artifact = await meta.getArtifactById(artifactId)
    // The id came out of a modal, so it is client-supplied. Re-resolve it, confine it to the
    // acting install's workspace, and re-check standing: the picker filtered by what they could
    // see when it opened, which is not the same as what they may write to now.
    if (!artifact || artifact.removed_at || artifact.org_id !== actor.orgId)
      return c.json(captureResultModal("That doc isn't available any more."))
    if (!(await authorizeUserStanding(actor.user.id, "comment", artifact)))
      return c.json(captureResultModal("You don't have permission to comment on that doc."))

    const comment = await writeCaptureComment(meta, artifact, m, note, {
      id: actor.user.id,
      name: actor.user.name ?? "Someone",
    })
    // The same fan-out a comment posted in the app runs — bells, webhooks, email. The channel
    // mirror skips it on the Slack origin marker, so saving a message doesn't post it back out.
    await commentCreatedAction(
      { meta, bus, blobs, baseUrl: deps.baseUrl, notify },
      artifact,
      comment,
      { mentions: [], actorId: actor.user.id },
    )
    deps.pokeWebhooks?.()
    const link = commentDeepLink(deps.baseUrl, artifact, comment.thread_id)
    return c.json(
      captureResultModal(`Saved to <${link}|${mrkdwnLabel(artifact.title ?? artifact.short_id)}>.`),
    )
  }

  // Block Kit interactivity: a button on a comment card resolves / reopens that thread. Trust,
  // like reply-back, is by data not a Derive principal — but the target here comes from the
  // (attacker-influenceable) button value, so we bind it three ways: (1) the Slack signature
  // authenticates the request; (2) a slack_thread_link maps threadId→artifact→org; (3) the
  // ACTING Slack team must equal that org's connected install — so one signed workspace can't
  // act on another org's thread by carrying its ids (the events path is immune to this because
  // it keys on Slack-assigned channel+ts, not a value).
  // Deliberately NOT gated on a Derive role: any member of the connected channel can resolve, the
  // same collaboration boundary reply-back already grants for posting — and resolve is reversible.
  // The state flip is applied + fanned out inline (durable before we ack); the cosmetic Slack
  // card update is fired without awaiting, so a slow response_url can't push us past the 3s ack.
  // authz-exempt: Slack signs every request with the signing secret (verifySlackSignature).
  app.post("/v1/slack/interactivity", async (c) => {
    const raw = await verifiedSlackBody(c)
    if (raw instanceof Response) return raw

    // Interactivity is form-encoded: a single `payload` field holding URL-encoded JSON.
    const payloadStr = new URLSearchParams(raw).get("payload")
    if (!payloadStr) return c.json({ ok: true })
    let payload: SlackInteractionPayload
    try {
      payload = JSON.parse(payloadStr) as SlackInteractionPayload
    } catch {
      return fail(c, 400, "invalid payload")
    }

    // "Save to Derive" on a message → open the picker modal. The trigger_id expires in ~3s, so
    // views.open has to be the FIRST thing that happens, and the modal IS the ack: an ephemeral
    // message would need the bot to be in a channel a shortcut can be fired from anywhere.
    if (payload.type === "message_action" && payload.callback_id === SLACK_CAPTURE_CALLBACK)
      return openCaptureModal(c, payload)
    // Each keystroke in that modal's artifact picker.
    if (payload.type === "block_suggestion") return captureSuggestions(c, payload)
    // …and the Save button.
    if (payload.type === "view_submission" && payload.view?.callback_id === SLACK_CAPTURE_CALLBACK)
      return submitCapture(c, payload)

    const action = payload.actions?.[0]
    // A `value` is required by the thread and proposal buttons, which encode their target in
    // one — but NOT by a Work Object action, where Slack round-trips the entity instead and the
    // target is `external_ref`. Requiring it here made every Work Object button a no-op on
    // click: the handler returned ok before reaching the branch that handles them.
    if (payload.type !== "block_actions" || !action?.action_id) return c.json({ ok: true })

    // A Work Object review button. The artifact comes from the card's external_ref rather than a
    // button value — Slack round-trips the entity, so there is no attacker-supplied id to bind.
    if (
      action.action_id === SLACK_REVIEW_ACTION.approve ||
      action.action_id === SLACK_REVIEW_ACTION.sendBack
    ) {
      // Two shapes reach here, because the same two actions now ride three surfaces. A Work
      // Object button carries no value — Slack round-trips the entity, so the target is
      // `external_ref`. A button on a review DM or a channel card has no entity behind it, so
      // the target travels in `value`, exactly as the thread and proposal buttons do. Either
      // way it only NAMES the artifact: runSlackReviewAction re-reads it and re-authorizes the
      // clicker, so neither path is trusted as authorization.
      const ref = payload.entity?.external_ref?.id
      const byValue = action.value ? decodeReviewAction(action.value) : null
      if ((ref || byValue) && payload.team?.id && payload.user?.id) {
        let artifact: ArtifactRecord | null = byValue ? await meta.getArtifactById(byValue) : null
        if (!artifact && ref)
          for (const id of candidateShortIds(ref)) {
            artifact = await meta.getByShortId(id)
            if (artifact) break
          }
        // Bind the acting Slack team to the artifact's workspace, exactly as the thread and
        // proposal branches do: one signed workspace must not act on another org's review.
        const install = artifact ? await meta.getSlackInstall(artifact.org_id) : null
        if (artifact && install && install.team_id === payload.team.id)
          runAfterAck(
            runSlackReviewAction(
              { meta, bus, billingBlocked },
              {
                teamId: payload.team.id,
                slackUserId: payload.user.id,
                artifact,
                op: action.action_id === SLACK_REVIEW_ACTION.approve ? "approve" : "send_back",
                responseUrl: payload.response_url,
              },
            ),
          )
      }
      return c.json({ ok: true })
    }

    // Everything below this point encodes its target in `value` (the Work Object branch above
    // is the one exception, which is why the guard moved off it).
    if (!action.value) return c.json({ ok: true })

    // Proposal Approve / Request-changes — editor-level, authorized AS the clicker's linked
    // Derive account. The work (approving publishes a version) can exceed 3s, so ack now and
    // run it off the ack path; all feedback rides response_url.
    if (
      action.action_id === SLACK_PROPOSAL_ACTION.approve ||
      action.action_id === SLACK_PROPOSAL_ACTION.requestChanges
    ) {
      const pt = decodeProposalAction(action.value)
      if (pt && payload.team?.id && payload.user?.id) {
        runAfterAck(
          runSlackProposalAction(
            { meta, blobs, bus, notify, notifyRender, search, billingBlocked },
            {
              teamId: payload.team.id,
              slackUserId: payload.user.id,
              proposalId: pt.proposalId,
              artifactId: pt.artifactId,
              op:
                action.action_id === SLACK_PROPOSAL_ACTION.approve ? "approve" : "request_changes",
              responseUrl: payload.response_url,
              sectionBlock: payload.message?.blocks?.[0],
            },
          ),
        )
      }
      return c.json({ ok: true })
    }

    const op =
      action.action_id === SLACK_THREAD_ACTION.resolve
        ? "resolved"
        : action.action_id === SLACK_THREAD_ACTION.reopen
          ? "open"
          : undefined
    // Not a thread action we handle (or a malformed value) → ack and ignore.
    if (!op) return c.json({ ok: true })
    const target = decodeThreadAction(action.value)
    if (!target) return c.json({ ok: true })
    const { artifactId, threadId } = target

    // Re-establish trust from data (never the button value alone): the thread link maps this
    // thread to this artifact + org, the acting Slack team owns that org's install, and the
    // org's channel mirror is on. Any miss → ack and no-op (a click that changes nothing).
    // Links are keyed (thread, channel), so resolve the one for the channel this click came
    // from. No channel means no click we can place: Slack sends one on every block_actions in a
    // conversation, and an earlier fallback to "the thread's first link" was a fail-OPEN — a
    // payload omitting the field skipped the channel check entirely.
    const clickedIn = payload.channel?.id
    if (!clickedIn) return c.json({ ok: true })
    const link = await meta.getSlackThreadLink(threadId, clickedIn)
    if (link && link.artifact_id === artifactId) {
      const install = await meta.getSlackInstall(link.org_id)
      const teamOwnsThread = !!install && !!payload.team?.id && install.team_id === payload.team.id
      // …and the workspace still wants this channel. A thread link outlives an unsubscribe, so
      // without this the buttons keep working in a channel an admin deliberately cut off.
      if (teamOwnsThread && (await channelIsSubscribed(meta, link.org_id, clickedIn))) {
        const artifact = await meta.getArtifactById(artifactId)
        if (artifact) {
          const who = payload.user?.username || payload.user?.name || undefined
          // Rewrites the card in EVERY channel this thread is mirrored into, durably, via the
          // outbox — including this one (lib/slack-comments.ts enqueueSlackThreadState).
          await resolveThreadAction(
            { meta, bus, notify, baseUrl: deps.baseUrl },
            artifact,
            threadId,
            op,
            who,
          )
          // …and repaint this channel immediately so the clicker sees the button change now
          // rather than on the next outbox tick. Optimistic: the durable update above is what
          // makes it true, so a slow or failed response_url costs nothing but the instant paint,
          // and must not sit on the ack path (waitUntil on Workers; in-process on Node).
          const section0 = payload.message?.blocks?.[0]
          const blocks = [section0, ...threadStateBlocks(op, action.value, who)].filter(Boolean)
          if (payload.response_url) {
            runAfterAck(
              postSlackResponseUrl(payload.response_url, {
                text: op === "resolved" ? "Thread resolved" : "Thread reopened",
                blocks,
                replace_original: true,
              }),
            )
          }
        }
      }
    }
    return c.json({ ok: true })
  })

  // Slash command: `/derive <query>` searches the invoker's workspace, `/derive` alone lists
  // their recent artifacts. Results are scoped to what the LINKED Derive user can see — an
  // unlinked user is prompted to link first (there's no principal to scope a raw Slack user
  // to). Signature-gated like the other Slack webhooks; the reply is an EPHEMERAL message so
  // only the invoker sees it. The link check + recent-list are single fast queries answered
  // inline; a full-text search can fan out (dense arm + blob greps), so it's acked immediately
  // and delivered via response_url — the same deferral the events/interactivity handlers use to
  // stay under Slack's 3s deadline.
  // authz-exempt: Slack signs every request with the signing secret (verifySlackSignature).
  app.post("/v1/slack/commands", async (c) => {
    const raw = await verifiedSlackBody(c)
    if (raw instanceof Response) return raw

    const form = new URLSearchParams(raw)
    const teamId = form.get("team_id")
    const slackUserId = form.get("user_id")
    const responseUrl = form.get("response_url")
    const text = (form.get("text") ?? "").trim()
    if (!teamId || !slackUserId)
      return c.json({ response_type: "ephemeral", text: "Sorry — malformed command." })

    // `/derive help` is answered BEFORE the account-link gate: it describes the command and
    // reveals nothing about the workspace, and someone who has not linked yet is exactly who
    // needs it. Gating it behind linking would hide the instructions from the only person
    // reading them.
    if (text.trim().toLowerCase() === "help")
      return c.json({ response_type: "ephemeral", blocks: helpBlocks(deps.baseUrl) })

    // Resolve the acting Derive user (and their workspace) from the account link. No link →
    // we can't scope results to them, so prompt them to link rather than leak or over-share.
    const link = await meta.getSlackUserLinkBySlackId(teamId, slackUserId)
    if (!link) return c.json({ response_type: "ephemeral", blocks: notLinkedBlocks(deps.baseUrl) })
    // Disconnecting Slack drops the install but leaves the members' account links, so without
    // this a workspace that explicitly disconnected still answered /derive — and, now that the
    // subcommands write, still accepted changes.
    if (!(await meta.getSlackInstall(link.org_id)))
      return c.json({
        response_type: "ephemeral",
        text: "This workspace isn't connected to Slack any more.",
      })

    // Subscription subcommands, run IN the channel they act on — which is why there is no
    // channel id to type. Managing a channel's subscription is a workspace-admin action, so it
    // is gated on the linked user's membership role rather than on merely being linked.
    const [verb, ...rest] = text.split(/\s+/)
    if (verb === "subscribe" || verb === "unsubscribe" || verb === "settings") {
      const channelId = form.get("channel_id")
      const channelName = form.get("channel_name")
      if (!channelId)
        return c.json({ response_type: "ephemeral", text: "Run this inside a channel." })
      // Verified only, on top of the admin role: changing what Derive posts is workspace
      // configuration. `/derive <query>` below stays open to an email identity — it only
      // searches what that person can already see.
      if (!isVerifiedLink(link))
        return c.json({
          response_type: "ephemeral",
          text: linkToActMessage("change what a channel gets", link),
        })
      const seat = await meta.getMembership(link.org_id, link.user_id)
      if (!seat || !roleAllows(seat.role, "manage"))
        return c.json({
          response_type: "ephemeral",
          text: "Only a workspace admin can change what Derive posts here.",
        })
      if (verb === "unsubscribe") {
        await meta.deleteSlackSubscriptionsByChannel(link.org_id, channelId)
        return c.json({ response_type: "ephemeral", text: "Done — Derive won't post here." })
      }
      if (verb === "settings") {
        const subs = (await meta.listSlackSubscriptions(link.org_id)).filter(
          (x) => x.channel_id === channelId,
        )
        // Resolve titles so the card can name the collection rather than print `col_9f2ac1`.
        // Only when something here is actually scoped — most channels take the whole workspace.
        const titles = new Map<string, string>()
        if (subs.some((x) => x.scope_kind === "collection"))
          for (const col of await meta.listCollections(link.org_id)) titles.set(col.id, col.title)
        return c.json({
          response_type: "ephemeral",
          blocks: subscriptionBlocks(
            deps.baseUrl,
            subs.map((x) => ({ ...x, scope_title: titles.get(x.scope_id) ?? null })),
          ),
        })
      }
      // A private channel the app was never invited to accepts the subscription and then drops
      // every delivery into the dead-letter queue, with nothing anywhere saying why. The bot can
      // self-join a PUBLIC channel on its first post (postWithRecovery autoJoin), so only the
      // unreachable case is worth stopping, and only when Slack actually answered.
      const bot = await resolveBotToken(meta, link.org_id, deps.encryptionKey)
      const reach = bot ? await slackChannelReach(bot.token, channelId) : null
      if (reach && !reach.reachable)
        return c.json({
          response_type: "ephemeral",
          text: "Invite me to this channel first — `/invite @Derive` — then run `/derive subscribe` again. I can't post in a private channel I'm not a member of.",
        })
      // `/derive subscribe [collection name]` — the collection is matched by name so nobody has
      // to know an id; omit it to subscribe the whole workspace.
      const wanted = rest.join(" ").trim()
      let collection: { id: string; title: string } | null = null
      if (wanted) {
        const all = await meta.listCollections(link.org_id)
        const hit = all.find((x) => x.title.toLowerCase() === wanted.toLowerCase())
        if (!hit)
          return c.json({
            response_type: "ephemeral",
            text: `No collection called "${wanted}" in this workspace.`,
          })
        collection = { id: hit.id, title: hit.title }
      }
      // Re-running `/derive subscribe` on an already-subscribed target must not quietly reset
      // its events, author filter and paused state back to the defaults — the upsert would.
      const scopeId = collection?.id ?? ""
      const existing = (await meta.listSlackSubscriptions(link.org_id)).find(
        (x) => x.channel_id === channelId && x.scope_id === scopeId,
      )
      if (existing)
        return c.json({
          response_type: "ephemeral",
          text: "This channel is already subscribed — `/derive settings` shows what it gets.",
        })
      await meta.upsertSlackSubscription({
        id: newId("sub"),
        org_id: link.org_id,
        channel_id: channelId,
        channel_name: channelName ?? null,
        scope_kind: collection ? "collection" : "workspace",
        scope_id: scopeId,
        created_by: link.user_id,
      })
      return c.json({
        response_type: "ephemeral",
        text: collection
          ? `Subscribed this channel to *${collection.title}*.`
          : "Subscribed this channel to the whole workspace.",
      })
    }

    const publicOnly = !(await meta.getMembership(link.org_id, link.user_id))
    // Bare /derive: one indexed listArtifacts query — fast enough to answer inline.
    if (!text) {
      const recent = await meta.listArtifacts({
        orgId: link.org_id,
        viewerId: link.user_id,
        publicOnly,
        excludeRemoved: true,
        limit: 8,
      })
      return c.json({
        response_type: "ephemeral",
        blocks: deriveRecentBlocks(deps.baseUrl, recent),
      })
    }

    const runSearch = async (): Promise<unknown[]> => {
      const { results } = await searchWorkspace(
        { blobs, sourceText, meta, search },
        {
          orgId: link.org_id,
          viewerId: link.user_id,
          publicOnly,
          query: text,
          re: searchMatcher(text, false),
          where: "text",
          ctxLines: 1,
          cap: 5,
          limit: 8,
          // Clamp the nomination so the visibility re-resolve is a single chunked query, not
          // three (mirrors the typeahead path) — keeps the deferred work cheap.
          candidateCap: 60,
        },
      )
      return deriveResultsBlocks(deps.baseUrl, text, toSearchHits(results, text))
    }

    // Search off the ack path: ack "Searching…" now, deliver the result to response_url when
    // ready (waitUntil on Workers; in-process on Node). Fall back to inline if — unexpectedly
    // for a slash command — there's no response_url.
    if (!responseUrl) return c.json({ response_type: "ephemeral", blocks: await runSearch() })
    const deliver = runSearch()
      .then((blocks) =>
        postSlackResponseUrl(responseUrl, { text: "Results", blocks, replace_original: true }),
      )
      .catch(() =>
        postSlackResponseUrl(responseUrl, {
          text: "Sorry — the search failed. Try again.",
          replace_original: true,
        }),
      )
    runAfterAck(deliver)
    return c.json({ response_type: "ephemeral", text: "Searching…" })
  })

  // Connection status for the Settings UI: whether Slack is configured at all, whether this
  // workspace has connected one, its team name, and whether the token needs a re-auth. Where
  // Derive posts is no longer part of the connection — that is one slack_subscription row per
  // channel, read from GET /v1/slack/subscriptions.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/slack",
      tags: ["Slack"],
      summary: "Slack connection status for the signed-in user's workspace.",
      responses: {
        200: {
          description: "Whether Slack is available + connected, the team name, and re-auth state.",
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

  // ---- Channel subscriptions -------------------------------------------------------------
  // Which channels hear about what. Replaces the single default channel; modelled on
  // routes/webhooks.ts, which is the house shape for workspace-scoped list CRUD.
  const SlackSubscription = z
    .object({
      id: z.string(),
      channel_id: z.string().describe("Slack channel id, e.g. C0123ABC456"),
      channel_name: z
        .string()
        .nullable()
        .describe("The channel's #name for display, or null if unknown"),
      scope_kind: z
        .enum(["workspace", "collection"])
        .describe("Whether this covers the whole workspace or one collection"),
      scope_id: z
        .string()
        .describe('The collection id when scope_kind is "collection"; empty for a workspace scope'),
      scope_title: z
        .string()
        .nullable()
        .describe(
          "The scoped collection's title, resolved for display. Null for a workspace scope, and also when the collection has been deleted — the subscription then matches nothing, and saying so is more useful than a bare id.",
        ),
      events: z.string().describe('Comma-separated event types to deliver, or "*" for all events'),
      authors: z
        .enum(["all", "human", "agent"])
        .describe("Whose activity reaches this channel: everyone, only people, or only agents"),
      active: z
        .union([z.literal(0), z.literal(1)])
        .describe("Whether deliveries are enabled (1) or paused (0)"),
      created_at: z.string(),
    })
    .openapi("SlackSubscription")

  /** The response shape, which deliberately omits `created_by` — the declared schema has no such
   *  field, and an internal user id has no business on a config row the client only displays. */
  const publicSubscription = <T extends { created_by: string | null }>({
    created_by: _c,
    ...rest
  }: T): Omit<T, "created_by"> => rest

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/slack/subscriptions",
      tags: ["Slack"],
      summary: "List the workspace's Slack channel subscriptions (Admin only).",
      responses: {
        200: {
          description:
            "The workspace's subscriptions, plus the event types one can carry — the server is the source of that list so the client can't drift from it.",
          content: {
            "application/json": {
              schema: z.object({
                subscriptions: z.array(SlackSubscription),
                event_options: z.array(z.enum(SLACK_SUBSCRIBABLE_EVENTS)),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const subs = await meta.listSlackSubscriptions(org)
      // Resolve collection titles so a scoped row can NAME its collection. Without this the UI
      // can only render the scope_kind, and two collection subscriptions on one channel are
      // indistinguishable — you cannot tell which one you are about to remove. One extra query,
      // and only when something is actually scoped.
      const titles = new Map<string, string>()
      if (subs.some((x) => x.scope_kind === "collection"))
        for (const col of await meta.listCollections(org)) titles.set(col.id, col.title)
      return c.json({
        subscriptions: subs.map((x) => ({
          ...publicSubscription(x),
          scope_title: x.scope_kind === "collection" ? (titles.get(x.scope_id) ?? null) : null,
        })),
        event_options: [...SLACK_SUBSCRIBABLE_EVENTS],
      })
    },
  )

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/slack/subscriptions",
      tags: ["Slack"],
      summary: "Subscribe a channel to workspace activity (Admin only).",
      responses: {
        201: {
          description: "The created (or updated) subscription.",
          content: { "application/json": { schema: SlackSubscription } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const b = await readJson(
        c,
        z.object({
          channel_id: z.string(),
          channel_name: z.string().optional(),
          collection: z.string().optional(),
          events: z.array(z.string()).optional(),
          authors: z.enum(["all", "human", "agent"]).optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      const channelId = b.channel_id.trim()
      // A Slack conversation id, not a #name. Storing "#general" would make every threading
      // lookup miss forever — the link is written with the id Slack echoes back — so each
      // comment would post a new top-level message instead of threading under the last.
      if (!/^[CGD][A-Z0-9]{6,}$/.test(channelId))
        return bail(fail(c, 400, "channel_id must be a Slack channel id like C0123ABC456"))
      // A collection scope must name a collection in THIS workspace.
      let scopeTitle: string | null = null
      if (b.collection) {
        const col = await meta.getCollection(b.collection)
        if (!col || col.org_id !== org) return bail(fail(c, 404, "collection not found"))
        scopeTitle = col.title
      }
      const me = await requireUser(c)
      const created = await meta.upsertSlackSubscription({
        id: newId("sub"),
        org_id: org,
        channel_id: channelId,
        channel_name: b.channel_name ?? null,
        scope_kind: b.collection ? "collection" : "workspace",
        scope_id: b.collection ?? "",
        events: subscribableEvents(b.events),
        authors: b.authors ?? "all",
        created_by: me instanceof Response ? null : me.id,
      })
      return c.json({ ...publicSubscription(created), scope_title: scopeTitle }, 201)
    },
  )

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/slack/subscriptions/{id}",
      tags: ["Slack"],
      summary: "Update a channel subscription (Admin only).",
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: "The updated subscription.",
          content: { "application/json": { schema: SlackSubscription } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const b = await readJson(
        c,
        z.object({
          events: z.array(z.string()).optional(),
          authors: z.enum(["all", "human", "agent"]).optional(),
          active: z.boolean().optional(),
        }),
      )
      if (b instanceof Response) return bail(b)
      const updated = await meta.updateSlackSubscription(c.req.param("id"), org, {
        ...(b.events ? { events: subscribableEvents(b.events) } : {}),
        ...(b.authors ? { authors: b.authors } : {}),
        ...(b.active === undefined ? {} : { active: b.active ? (1 as const) : (0 as const) }),
      })
      if (!updated) return bail(fail(c, 404, "subscription not found"))
      // PATCH cannot move a subscription between scopes, but the response must still carry
      // scope_title or a client that re-renders from it would drop the collection's name.
      const scoped =
        updated.scope_kind === "collection" ? await meta.getCollection(updated.scope_id) : null
      return c.json({ ...publicSubscription(updated), scope_title: scoped?.title ?? null })
    },
  )

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/slack/subscriptions/{id}",
      tags: ["Slack"],
      summary: "Remove a channel subscription (Admin only).",
      request: { params: z.object({ id: z.string() }) },
      responses: { 204: { description: "The subscription was removed." } },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      await meta.deleteSlackSubscription(c.req.param("id"), org)
      return c.body(null, 204)
    },
  )

  // The channels the bot can see, so the picker never asks anyone to paste a raw id.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/slack/channels",
      tags: ["Slack"],
      summary: "List public Slack channels for the subscription picker (Admin only).",
      responses: {
        200: {
          description: "Public channels in the connected workspace.",
          content: {
            "application/json": {
              schema: z.object({
                channels: z.array(z.object({ id: z.string(), name: z.string() })),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const bot = await resolveBotToken(meta, org, deps.encryptionKey)
      if (!bot) return bail(fail(c, 404, "Slack is not connected"))
      try {
        return c.json({ channels: await listSlackChannels(bot.token) })
      } catch (err) {
        log.warn("slack channel list failed", { error: String(err) })
        return bail(fail(c, 502, "could not list Slack channels"))
      }
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
  /** The Slack workspace the event came from. The only workspace identifier on an
   *  app_uninstalled / tokens_revoked event — those carry no channel to key on. */
  team_id?: string
  event?: SlackEventPayload
}

/** The `event` object of an Events API envelope — only the fields the handlers below read. */
interface SlackEventPayload {
  type?: string
  subtype?: string
  bot_id?: string
  /** "im" for a direct message to the app. Absent on channel messages. */
  channel_type?: string
  user?: string
  text?: string
  channel?: string
  ts?: string
  thread_ts?: string
  /** On `tokens_revoked` only: which token classes were revoked, as arrays of user ids.
   *  `oauth` = per-user tokens (a member's "Sign in with Slack" grant); `bot` = the bot's own,
   *  the only class that invalidates the install. Either key may be absent. */
  tokens?: { oauth?: string[]; bot?: string[] }
  /** On `entity_details_requested` only: which Work Object was clicked, and the one-shot token
   *  that authorizes filling its flexpane. `external_ref` is the pair we set on the entity, so
   *  `id` is the artifact's stable short id. */
  external_ref?: { id?: string; type?: string }
  trigger_id?: string
  /** On `link_shared` only. `message_ts` + `channel` locate a posted message; `unfurl_id` +
   *  `source` are the alternative handle Slack gives for a link still in the composer.
   *  `is_bot_user_member` says whether the bot is actually in that channel — the event fires
   *  workspace-wide regardless. */
  links?: { url: string; domain?: string }[]
  is_bot_user_member?: boolean
  message_ts?: string
  unfurl_id?: string
  source?: string
}

/** The Block Kit interactivity payload (the JSON inside the form's `payload` field). Only the
 *  fields the thread-action handler reads; `message.blocks` is the original card, reused so
 *  the resolved/reopened card keeps its comment section. */
interface SlackInteractionPayload {
  type?: string
  response_url?: string
  /** The workspace the click came from; bound to the thread's org install for authz. */
  team?: { id?: string }
  /** The conversation the click came from — which of a thread's mirrored messages it was.
   *  `name` only arrives on a message shortcut, where it is the channel the message lives in. */
  channel?: { id?: string; name?: string }
  user?: { id?: string; username?: string; name?: string }
  actions?: Array<{ action_id?: string; value?: string }>
  message?: { blocks?: unknown[]; text?: string; ts?: string; user?: string; username?: string }
  /** message_action only: which shortcut fired, and the token that lets us open a modal. */
  callback_id?: string
  trigger_id?: string
  /** block_suggestion only: what has been typed into the select so far. */
  value?: string
  action_id?: string
  /** Present on a Work Object action: the entity whose button was pressed. Slack round-trips
   *  what we set, so `external_ref.id` is our own short id coming home. */
  entity?: { external_ref?: { id?: string; type?: string } }
  /** view_submission / block_suggestion: the modal the interaction came from. */
  view?: {
    callback_id?: string
    private_metadata?: string
    state?: {
      values?: Record<
        string,
        Record<string, { value?: string; selected_option?: { value?: string } }>
      >
    }
  }
}
