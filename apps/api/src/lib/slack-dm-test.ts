import type { MetaStore } from "@derive/core"
import { openSlackDm, resolveSlackUserIdByEmail } from "./slack"
import { postWithRecovery, resolveBotToken, slackFailure } from "./slack-delivery"

export interface SlackTestDmResult {
  email: string
  ok: boolean
  reason?: string
}

const TEST_TEXT = "Derive test DM — notifications are working."
const TEST_BLOCKS = [
  {
    type: "section",
    text: { type: "mrkdwn", text: ":wave: This is a test DM from Derive. You're all set." },
  },
]

/** Send a fixed test message through one workspace's Slack install. */
export const sendSlackTestDms = async (
  meta: MetaStore,
  orgId: string,
  encryptionKey: string | undefined,
  emails: string[],
): Promise<SlackTestDmResult[]> => {
  const bot = await resolveBotToken(meta, orgId, encryptionKey)
  if (!bot) return emails.map((email) => ({ email, ok: false, reason: "Slack is not connected" }))

  const results: SlackTestDmResult[] = []
  for (const email of emails) {
    let slackUserId: string | null
    try {
      slackUserId = await resolveSlackUserIdByEmail(bot.token, email)
    } catch (err) {
      const failure = await slackFailure(meta, orgId, err)
      results.push({ email, ok: false, reason: failure.status })
      continue
    }
    if (!slackUserId) {
      results.push({ email, ok: false, reason: "No Slack user has this email" })
      continue
    }

    let channel: string
    try {
      channel = await openSlackDm(bot.token, slackUserId)
    } catch (err) {
      const failure = await slackFailure(meta, orgId, err)
      results.push({ email, ok: false, reason: failure.status })
      continue
    }

    const sent = await postWithRecovery(
      meta,
      orgId,
      bot.token,
      { channel, text: TEST_TEXT, blocks: TEST_BLOCKS },
      { textFallback: true },
    )
    results.push(sent.ok ? { email, ok: true } : { email, ok: false, reason: sent.status })
  }
  return results
}
