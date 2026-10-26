// THE PULL REQUEST COMMENT REPLY: how a job somebody asked for by mentioning the App on a pull
// request ("@derive review this") tells that pull request how it went. docs/agent-dispatch.md
// §17.
//
// The GitHub place of lib/origin-reply.ts, which decides when to reply and makes it happen once;
// this file only says what the outcome is and writes it.
//
// ONE COMMENT, EDITED. The mention lane (lib/github-mention.ts) answered with one comment saying
// what started, and recorded it as `origin.ack_comment_id`. Each outcome is appended to that
// comment, under what it already says, so the comment reads as the request's history and the
// pull request does not collect a Derive comment per state. The agent's own comment on the pull
// request is the real result; this one only says it happened. Slack does the opposite, a new
// message each time, because there the person is not looking at the place the work landed.
//
// Written with the server's own installation token for the one repository, never an agent's:
// the agent holds only its bound sources, and this comment is Derive's, not the agent's.

import { type JobOrigin, jobNeeds, jobResult, type MetaStore } from "@derive/core"
import { log } from "../log"
import { decryptSecret } from "./crypto"
import {
  createIssueComment,
  GitHubError,
  getIssueComment,
  installationToken,
  repositoryInstallation,
  updateIssueComment,
} from "./github-app"
import type { OriginAnnouncement, OriginDelivery, OriginReplyDeps } from "./origin-reply"
import { absoluteLinks, truncate } from "./text"

/**
 * GitHub will not let this comment be written, for good: a refused edit (403) or a comment that
 * is gone (404). A 403 that is GitHub's rate limit says "not now", not "never", so it is a
 * failed reply to leave to the interrupts rather than a reason to post a second comment.
 */
export const commentRefused = (e: unknown): boolean =>
  e instanceof GitHubError &&
  (e.status === 404 || (e.status === 403 && e.rateLimitRemaining !== "0"))

/**
 * Record a comment as the job's `origin.ack_comment_id`, the one comment its outcomes edit.
 * Merged onto the row as it stands and guarded on it: the job is live, and a runner's write in
 * between is re-read rather than overwritten.
 */
export const recordAckComment = async (
  meta: MetaStore,
  jobId: string,
  ack: number,
): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await meta.getJob(jobId).catch(() => null)
    if (!row) return
    let parsed: { origin?: Record<string, unknown> } = {}
    try {
      parsed = JSON.parse(row.meta_json ?? "{}")
    } catch {}
    const meta_json = JSON.stringify({
      ...parsed,
      origin: { ...parsed.origin, ack_comment_id: ack },
    })
    if (await meta.updateJob(jobId, { meta_json }, { meta_json: row.meta_json }).catch(() => null))
      return
  }
  log.warn("github comment posted but not recorded", { job: jobId })
}

/** One line of outcome is a sentence, not a report: the rest is on the task page. */
const LINE_MAX_CHARS = 1000

/**
 * A GitHub @mention made inert. The text here is the agent's summary or the model's answer,
 * shaped by whatever the pull request said, and on GitHub `@someone` or `@org/team` in a
 * comment notifies them: a comment that says "ping @org/everyone" would page a whole team in
 * Derive's name. A zero-width space after the `@` keeps the text and drops the notification, in
 * code too, since GitHub cannot be trusted to agree on where code ends. An email address (a
 * word character before the `@`) is left alone.
 */
export const quietMentions = (text: string): string =>
  text.replace(/(^|[^\w])@(?=[A-Za-z0-9])/g, "$1@​")

/** The outcome, in GitHub markdown, or null when it says nothing (cancelled). */
const outcomeMarkdown = ({
  job,
  event,
  agent,
  jobLink,
  report,
}: OriginAnnouncement): string | null => {
  const who = `**${quietMentions(agent.name)}**`
  const line = (s: string) => quietMentions(truncate(s.replace(/\s+/g, " ").trim(), LINE_MAX_CHARS))
  const open = `[Open in Derive](${jobLink})`
  if (event === "job.needs_you") {
    const question = jobNeeds(job)?.question?.trim()
    return `❓ ${who} needs you${question ? `: ${line(question)}` : "."}\n[Answer in Derive](${jobLink})`
  }
  if (job.status === "succeeded") {
    const result = jobResult(job)
    const effects = (result.effects ?? []).filter((e) => e.url)
    return [
      result.summary?.trim()
        ? `✅ ${who} finished: ${line(result.summary)}`
        : `✅ ${who} finished.`,
      ...effects.map((e) => `- [${line(e.label || e.url || "")}](${e.url})`),
      ...(report ? [`[${line(report.title)}](${report.url})`] : []),
      open,
    ].join("\n")
  }
  if (job.status === "failed") {
    const reason = jobResult(job).failure?.reason?.trim()
    return `❌ ${who} failed${reason ? `: ${line(reason)}` : "."}\n${open}`
  }
  if (job.status === "lost") return `⚠️ ${who} was interrupted before it finished.\n${open}`
  return null
}

/** Append the outcome to Derive's comment on the pull request, or, when GitHub will not let it
 *  be edited, post it as a new one. */
export const githubCommentReply = async (
  deps: OriginReplyDeps,
  origin: Extract<JobOrigin, { kind: "github" }> & { ack_comment_id: number },
  a: OriginAnnouncement,
): Promise<OriginDelivery> => {
  const md = outcomeMarkdown(a)
  if (!md || !origin.number) return null
  const { meta } = deps
  const app = await meta.getGithubApp().catch(() => null)
  if (!app || !deps.encryptionKey) return { ok: false, reason: "github not configured" }
  const pem = decryptSecret(app.private_key, deps.encryptionKey)
  // Looked up now rather than stored at the ask: the App may have been reinstalled since. And
  // only while the job's own workspace still holds that installation, as Slack replies only
  // while the workspace is still connected to the team.
  const installation = await repositoryInstallation(app.app_id, pem, origin.repository)
  const held = (await meta.listConnections(a.owner.org_id, undefined, "workspace")).some(
    (cn) => cn.kind === "github_app" && cn.status === "active" && cn.broker_ref === installation,
  )
  if (!held) return { ok: false, reason: "github not connected" }
  const name = origin.repository.split("/")[1] ?? ""
  const token = await installationToken(app.app_id, pem, installation, "pr-comment", name)
  const outcome = absoluteLinks(md, deps.baseUrl)

  // The new comment becomes the one later outcomes edit, so a refused edit costs one extra
  // comment, not one per announcement.
  const post = async () => {
    const made = await createIssueComment(token, origin.repository, origin.number ?? 0, outcome)
    await recordAckComment(meta, a.owner.id, made.id)
    return { ok: true as const, ts: String(made.id) }
  }
  // Read first, so what the comment already says stays above the new line. A comment somebody
  // deleted, or one GitHub will not show us, is replaced by a new one rather than lost; any
  // other failure is a failed reply, so the interrupts go out instead of a stray second comment.
  let current: { body: string }
  try {
    current = await getIssueComment(token, origin.repository, origin.ack_comment_id)
  } catch (e) {
    if (commentRefused(e)) return post()
    throw e
  }
  try {
    await updateIssueComment(
      token,
      origin.repository,
      origin.ack_comment_id,
      `${current.body.trimEnd()}\n\n${outcome}`,
    )
    return { ok: true, ts: String(origin.ack_comment_id) }
  } catch (e) {
    if (commentRefused(e)) return post()
    throw e
  }
}
