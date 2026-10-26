// THE SLACK THREAD REPLY: how a job asked for in a Slack thread ("@Derive review this") says, in
// that thread, that it needs them or how it ended. docs/agent-dispatch.md §8.
//
// The Slack place of lib/origin-reply.ts, which decides when to reply and makes it happen once;
// this file only says what the message is and posts it.
//
// A NEW MESSAGE, never an edit: an edited message notifies nobody, and the person asked
// minutes ago and has moved on. It opens with their mention for the same reason.

import { type JobOrigin, jobNeeds, jobResult } from "@derive/core"
import type { OriginAnnouncement, OriginDelivery, OriginReplyDeps } from "./origin-reply"
import { mrkdwnBody } from "./slack-cards"
import { postWithRecovery, resolveBotToken } from "./slack-delivery"
import { absoluteLinks } from "./text"

/** A reply is one message, not a report: the summary and the links, and the rest in Derive. */
export const SLACK_REPLY_MAX_CHARS = 3000

/** The message for one announcement, in markdown, or null when it says nothing (cancelled). */
const replyMarkdown = ({
  job,
  event,
  agent,
  jobLink,
  report,
}: OriginAnnouncement): string | null => {
  const who = `**${agent.name}**`
  const open = `[Open in Derive](${jobLink})`
  if (event === "job.needs_you") {
    const question = jobNeeds(job)?.question?.trim()
    return `${who} needs your answer${question ? `: ${question}` : "."}\n[Answer in Derive](${jobLink})`
  }
  if (job.status === "succeeded") {
    const result = jobResult(job)
    const effects = (result.effects ?? []).filter((e) => e.url)
    return [
      result.summary?.trim() ? `${who} finished: ${result.summary.trim()}` : `${who} finished.`,
      ...effects.map((e) => `- [${e.label || e.url}](${e.url})`),
      report ? `[${report.title}](${report.url})` : open,
    ].join("\n")
  }
  if (job.status === "failed") {
    const reason = jobResult(job).failure?.reason?.trim()
    return `${who} failed${reason ? `: ${reason}` : "."}\n${open}`
  }
  if (job.status === "lost") return `${who} was interrupted before it finished.\n${open}`
  return null
}

/** Slack user and bot ids; anything else is not ours to put inside `<@…>`. */
const SLACK_ID = /^[UW][A-Z0-9]+$/

/** Post the announcement into the Slack thread the job was asked from. */
export const slackThreadReply = async (
  deps: OriginReplyDeps,
  origin: Extract<JobOrigin, { kind: "slack" }>,
  a: OriginAnnouncement,
): Promise<OriginDelivery> => {
  const md = replyMarkdown(a)
  if (!md) return null
  const { meta } = deps
  const { owner } = a
  // Several Derive workspaces can share one Slack team; the reply speaks for the job's own,
  // and only while that workspace is still connected to the team the thread lives in.
  const bot = await resolveBotToken(meta, owner.org_id, deps.encryptionKey)
  if (!bot || bot.install.team_id !== origin.team_id)
    return { ok: false, reason: "slack not connected" }
  const mention = SLACK_ID.test(origin.requested_by) ? `<@${origin.requested_by}> ` : ""
  const text = `${mention}${mrkdwnBody(absoluteLinks(md, deps.baseUrl.replace(/\/$/, "")), SLACK_REPLY_MAX_CHARS - mention.length)}`
  const res = await postWithRecovery(meta, owner.org_id, bot.token, {
    channel: origin.channel,
    threadTs: origin.thread_ts,
    text,
  })
  return res.ok && res.ts ? { ok: true, ts: res.ts } : { ok: false, reason: res.status }
}
