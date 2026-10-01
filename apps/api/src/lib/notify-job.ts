// THE JOB FAN-OUT: an agent's job reached a person, so tell them. Modeled on
// lib/review-request.ts, written once for every place a job settles or waits (lib/jobs.ts
// reportJob, cancel and reclaim; the graph walker), so no settle path tells fewer channels.
//
// When: a job moves to needs_you (`job.needs_you`), or to succeeded, failed, lost or cancelled
// (`job.finished`). A retryable failure that goes back in the queue is neither. The callers
// run this only after their status-guarded write landed, so one transition is one fan-out: a
// resent report, a lapsed lease, or a second pass over a graph finds nothing to tell.
//
// Who: the person who asked; for a job nobody asked (a schedule fired) the agent's creator;
// and on needs_you also the agent's manager (its creator) when that is someone else. Never
// the person whose own action caused it (cancelling your own job tells you nothing), never
// someone who has left the workspace, and never the steps of a graph (the graph itself
// tells, once, at its end or when it waits).
//
// How: a bell row and the live `u:<id>` events, an email (workspace email on and the
// person's agent-email opt-in), a Slack DM (when the workspace has Slack and the person has
// not turned DMs off), then the workspace's webhooks.

import {
  type AgentRecord,
  type ArtifactRecord,
  artifactUrl,
  type JobRecord,
  jobNeeds,
  jobResult,
  type MetaStore,
  newId,
} from "@derive/core"
import type { Backplane } from "../bus"
import { log } from "../log"
import { enqueueChannelDelivery, enqueueJobEvent } from "../webhooks"
import { buildJobEmail } from "./email"
import { enqueueSlackJobDm, wantsReviewEmail } from "./slack-dm"
import { truncate } from "./text"

export type JobAnnouncement = "job.needs_you" | "job.finished"

export interface JobNotifyDeps {
  meta: MetaStore
  bus?: Pick<Backplane, "publish">
  baseUrl: string
  /** Drain the outbox now rather than on the next tick. */
  pokeWebhooks?: () => void
}

/** What a job's settle announces, or null when it announces nothing (still open). */
export const announcementFor = (job: Pick<JobRecord, "status">): JobAnnouncement | null =>
  job.status === "needs_you"
    ? "job.needs_you"
    : job.status === "succeeded" ||
        job.status === "failed" ||
        job.status === "lost" ||
        job.status === "cancelled"
      ? "job.finished"
      : null

const VERB: Record<string, string> = {
  needs_you: "needs you",
  succeeded: "finished",
  failed: "failed",
  lost: "lost its machine",
  cancelled: "was cancelled",
}

const firstLine = (s: string) =>
  s
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? ""

/** Who hears about this job: the asker (or, for a scheduled job, the agent's creator), plus
 *  the agent's manager on needs_you. Only people still seated in the workspace. */
const recipientsOf = async (
  meta: MetaStore,
  agent: AgentRecord,
  job: JobRecord,
  event: JobAnnouncement,
  actorId: string | null,
): Promise<string[]> => {
  const ids = new Set<string>()
  const asker = job.asked_by ?? agent.created_by
  if (asker) ids.add(asker)
  if (event === "job.needs_you" && agent.created_by) ids.add(agent.created_by)
  if (actorId) ids.delete(actorId)
  if (ids.size === 0) return []
  // Agents and synthetic principals are not people: the bell is for accounts that read it.
  const people = await meta.getUsers([...ids])
  const out: string[] = []
  for (const u of people)
    if (await meta.getMembership(job.org_id, u.id).catch(() => null)) out.push(u.id)
  return out
}

/** Tell the people a job concerns that it needs them or finished. Best effort, each channel
 *  isolated: a failed email never skips the bell. */
export const notifyJob = async (
  deps: JobNotifyDeps,
  job: JobRecord,
  opts: { actorId?: string | null } = {},
): Promise<void> => {
  const { meta } = deps
  const event = announcementFor(job)
  if (!event || job.parent_id) return
  const agent = await meta.getAgent(job.agent_id)
  if (!agent || agent.org_id !== job.org_id) return
  const recipients = await recipientsOf(meta, agent, job, event, opts.actorId ?? null)
  const report: ArtifactRecord | null = job.report_artifact_id
    ? await meta.getArtifactById(job.report_artifact_id).catch(() => null)
    : null
  const base = deps.baseUrl.replace(/\/$/, "")
  const link = report ? artifactUrl(base, report) : `${base}/agents/${agent.id}`
  const verb = VERB[job.status] ?? "finished"
  const instruction = firstLine(job.instruction) || "a job"
  const question =
    event === "job.needs_you"
      ? (jobNeeds(job)?.question ?? null)
      : job.status === "failed"
        ? (jobResult(job).failure?.reason ?? null)
        : null
  const step = async (surface: string, work: () => Promise<unknown>) => {
    try {
      await work()
    } catch (err) {
      log.warn("job fan-out failed", {
        job: job.id,
        surface,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const rows = recipients.map((uid) => ({
    id: newId("n"),
    user_id: uid,
    actor: agent.name,
    kind: "job" as const,
    artifact_id: report?.id ?? "",
    artifact_short_id: report?.short_id ?? "",
    artifact_title: report?.title ?? null,
    thread_id: agent.id,
    comment_id: job.id,
    preview: truncate(
      `${verb}: ${question && event === "job.needs_you" ? question : instruction}`,
      200,
    ),
  }))
  await step("bell", async () => {
    if (rows.length) await meta.createNotifications(rows)
  })
  const at = new Date().toISOString()
  for (const row of rows)
    await step("bus", async () => {
      deps.bus?.publish(`u:${row.user_id}`, {
        type: "notification",
        notification: { ...row, read: 0, created_at: at },
      })
      deps.bus?.publish(`u:${row.user_id}`, {
        type: event,
        job_id: job.id,
        status: job.status,
        agent_id: job.agent_id,
      })
    })

  if (recipients.length) {
    const settings = await meta.getOrgSettings(job.org_id).catch(() => null)
    const users = await meta.getUsers(recipients)
    for (const u of users) {
      const pref = await meta.getUserNotificationPref(job.org_id, u.id).catch(() => null)
      if (settings?.emailNotifications && wantsReviewEmail(pref?.prefs) && u.email)
        await step("email", () =>
          enqueueChannelDelivery(meta, "email", event, {
            to: u.email,
            toName: u.name ?? undefined,
            ...buildJobEmail({ agentName: agent.name, verb, instruction, question, link }),
          }),
        )
      await step("slack:dm", () =>
        enqueueSlackJobDm(meta, {
          orgId: job.org_id,
          recipientId: u.id,
          agentName: agent.name,
          verb,
          instruction,
          question,
          link,
        }),
      )
    }
  }
  await step("webhooks", () =>
    enqueueJobEvent(meta, base, job.org_id, report, event, {
      id: job.id,
      agent_id: agent.id,
      agent_name: agent.name,
      status: job.status,
      instruction: job.instruction,
      question,
      url: link,
    }),
  )
  deps.pokeWebhooks?.()
}

/** The `announce` a JobDeps carries: notifyJob bound to its delivery deps. */
export const jobAnnouncer =
  (deps: JobNotifyDeps) =>
  (job: JobRecord, actorId?: string | null): Promise<void> =>
    notifyJob(deps, job, { actorId })
