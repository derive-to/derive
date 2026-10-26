// THE REPLY TO WHERE A JOB WAS ASKED: a job somebody asked for outside Derive ("@Derive review
// this" in a Slack thread, "@derive review this" on a pull request) tells them, there, that it
// needs them or how it ended. docs/agent-dispatch.md §8 and §17.
//
// It is the outbound half of a hand-off (lib/hand-off.ts). The job carries where it was asked
// as `meta_json.origin`, a reply-to address that nothing between the hand-off and here reads;
// lib/notify-job.ts calls this once per announcement, before the interrupts, so a reply that
// lands can stand in for the asker's DM and email. What a reply looks like and how it travels
// is each place's own (lib/slack-thread-reply.ts, lib/github-comment-reply.ts), chosen by the
// origin's kind in notify-job.ts; what makes it happen once is here, written once for both.
//
// EXACTLY ONCE. notifyJob can run twice for one transition, so every reply leaves a marker on
// the job, `meta_json.origin_replies`, keyed by the announcement, the status, and which run it
// belongs to (`since`: when the run that asked started, or when the job finished). Both are
// fixed by the transition itself, so a pass handed a fresh read of the row, the marker write
// included, still finds its key. A job asked again after it finished, or waiting on a person a
// second time, is a new run, a new key and a new reply.
//
// DECORATION, so it fails open: a connection that is gone or a post the other side refuses is
// logged once and reported as not posted, and the caller sends the interrupts as if there were
// nowhere to reply.

import {
  type AgentRecord,
  type ArtifactRecord,
  artifactUrl,
  type JobOrigin,
  type JobRecord,
  jobOriginOf,
  type MetaStore,
} from "@derive/core"
import { log } from "../log"

/** What notifyJob announces (lib/notify-job.ts imports this file, so it is named here). */
export type JobAnnouncement = "job.needs_you" | "job.finished"

/** One reply already made for a job (docs/agent-dispatch.md §4.2). */
export interface OriginReply {
  announcement: JobAnnouncement
  status: string
  /** Which run this was: what tells a second needs-you from a resent first. */
  since: string
  /** What the reply landed as: a Slack message ts, a GitHub comment id. */
  ts: string
}

export type OriginReplyOutcome = "posted" | "skipped_marker" | "failed" | "none"

export interface OriginReplyDeps {
  meta: MetaStore
  baseUrl: string
  encryptionKey?: string
}

/** One announcement, for a place to render and deliver. */
export interface OriginAnnouncement {
  owner: JobRecord
  job: JobRecord
  event: JobAnnouncement
  agent: AgentRecord
  /** The job's task page. */
  jobLink: string
  report: { title: string; url: string } | null
}

/** A place's delivery: where it landed, why it did not, or null when there is nothing to say. */
export type OriginDelivery = { ok: true; ts: string } | { ok: false; reason: string } | null

/** The place that answers an origin, or null when nothing replies to it. */
export type OriginReplier = (
  origin: JobOrigin,
) => ((deps: OriginReplyDeps, a: OriginAnnouncement) => Promise<OriginDelivery>) | null

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

/** Reply where the job was asked, once. Never throws. `posted` and `skipped_marker` both mean
 *  the asker can already read it there, so their own interrupt for it would only repeat it. */
export const replyToOrigin = async (
  deps: OriginReplyDeps,
  input: {
    /** The job the person asked for: a graph step's announcement is its graph's. */
    owner: JobRecord
    /** The job whose state is announced: the owner, or a graph step that needs a person. */
    job: JobRecord
    event: JobAnnouncement
    agent: AgentRecord
    report: ArtifactRecord | null
  },
  replierFor: OriginReplier,
): Promise<OriginReplyOutcome> => {
  const { meta } = deps
  const { owner, job, event, agent } = input
  const origin = jobOriginOf(owner.meta_json)
  const reply = origin ? replierFor(origin) : null
  if (!origin || !reply || job.status === "cancelled") return "none"
  const since = (event === "job.finished" ? job.finished_at : job.started_at) ?? job.updated_at
  const key = { announcement: event, status: job.status, since }
  const outcome = (o: OriginReplyOutcome, reason?: string) => {
    log.info(origin.kind === "slack" ? "slack thread reply" : "github comment reply", {
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
  const delivered = await reply(deps, {
    owner,
    job,
    event,
    agent,
    jobLink: `${base}/tasks/${owner.id}`,
    report: input.report
      ? { title: input.report.title ?? "Report", url: artifactUrl(base, input.report) }
      : null,
  }).catch((e): OriginDelivery => ({ ok: false, reason: e instanceof Error ? e.message : "" }))
  if (!delivered) return "none"
  if (!delivered.ok) return outcome("failed", delivered.reason)

  // The marker IS the record of the reply. Merged onto the row as it stands, guarded on
  // meta_json, so a concurrent write is re-read rather than overwritten.
  const entry: OriginReply = { ...key, ts: delivered.ts }
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
  if (!marked) log.warn("origin reply posted but not marked", { job: owner.id })
  return outcome("posted")
}
