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
  /** Comma-separated scopes actually granted to the bot token (from the OAuth response). */
  scopes: string | null
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
    scope?: string
    team?: { id?: string; name?: string }
  }
  if (!data.ok || !data.access_token)
    throw new Error(`slack oauth failed: ${data.error ?? "unknown"}`)
  return {
    botToken: data.access_token,
    teamId: data.team?.id ?? "",
    teamName: data.team?.name ?? null,
    botUserId: data.bot_user_id ?? null,
    scopes: data.scope ?? null,
  }
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
      ...(args.blocks ? { blocks: args.blocks } : {}),
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    }),
  })
  const data = (await res.json()) as { ok: boolean; error?: string; ts?: string; channel?: string }
  if (!data.ok || !data.ts) throw new SlackApiError(data.error ?? "unknown")
  return { ts: data.ts, channel: data.channel ?? args.channel }
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

/** Open (or fetch) the DM channel with a Slack user, for a bot DM. Returns the IM channel
 *  id. Throws SlackApiError on a Slack-level failure (e.g. missing im:write scope). */
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

/** Reply to an interactive action with an ephemeral message (only the clicking user sees
 *  it), by POSTing to the `response_url` Slack included in the payload. Best-effort. */
export const respondEphemeral = async (responseUrl: string, text: string): Promise<void> => {
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
    })
  } catch {
    // The action was still acknowledged (200) — a failed ephemeral reply is non-fatal.
  }
}

/** Replace the original message a button lived on (visible to the whole channel), via the
 *  interaction's `response_url` — used to swap an action card's buttons for a result line
 *  after the action ran. No bot token needed. Best-effort. */
export const replaceOriginal = async (
  responseUrl: string,
  text: string,
  blocks?: unknown,
): Promise<void> => {
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replace_original: true, text, ...(blocks ? { blocks } : {}) }),
    })
  } catch {
    // Non-fatal — the action already ran; only the message cosmetics failed to update.
  }
}

/** Attach rich previews to shared derive.to links in a message (link unfurls). `unfurls`
 *  maps each shared URL to its Block Kit blocks. Best-effort: a Slack-level failure just
 *  leaves the link as a plain URL, so this never throws. */
export const unfurlSlackLink = async (
  token: string,
  args: { channel: string; ts: string; unfurls: Record<string, { blocks: unknown }> },
): Promise<void> => {
  try {
    await fetch(`${API}/chat.unfurl`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: args.channel, ts: args.ts, unfurls: args.unfurls }),
    })
  } catch {
    // Unfurling is decorative; a failure leaves the plain link.
  }
}

/** Publish a user's App Home tab view (views.publish). Best-effort — a failure leaves the
 *  tab showing its previous state, never an error to the user. */
export const publishSlackHomeView = async (
  token: string,
  userId: string,
  view: unknown,
): Promise<void> => {
  try {
    await fetch(`${API}/views.publish`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ user_id: userId, view }),
    })
  } catch {
    // A failed home publish is non-fatal.
  }
}

/** Bot scopes requested at install. Covers posting + reply-back, plus reading user emails
 *  (email↔member matching) and opening DMs (per-user notifications) for later features —
 *  requesting them now means a workspace won't have to reconnect when those land. */
export const SLACK_BOT_SCOPES = [
  "chat:write",
  "channels:read",
  "channels:join",
  "channels:history",
  "users:read",
  "users:read.email",
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

/** "Sign in with Slack" (OpenID Connect) authorize URL for account linking. Uses USER
 *  scopes (openid/email/profile), separate from the bot install — it only proves which
 *  Slack user the signed-in Derive user is. `teamId` pins the picker to the connected
 *  workspace so a user can't link an identity from a different team. */
export const slackOpenIdAuthorizeUrl = (
  clientId: string,
  redirectUri: string,
  state: string,
  teamId?: string,
): string => {
  const u = new URL("https://slack.com/openid/connect/authorize")
  u.searchParams.set("response_type", "code")
  u.searchParams.set("scope", "openid email profile")
  u.searchParams.set("client_id", clientId)
  u.searchParams.set("redirect_uri", redirectUri)
  u.searchParams.set("state", state)
  if (teamId) u.searchParams.set("team", teamId)
  return u.toString()
}

export interface SlackOpenIdResult {
  slackUserId: string
  teamId: string
  email: string | null
}

/** Exchange an OpenID Connect `code` for the linking user's Slack identity (user id + team
 *  + email), via openid.connect.token then openid.connect.userInfo. */
export const exchangeSlackOpenId = async (
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<SlackOpenIdResult> => {
  const tokenRes = await fetch(`${API}/openid.connect.token`, {
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
  const token = (await tokenRes.json()) as { ok: boolean; error?: string; access_token?: string }
  if (!token.ok || !token.access_token)
    throw new Error(`slack openid failed: ${token.error ?? "unknown"}`)

  const infoRes = await fetch(`${API}/openid.connect.userInfo`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  })
  const info = (await infoRes.json()) as {
    ok: boolean
    error?: string
    email?: string
    "https://slack.com/user_id"?: string
    "https://slack.com/team_id"?: string
  }
  const slackUserId = info["https://slack.com/user_id"]
  const teamId = info["https://slack.com/team_id"]
  if (!info.ok || !slackUserId || !teamId)
    throw new Error(`slack userinfo failed: ${info.error ?? "unknown"}`)
  return { slackUserId, teamId, email: info.email ?? null }
}
