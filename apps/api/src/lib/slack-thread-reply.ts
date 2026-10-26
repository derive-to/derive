// THE SLACK THREAD REPLY: a job somebody asked for in a Slack thread ("@Derive review this")
// tells them, in that thread, that it needs them or how it ended. docs/agent-dispatch.md §8.
//
// It is the outbound half of the Slack hand-off (lib/hand-off.ts). The job carries the thread
// as `meta_json.origin`, a reply-to address that nothing between the hand-off and here reads;
// lib/notify-job.ts calls this once per announcement, before the interrupts, so a reply that
// lands can stand in for the asker's DM and email.
//
// A NEW MESSAGE, never an edit: an edited message notifies nobody, and the person asked
// minutes ago and has moved on. It opens with their mention for the same reason.
//
// EXACTLY ONCE. notifyJob can run twice for one transition, so every post leaves a marker on
// the job, `meta_json.origin_replies`, keyed by the announcement, the status, and which run it
// belongs to (`since`: when the run that asked started, or when the job finished). Both are
// fixed by the transition itself, so a pass handed a fresh read of the row, the marker write
// included, still finds its key. A job asked again after it finished, or waiting on a person a
// second time, is a new run, a new key and a new reply.
//
// DECORATION, so it fails open: an install that is gone or a post Slack refuses is logged once
// and reported as not posted, and the caller sends the interrupts as if there were no thread.

import {
  type AgentRecord,
  type ArtifactRecord,
  artifactUrl,
  type JobOrigin,
  type JobRecord,
  jobNeeds,
  jobOriginOf,
  jobResult,
  type MetaStore,
} from "@derive/core"
import { log } from "../log"
import { absoluteLinks, mrkdwnBody } from "./slack-cards"
import { postWithRecovery, resolveBotToken } from "./slack-delivery"

/** What notifyJob announces (lib/notify-job.ts imports this file, so it is named here). */
type JobAnnouncement = "job.needs_you" | "job.finished"

/** A reply is one message, not a report: the summary and the links, and the rest in Derive. */
export const SLACK_REPLY_MAX_CHARS = 3000

/** One reply already posted for a job (docs/agent-dispatch.md §4.2). */
export interface OriginReply {
  announcement: JobAnnouncement
  status: string
  /** Which run this was: what tells a second needs-you from a resent first. */
  since: string
  ts: string
}

export type ThreadReplyOutcome = "posted" | "skipped_marker" | "failed" | "none"

const repliesOf = (metaJson: string | null): OriginReply[] => {
  try {
    const raw = (JSON.parse(metaJson ?? "{}") as { origin_replies?: unknown }).origin_replies
    return Array.isArray(raw) ? (raw as OriginReply[]) : []
  } catch {
    return []
  }
}

const sameReply = (a: Omit<OriginReply, "ts">, b: OriginReply) =>
  a.announcement === b.announcement && a.status === b.status && a.since === b.since

/** The message for one announcement, in markdown, or null when it says nothing (cancelled). */
const replyMarkdown = (
  job: JobRecord,
  event: JobAnnouncement,
  agent: AgentRecord,
  jobLink: string,
  report: { title: string; url: string } | null,
): string | null => {
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

/** Post the announcement into the Slack thread the job was asked from, once. Never throws.
 *  `posted` and `skipped_marker` both mean the thread already has it, so the asker's own
 *  interrupt for it would only repeat it. */
export const replyToThread = async (
  deps: { meta: MetaStore; baseUrl: string; encryptionKey?: string },
  input: {
    /** The job the person asked for: a graph step's announcement is its graph's. */
    owner: JobRecord
    /** The job whose state is announced: the owner, or a graph step that needs a person. */
    job: JobRecord
    event: JobAnnouncement
    agent: AgentRecord
    report: ArtifactRecord | null
  },
): Promise<ThreadReplyOutcome> => {
  const { meta } = deps
  const { owner, job, event, agent } = input
  const origin: JobOrigin | null = jobOriginOf(owner.meta_json)
  if (origin?.kind !== "slack" || job.status === "cancelled") return "none"
  const since = (event === "job.finished" ? job.finished_at : job.started_at) ?? job.updated_at
  const key = { announcement: event, status: job.status, since }
  const outcome = (o: ThreadReplyOutcome, reason?: string) => {
    log.info("slack thread reply", {
      job: owner.id,
      announcement: event,
      outcome: reason ? `failed: ${reason}` : o,
    })
    return o
  }
  // Read fresh: the marker a first pass wrote is not on the record this pass was handed.
  const current = (await meta.getJob(owner.id).catch(() => null)) ?? owner
  if (repliesOf(current.meta_json).some((r) => sameReply(key, r))) return outcome("skipped_marker")

  const base = deps.baseUrl.replace(/\/$/, "")
  const jobLink = `${base}/tasks/${owner.id}`
  const report = input.report
    ? { title: input.report.title ?? "Report", url: artifactUrl(base, input.report) }
    : null
  const md = replyMarkdown(job, event, agent, jobLink, report)
  if (!md) return "none"

  // Several Derive workspaces can share one Slack team; the reply speaks for the job's own,
  // and only while that workspace is still connected to the team the thread lives in.
  const bot = await resolveBotToken(meta, owner.org_id, deps.encryptionKey)
  if (!bot || bot.install.team_id !== origin.team_id)
    return outcome("failed", "slack not connected")
  const mention = SLACK_ID.test(origin.requested_by) ? `<@${origin.requested_by}> ` : ""
  const text = `${mention}${mrkdwnBody(absoluteLinks(md, base), SLACK_REPLY_MAX_CHARS - mention.length)}`
  const res = await postWithRecovery(meta, owner.org_id, bot.token, {
    channel: origin.channel,
    threadTs: origin.thread_ts,
    text,
  })
  if (!res.ok || !res.ts) return outcome("failed", res.status)

  // The marker IS the record of the post. Merged onto the row as it stands, guarded on
  // meta_json, so a concurrent write is re-read rather than overwritten.
  const entry: OriginReply = { ...key, ts: res.ts }
  let marked = false
  for (let attempt = 0; attempt < 3 && !marked; attempt++) {
    const row = attempt === 0 ? current : await meta.getJob(owner.id).catch(() => null)
    if (!row) break
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(row.meta_json ?? "{}") as Record<string, unknown>
    } catch {}
    const meta_json = JSON.stringify({
      ...parsed,
      origin_replies: [...repliesOf(row.meta_json), entry],
    })
    marked = !!(await meta
      .updateJob(owner.id, { meta_json }, { meta_json: row.meta_json })
      .catch(() => null))
  }
  if (!marked) log.warn("slack thread reply posted but not marked", { job: owner.id })
  return outcome("posted")
}
