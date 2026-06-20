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

export interface SlackPostResult {
  ts: string
  channel: string
}

/** Post a message via chat.postMessage. `threadTs` threads it under an existing message. */
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
  if (!data.ok || !data.ts) throw new Error(`slack post failed: ${data.error ?? "unknown"}`)
  return { ts: data.ts, channel: data.channel ?? args.channel }
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

/** The OAuth authorize URL for the "Add to Slack" button. Bot scopes cover posting,
 *  channel listing/join, and reading message/user info for reply-back. */
export const slackAuthorizeUrl = (clientId: string, redirectUri: string, state: string): string => {
  const scopes = ["chat:write", "channels:read", "channels:join", "users:read", "channels:history"]
  const u = new URL("https://slack.com/oauth/v2/authorize")
  u.searchParams.set("client_id", clientId)
  u.searchParams.set("scope", scopes.join(","))
  u.searchParams.set("redirect_uri", redirectUri)
  u.searchParams.set("state", state)
  return u.toString()
}
