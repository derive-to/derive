// Slack Web API client + request-signature verification for the connected Slack App.
// Thin fetch wrappers (no SDK): OAuth code exchange, chat.postMessage (with threading),
// users.info, and the inbound Events API signature check. The outbound delivery sender
// and the per-comment fan-out live in slack-comments.ts; the OAuth + events routes in
// routes/slack.ts.

import { createHmac, timingSafeEqual } from "node:crypto"

const API = "https://slack.com/api"

/** Verify an inbound Slack request: `v0=HMAC(signingSecret, "v0:{ts}:{body}")`, with a
 *  5-minute timestamp window to bound replay. Constant-time compare. */
export const verifySlackSignature = (
  signingSecret: string,
  timestamp: string | undefined,
  body: string,
  signature: string | undefined,
  nowMs = Date.now(),
): boolean => {
  if (!timestamp || !signature) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > 300) return false
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface SlackOAuthResult {
  botToken: string
  teamId: string
  teamName: string | null
  botUserId: string | null
}

/** Exchange an OAuth `code` for a bot token via oauth.v2.access. */
export const exchangeSlackOAuth = async (
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<SlackOAuthResult> => {
  const res = await fetch(`${API}/oauth.v2.access`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  })
  const data = (await res.json()) as {
    ok: boolean
    error?: string
    access_token?: string
    bot_user_id?: string
    team?: { id?: string; name?: string }
  }
  if (!data.ok || !data.access_token)
    throw new Error(`slack oauth failed: ${data.error ?? "unknown"}`)
  return {
    botToken: data.access_token,
    teamId: data.team?.id ?? "",
    teamName: data.team?.name ?? null,
    botUserId: data.bot_user_id ?? null,
  }
}

/** The "Sign in with Slack" (OIDC) authorize URL for the per-user account-link flow. Distinct
 *  from the bot install (`slackAuthorizeUrl`): Slack rejects mixing `openid` scopes with bot
 *  scopes in one call, so linking a personal identity is its own lightweight flow. `nonce` is
 *  required by OIDC; we read identity from the back-channel userinfo, so the signed `state`
 *  (not the id_token) is what binds the callback to the Derive user who started it. */
export const slackOidcAuthorizeUrl = (
  clientId: string,
  redirectUri: string,
  state: string,
  nonce: string,
  team?: string,
): string => {
  const u = new URL("https://slack.com/openid/connect/authorize")
  u.searchParams.set("response_type", "code")
  u.searchParams.set("scope", "openid profile email")
  u.searchParams.set("client_id", clientId)
  u.searchParams.set("redirect_uri", redirectUri)
  u.searchParams.set("state", state)
  u.searchParams.set("nonce", nonce)
  // Pre-select the connected workspace so the user links the identity for the right team.
  if (team) u.searchParams.set("team", team)
  return u.toString()
}

/** Exchange an OIDC `code` for an access token (openid.connect.token). Back-channel: we
 *  authenticate with the client secret over TLS, so the token response is trusted. */
export const exchangeSlackOidc = async (
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string }> => {
  const res = await fetch(`${API}/openid.connect.token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  })
  const data = (await res.json()) as { ok?: boolean; error?: string; access_token?: string }
  if (!data.access_token) throw new Error(`slack oidc token failed: ${data.error ?? "unknown"}`)
  return { accessToken: data.access_token }
}

/** The linked Slack identity (openid.connect.userInfo). The identifying claims are namespaced
 *  URL keys (`https://slack.com/user_id`, `.../team_id`) — read them literally. These are the
 *  same `U…`/`T…` ids the bot sees in events, which is what makes the link resolvable.
 *
 *  The method name is camelCase — `userInfo`, NOT `userinfo`. Slack's Web API method names are
 *  case-sensitive, and the all-lowercase spelling this used to send returns `unknown_method`,
 *  so account linking failed for every user from the day it shipped: the authorize and token
 *  exchange both succeed, and only this last hop fails, which is why it read as an app-config
 *  problem rather than a typo. Verified against the live API — `userinfo` → `unknown_method`,
 *  `userInfo` → `invalid_auth` (i.e. the method exists and only the credential was rejected). */
export const slackOidcUserinfo = async (
  accessToken: string,
): Promise<{ slackUserId: string; teamId: string; email: string | null }> => {
  const res = await fetch(`${API}/openid.connect.userInfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  const data = (await res.json()) as {
    error?: string
    "https://slack.com/user_id"?: string
    "https://slack.com/team_id"?: string
    email?: string
  }
  const slackUserId = data["https://slack.com/user_id"]
  const teamId = data["https://slack.com/team_id"]
  if (!slackUserId || !teamId)
    throw new Error(`slack oidc userinfo failed: ${data.error ?? "no identity"}`)
  return { slackUserId, teamId, email: data.email ?? null }
}

export interface SlackPostResult {
  ts: string
  channel: string
}

/** A Slack API error carrying the `error` code (e.g. "channel_not_found", "not_in_channel")
 *  so the delivery sender can recover (auto-join) or dead-letter permanent failures. */
export class SlackApiError extends Error {
  constructor(public code: string) {
    super(`slack: ${code}`)
  }
}

/** Slack error codes that can never succeed on retry — dead-letter immediately. */
const SLACK_PERMANENT = new Set([
  "channel_not_found",
  "is_archived",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "no_permission",
  "not_authed",
  "msg_too_long",
  "restricted_action",
])
export const isPermanentSlackError = (code: string): boolean => SLACK_PERMANENT.has(code)

/** Slack errors that mean the stored bot token needs re-authorizing (revoked, wrong auth,
 *  or a scope the app now needs but this install never granted). The workspace's install is
 *  flagged `needs_reauth` so the Settings UI prompts a reconnect. */
const SLACK_AUTH_ERRORS = new Set([
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "not_authed",
  "missing_scope",
])
export const isSlackAuthError = (code: string): boolean => SLACK_AUTH_ERRORS.has(code)

/** Post a message via chat.postMessage. `threadTs` threads it under an existing message.
 *  Throws SlackApiError(code) on a Slack-level failure. */
export const postSlackMessage = async (
  token: string,
  args: { channel: string; text: string; blocks?: unknown; threadTs?: string },
): Promise<SlackPostResult> => {
  const res = await fetch(`${API}/chat.postMessage`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: args.channel,
      text: args.text,
      // The bot's own posts already render the artifact as a card, so don't let Slack
      // ALSO unfurl a link in the text — that repeats the same card right below it.
      // (Links a person pastes still unfurl, via the separate link_shared → chat.unfurl.)
      unfurl_links: false,
      unfurl_media: false,
      ...(args.blocks ? { blocks: args.blocks } : {}),
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    }),
  })
  const data = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string }
  if (!data.ok || !data.ts) throw new SlackApiError(data.error ?? "unknown")
  return { ts: data.ts, channel: data.channel ?? args.channel }
}

/** Update the message an interaction came from, via its `response_url` (a signed URL valid
 *  ~30 min, no token needed). `replace_original` swaps the whole message. Best-effort +
 *  time-bounded: the interactivity ack must return well under Slack's 3s, and the action it
 *  reflects has already been applied, so a slow/failed cosmetic update must not block. */
export const postSlackResponseUrl = async (
  responseUrl: string,
  body: {
    text: string
    blocks?: unknown
    replace_original?: boolean
    response_type?: "ephemeral" | "in_channel"
  },
): Promise<boolean> => {
  try {
    const res = await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2500),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Join a public channel so the bot can post to it (best-effort; private channels must
 *  invite the bot manually). Returns true on success. */
export const joinSlackChannel = async (token: string, channel: string): Promise<boolean> => {
  try {
    const res = await fetch(`${API}/conversations.join`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel }),
    })
    return ((await res.json()) as { ok: boolean }).ok
  } catch {
    return false
  }
}

/** A Slack user's display name (best-effort; falls back to the raw id on any error). */
export const slackUserName = async (token: string, userId: string): Promise<string> => {
  try {
    const res = await fetch(`${API}/users.info?user=${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const data = (await res.json()) as {
      ok: boolean
      user?: { real_name?: string; name?: string; profile?: { display_name?: string } }
    }
    return data.user?.profile?.display_name || data.user?.real_name || data.user?.name || userId
  } catch {
    return userId
  }
}

/** Resolve a Slack user id for an email within the connected workspace, via
 *  users.lookupByEmail. Returns null when no Slack account has that email (a normal,
 *  expected outcome — most Derive users won't share an email with a Slack account, so the
 *  caller no-ops rather than treating it as a failure). Throws on anything else (auth,
 *  scope, rate limit) so the caller can classify + flag re-auth like every other Slack call.
 *  No per-user linking step: this is a live lookup against the one bot token per call. */
export const resolveSlackUserIdByEmail = async (
  token: string,
  email: string,
): Promise<string | null> => {
  const res = await fetch(`${API}/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  const data = (await res.json()) as { ok: boolean; error?: string; user?: { id?: string } }
  if (data.ok) return data.user?.id ?? null
  if (data.error === "users_not_found") return null
  throw new SlackApiError(data.error ?? "unknown")
}

/** Open (or fetch) the DM channel with a Slack user. Returns the IM channel id. Throws
 *  SlackApiError on a Slack-level failure (e.g. missing im:write scope). */
export const openSlackDm = async (token: string, userId: string): Promise<string> => {
  const res = await fetch(`${API}/conversations.open`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ users: userId }),
  })
  const data = (await res.json()) as { ok: boolean; error?: string; channel?: { id?: string } }
  if (!data.ok || !data.channel?.id) throw new SlackApiError(data.error ?? "unknown")
  return data.channel.id
}

/** Bot scopes requested at install — the single source of truth, also what the manifest
 *  declares (see slack-app-setup buildSlackManifest). Covers posting the comment mirror +
 *  event cards (chat/channels), reading channel history so a thread reply can flow back in
 *  (channels:* for public, groups:* for private channels the bot is invited to — matching
 *  the message.channels + message.groups event subscriptions), and DMing a mentioned user
 *  resolved by email (users:read.email, im:write) — no per-user OAuth.
 *
 *  Re-auth on scope drift is only automatic for scopes an OUTBOUND call needs: a stale
 *  install hits `missing_scope`, which flags needs_reauth and shows the reconnect banner.
 *  Event-delivery scopes (groups:*) are different — Slack simply stops delivering the events
 *  to a token that lacks them, so Derive makes no failing call and nothing flags the drift.
 *  Existing installs must reconnect by hand to get private-channel reply-back; there is no
 *  automatic prompt (a real scope-drift detector is future work). */
export const SLACK_BOT_SCOPES = [
  "chat:write",
  // Required by the /derive slash command. Without it Slack rejects the whole manifest
  // ("Slash Commands requires `commands` bot scope"), so the app could not be created at
  // all — the command has shipped since #454, but this scope never accompanied it.
  "commands",
  "channels:read",
  "channels:join",
  "channels:history",
  "groups:read",
  "groups:history",
  "users:read",
  "users:read.email",
  // Outbound DMs only (mentions, review requests, shares). Reading DMs would need
  // im:history, which we deliberately do NOT request — see the bot_events note in
  // slack-app-setup.ts.
  "im:write",
]

/** The OAuth authorize URL for the "Add to Slack" button. */
export const slackAuthorizeUrl = (clientId: string, redirectUri: string, state: string): string => {
  const u = new URL("https://slack.com/oauth/v2/authorize")
  u.searchParams.set("client_id", clientId)
  u.searchParams.set("scope", SLACK_BOT_SCOPES.join(","))
  u.searchParams.set("redirect_uri", redirectUri)
  u.searchParams.set("state", state)
  return u.toString()
}
