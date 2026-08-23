// Shared infrastructure for the connected Slack App's outbound delivery senders (the
// comment mirror, event cards, and DMs). Each sender resolves what to post and where; the
// common "decrypt the bot token, post, recover from the usual Slack failures, and map to a
// ChannelSendResult" lives here so it isn't re-implemented three times.

import type { MetaStore, SlackInstallRecord } from "@derive/core"
import type { ChannelSendResult } from "../webhooks"
import { decryptSecret } from "./crypto"
import {
  isPermanentSlackError,
  isSlackAuthError,
  joinSlackChannel,
  postSlackMessage,
  SlackApiError,
} from "./slack"

// A Work Object fallback is only for a feature/schema rejection. Retrying a rate limit,
// permission problem or malformed blocks without metadata wastes an API call and can mask the
// real diagnosis (and a blocks error still needs the ordinary text-only recovery below).
const WORK_OBJECT_METADATA_ERRORS = new Set([
  "invalid_metadata_format",
  "invalid_metadata_schema",
  "error_processing_metadata",
  "metadata_must_be_sent_from_app",
  "metadata_too_large",
])

/** Flag a workspace's Slack install as needing re-auth after a Slack call failed for auth
 *  or scope reasons, so the Settings UI prompts a reconnect. Best-effort. */
export const flagSlackReauth = async (meta: MetaStore, orgId: string): Promise<void> => {
  const full = await meta.getSlackInstall(orgId)
  if (full && full.needs_reauth !== 1) await meta.setSlackInstall({ ...full, needs_reauth: 1 })
}

/** The connected install plus its decrypted bot token, or null when Slack isn't connected
 *  on this workspace/runtime (⇒ the sender no-ops as delivered rather than dead-lettering). */
export const resolveBotToken = async (
  meta: MetaStore,
  orgId: string,
  encryptionKey: string | undefined,
): Promise<{ install: SlackInstallRecord; token: string } | null> => {
  const install = await meta.getSlackInstall(orgId)
  if (!install || !encryptionKey) return null
  return { install, token: decryptSecret(install.bot_token, encryptionKey) }
}

/** A successful post carries the message ts + channel so the caller can record a thread link. */
export type SlackDeliveryResult = ChannelSendResult & { ts?: string; channel?: string }

/** Map a thrown Slack error to a delivery result: flag the install for re-auth on an
 *  auth/scope failure, and mark permanent (dead-letter) failures. Shared by every place a
 *  Slack call can throw (posting, opening a DM channel). */
export const slackFailure = async (
  meta: MetaStore,
  orgId: string,
  err: unknown,
  forcePermanent = false,
): Promise<ChannelSendResult> => {
  if (!(err instanceof SlackApiError))
    return { ok: false, status: (err as Error).message.slice(0, 160) }
  if (isSlackAuthError(err.code)) await flagSlackReauth(meta, orgId)
  const permanent =
    forcePermanent || isPermanentSlackError(err.code) || err.code === "not_in_channel"
  return { ok: false, status: `slack: ${err.code}`, permanent }
}

/**
 * Post a message and map the outcome to a delivery result, recovering from the failures
 * every sender hits the same way:
 *  - `autoJoin`: on `not_in_channel`, join the public channel once and retry.
 *  - `textFallback`: on `invalid_blocks`, retry as plain text so the notification still lands.
 * Auth/scope failures flag the install for re-auth; permanent Slack errors (and an
 * un-joinable channel) are marked so the outbox dead-letters instead of burning retries.
 */
export const postWithRecovery = async (
  meta: MetaStore,
  orgId: string,
  token: string,
  args: {
    channel: string
    text: string
    blocks?: unknown
    /** Expanded Block Kit used only when Slack rejects native Work Object metadata. */
    fallbackBlocks?: unknown
    threadTs?: string
    metadata?: Record<string, unknown>
  },
  opts: { autoJoin?: boolean; textFallback?: boolean; metadataFallback?: boolean } = {},
): Promise<SlackDeliveryResult> => {
  const { fallbackBlocks, ...postArgs } = args
  const post = (blocks: unknown) => postSlackMessage(token, { ...postArgs, blocks })
  const ok = (ts: string, channel: string, note = ""): SlackDeliveryResult => ({
    ok: true,
    status: `posted${note} ${ts}`,
    ts,
    channel,
  })

  try {
    const res = await post(args.blocks)
    return ok(res.ts, res.channel)
  } catch (err) {
    if (!(err instanceof SlackApiError)) return slackFailure(meta, orgId, err)
    if (
      opts.autoJoin &&
      err.code === "not_in_channel" &&
      (await joinSlackChannel(token, args.channel))
    ) {
      try {
        const res = await post(args.blocks)
        return ok(res.ts, res.channel)
      } catch (retryErr) {
        return slackFailure(meta, orgId, retryErr)
      }
    }
    // Work Objects are progressively enabled by Slack. A rich DM must remain a useful
    // notification when an older install rejects the entity metadata, so retry once as the
    // ordinary Block Kit card. This happens only after Slack rejected the first request (not a
    // network ambiguity), avoiding duplicate DMs.
    if (opts.metadataFallback && args.metadata && WORK_OBJECT_METADATA_ERRORS.has(err.code)) {
      try {
        const res = await postSlackMessage(token, {
          ...postArgs,
          blocks: fallbackBlocks ?? args.blocks,
          metadata: undefined,
        })
        return ok(res.ts, res.channel, " blocks-only")
      } catch (retryErr) {
        return slackFailure(meta, orgId, retryErr)
      }
    }
    if (opts.textFallback && err.code === "invalid_blocks") {
      try {
        const res = await post(undefined)
        return ok(res.ts, res.channel, " text-only")
      } catch (retryErr) {
        return slackFailure(meta, orgId, retryErr, true)
      }
    }
    return slackFailure(meta, orgId, err)
  }
}
