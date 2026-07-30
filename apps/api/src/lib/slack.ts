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
      // ALSO unfurl a link in the text — that repeats the same card right below it. Belt and
      // braces: Slack does not dispatch `link_shared` for a message posted by an app either,
      // so our own cards can't round-trip through the unfurl handler (lib/slack-unfurl.ts).
      // A link a PERSON pastes is the case that handler exists for.
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

/** Where an unfurl attaches. Slack accepts either the message coordinates (`channel` + `ts`) or
 *  the opaque pair from the event (`unfurl_id` + `source`); `source` is "composer" when the link
 *  is still being typed and "conversations_history" once posted. The two forms are mutually
 *  exclusive, so pass through whichever the event gave us. */
export interface SlackUnfurlTarget {
  channel?: string
  ts?: string
  unfurlId?: string
  source?: string
}

/** Attach unfurl cards to the links in a message (chat.unfurl).
 *
 *  `unfurls` maps each URL to its card. There is deliberately NO per-viewer variant: Slack
 *  renders one unfurl for the message and everyone in the channel sees it, which is why the
 *  caller gates on "may this be broadcast" rather than "may this viewer read it".
 *
 *  `auth` switches to the sign-in prompt instead: Slack shows an ephemeral message — to the
 *  person who POSTED the link, not to viewers — inviting them to connect their account, with
 *  built-in "Not now" / "Never ask me again" buttons. Sent with no cards, since we have nothing
 *  to show until they link. */
export const unfurlSlackLinks = async (
  token: string,
  target: SlackUnfurlTarget,
  unfurls: Record<string, unknown>,
  auth?: { url: string; message: string },
): Promise<void> => {
  const res = await fetch(`${API}/chat.unfurl`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      ...(target.channel && target.ts
        ? { channel: target.channel, ts: target.ts }
        : { unfurl_id: target.unfurlId, source: target.source }),
      unfurls: auth ? {} : unfurls,
      ...(auth
        ? { user_auth_required: true, user_auth_url: auth.url, user_auth_message: auth.message }
        : {}),
    }),
  })
  const data = (await res.json()) as { ok: boolean; error?: string }
  if (!data.ok) throw new SlackApiError(data.error ?? "unknown")
}

/** The public channels the bot can see, for the subscription picker — so nobody has to paste a
 *  raw channel id. Paginated; capped rather than exhaustive, because a picker only needs enough
 *  to choose from and a huge workspace would otherwise page for a long time. This is what
 *  `channels:read` is for. */
export const listSlackChannels = async (
  token: string,
  cap = 400,
): Promise<{ id: string; name: string }[]> => {
  const out: { id: string; name: string }[] = []
  let cursor = ""
  do {
    const q = new URLSearchParams({
      exclude_archived: "true",
      limit: "200",
      types: "public_channel",
      ...(cursor ? { cursor } : {}),
    })
    const res = await fetch(`${API}/conversations.list?${q}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const data = (await res.json()) as {
      ok: boolean
      error?: string
      channels?: { id?: string; name?: string }[]
      response_metadata?: { next_cursor?: string }
    }
    if (!data.ok) throw new SlackApiError(data.error ?? "unknown")
    for (const c of data.channels ?? []) if (c.id && c.name) out.push({ id: c.id, name: c.name })
    cursor = data.response_metadata?.next_cursor ?? ""
  } while (cursor && out.length < cap)
  return out.slice(0, cap)
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
 *  declares (see slack-app-setup buildSlackManifest). What each one is actually for:
 *
 *    chat:write        chat.postMessage — the comment mirror, event cards, DMs
 *    commands          the /derive slash command (Slack rejects the manifest without it)
 *    links:read        delivery of link_shared — a Derive link pasted into a channel
 *    links:write       chat.unfurl — attaching the preview card to it
 *    channels:join     conversations.join, so the bot can self-add to a public channel
 *    channels:history  delivery of message.channels — public-channel reply-back
 *    groups:history    delivery of message.groups — private-channel reply-back
 *    users:read        users.info, to name the author of an inbound Slack reply
 *    users:read.email  users.lookupByEmail, the DM fallback for a member who hasn't linked
 *    im:write          conversations.open, to DM a member. Reading DMs would need
 *                      im:history, which we deliberately do NOT request (see the
 *                      bot_events note in slack-app-setup.ts).
 *
 *  channels:read / groups:read back no call Derive makes today — they cover conversation
 *  metadata (conversations.list/info), which nothing here reads; the channel is configured by
 *  pasting its id. They are kept rather than trimmed on purpose: the cost of holding them is
 *  a line on the consent screen, while the cost of being wrong about an event-delivery
 *  dependency is silent (see the re-auth note below) — Slack would simply stop delivering
 *  private-channel replies with nothing to detect. Revisit only with a live check.
 *
 *  Re-auth on scope drift is only automatic for scopes an OUTBOUND call needs: a stale
 *  install hits `missing_scope`, which flags needs_reauth and shows the reconnect banner.
 *  Event-delivery scopes (groups:*) are different — Slack simply stops delivering the events
 *  to a token that lacks them, so Derive makes no failing call and nothing flags the drift.
 *  Existing installs must reconnect by hand to get private-channel reply-back; there is no
 *  automatic prompt (a real scope-drift detector is future work). */
export const SLACK_BOT_SCOPES = [
  "chat:write",
  // Slack rejects the whole manifest without this ("Slash Commands requires `commands` bot
  // scope"), so the app could not be created at all — /derive shipped in #454, but this scope
  // did not accompany it until #558. An install predating that fix lacks it, and its slash
  // command stays dead until the workspace reconnects.
  "commands",
  "links:read",
  "links:write",
  "channels:read", // backs no call today — see the note above
  "channels:join",
  "channels:history",
  "groups:read", // backs no call today — see the note above
  "groups:history",
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
