import type { AgentRecord, MetaStore, TriggerRecord } from "@derive/core"
import { z } from "@hono/zod-openapi"
import { GITHUB_EVENTS } from "../github-app-setup"
import { log } from "../log"
import { agentWritesOff } from "./agent-writes"
import { parseConnectionIds } from "./broker"
import { decryptSecret } from "./crypto"
import { configureAppWebhook, getAppInfo, githubWebhookSecret } from "./github-app"
import type { JobDeps } from "./job-policy"
import { askAgent } from "./jobs"

// GitHub events start agent tasks the way `on:` starts a GitHub Actions workflow. An event
// trigger names a repository, an event, and optionally its actions and branches. A signed
// delivery for a matching repository starts one task per matching trigger, on an agent that
// holds the GitHub source the delivery came through.

const BRANCH = z.string().trim().min(1).max(200)
export const GithubOn = z
  .object({
    github: z.object({
      event: z.enum(GITHUB_EVENTS),
      repository: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, "owner/name"),
      actions: z
        .array(
          z
            .string()
            .trim()
            .regex(/^[a-z_]{1,40}$/),
        )
        .max(20)
        .optional()
        .describe(
          "Only these actions (opened, synchronize, closed…); merged is a closed pull request that merged. Omit for all.",
        ),
      branches: z
        .array(BRANCH)
        .max(20)
        .optional()
        .describe("Only these branches; * matches within a segment, ** across. Omit for all."),
      drafts: z.boolean().optional().describe("Also run on draft pull requests."),
    }),
  })
  .openapi("GithubTriggerOn")
export type GithubOn = z.infer<typeof GithubOn>

export const parseOn = (onEvent: string | null): GithubOn | null => {
  if (!onEvent) return null
  try {
    const parsed = GithubOn.safeParse(JSON.parse(onEvent))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** What a delivery is about, read once from its payload. */
export interface GithubEvent {
  event: string
  action: string | null
  repository: string
  /** The branch a filter compares: a pull request's base, a push's branch, a run's head. */
  branch: string | null
  /** What a task checks out. */
  ref: string | null
  title: string
  url: string | null
  sender: string | null
  draft: boolean
  /** Opened from another repository: never run on code the repository's owners did not push. */
  fork: boolean
  number: number | null
  /** A closed pull request that merged. */
  merged: boolean
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {})
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null)
const num = (v: unknown): number | null => (typeof v === "number" ? v : null)

export const readGithubEvent = (event: string, payload: unknown): GithubEvent | null => {
  const p = obj(payload)
  const repository = str(obj(p.repository).full_name)
  if (!repository || !(GITHUB_EVENTS as readonly string[]).includes(event)) return null
  const base = {
    event,
    action: str(p.action),
    repository,
    sender: str(obj(p.sender).login),
    draft: false,
    fork: false,
    number: null,
    merged: false,
  }
  if (event === "pull_request" || event === "pull_request_review") {
    const pr = obj(p.pull_request)
    const head = obj(pr.head)
    return {
      ...base,
      branch: str(obj(pr.base).ref),
      ref: str(head.sha),
      title: str(pr.title) ?? "",
      url: str(event === "pull_request" ? pr.html_url : obj(p.review).html_url),
      draft: pr.draft === true,
      fork: str(obj(head.repo).full_name)?.toLowerCase() !== repository.toLowerCase(),
      number: num(pr.number),
      merged: pr.merged === true,
    }
  }
  if (event === "push") {
    const ref = str(p.ref)
    const after = str(p.after)
    // A deleted branch or a tag has nothing to work on.
    if (!ref?.startsWith("refs/heads/") || !after || /^0+$/.test(after) || p.deleted === true)
      return null
    const branch = ref.slice("refs/heads/".length)
    return {
      ...base,
      branch,
      ref: after,
      title: str(obj(p.head_commit).message)?.split("\n")[0] ?? `Push to ${branch}`,
      url: str(p.compare),
    }
  }
  if (event === "issues" || event === "issue_comment") {
    const issue = obj(p.issue)
    return {
      ...base,
      branch: null,
      ref: null,
      title: str(issue.title) ?? "",
      url: str(event === "issues" ? issue.html_url : obj(p.comment).html_url),
      number: num(issue.number),
    }
  }
  if (event === "release") {
    const release = obj(p.release)
    return {
      ...base,
      branch: null,
      ref: str(release.tag_name),
      title: str(release.name) ?? str(release.tag_name) ?? "",
      url: str(release.html_url),
    }
  }
  const run = obj(p.workflow_run)
  return {
    ...base,
    branch: str(run.head_branch),
    ref: str(run.head_sha),
    title: `${str(run.name) ?? "Workflow"} ${str(run.conclusion) ?? str(run.status) ?? ""}`.trim(),
    url: str(run.html_url),
  }
}

const glob = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split("**")
      .map((part) =>
        part
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*"),
      )
      .join(".*")}$`,
  )

export const githubMatches = (on: GithubOn, e: GithubEvent): boolean => {
  const g = on.github
  if (g.event !== e.event) return false
  if (g.repository.toLowerCase() !== e.repository.toLowerCase()) return false
  if (g.actions?.length) {
    const action = e.action === "closed" && e.merged ? ["closed", "merged"] : [e.action]
    if (!action.some((a) => a && g.actions?.includes(a))) return false
  }
  if (g.branches?.length && !(e.branch && g.branches.some((b) => glob(b).test(e.branch ?? ""))))
    return false
  if (e.fork) return false
  if (e.draft && !g.drafts) return false
  return true
}

/** The trigger's instruction, then what happened, so the task reads like the event. */
export const eventInstruction = (instruction: string, e: GithubEvent): string => {
  const what = `${e.event}${e.action ? `.${e.action}` : ""}`
  const where = `${e.repository}${e.number ? `#${e.number}` : ""}`
  return [
    instruction,
    "",
    "---",
    `GitHub ${what} on ${where}${e.title ? `: ${e.title}` : ""}`,
    ...(e.branch || e.ref
      ? [`${e.branch ? `Branch ${e.branch}` : ""}${e.ref ? ` at ${e.ref}` : ""}`.trim()]
      : []),
    ...(e.url ? [e.url] : []),
    ...(e.sender ? [`By ${e.sender}`] : []),
  ].join("\n")
}

export interface GithubDelivery {
  id: string
  event: string
  installationId: string
  payload: unknown
  /** The App's own bot login: what it does never starts more work, as with GitHub Actions. */
  appBot: string | null
}

/** Start a task for every enabled event trigger a delivery matches. Returns the jobs that were
 *  created; a redelivery finds the job it already made. */
export const dispatchGithubEvent = async (
  deps: JobDeps,
  delivery: GithubDelivery,
): Promise<string[]> => {
  const { meta } = deps
  const e = readGithubEvent(delivery.event, delivery.payload)
  if (!e || (delivery.appBot && e.sender === delivery.appBot)) return []
  const candidates: { t: TriggerRecord; on: GithubOn }[] = []
  for (const t of await meta.listEnabledEventTriggers()) {
    const on = parseOn(t.on_event)
    if (on && githubMatches(on, e)) candidates.push({ t, on })
  }
  const started: string[] = []
  for (const { t } of candidates) {
    try {
      const agent = await meta.getAgent(t.agent_id)
      if (!agent?.created_by || agent.org_id !== t.org_id || agent.paused_at) continue
      if (!(await holdsInstallation(deps, agent, delivery.installationId))) continue
      if (await agentWritesOff(meta, t.org_id)) continue
      const { job, created } = await askAgent(deps, {
        agent,
        askedBy: agent.created_by,
        instruction: eventInstruction(t.instruction, e),
        subject: t.subject_json ? JSON.parse(t.subject_json) : null,
        dedupeKey: `github:${delivery.id}:${t.id}`,
        triggerId: t.id,
        task: { repo: e.ref ? `${e.repository}@${e.ref}` : e.repository },
      })
      if (created) started.push(job.id)
    } catch (error) {
      log.warn("github: event trigger did not start", {
        trigger: t.id,
        reason: (error as Error).message,
      })
    }
  }
  return started
}

/** The delivery came through an installation this agent is bound to as a source. */
const holdsInstallation = async (deps: JobDeps, agent: AgentRecord, installationId: string) => {
  const ids = parseConnectionIds(agent.connection_ids_json)
  if (!ids.length) return false
  const connections = await deps.meta.getConnectionsByIds(ids)
  return connections.some(
    (cn) =>
      cn.org_id === agent.org_id &&
      cn.kind === "github_app" &&
      cn.status === "active" &&
      cn.broker_ref === installationId,
  )
}

/** Make sure the App delivers this event to Derive. Sets the webhook's URL and secret (the one
 *  part the API allows), then says what is left to switch on in the App's settings, or null. */
export const githubEventsSetup = async (
  meta: MetaStore,
  encryptionKey: string | undefined,
  baseUrl: string,
  event: string,
): Promise<string | null> => {
  const app = await meta.getGithubApp()
  if (!app || !encryptionKey) return "GitHub is not set up on this server, so no events arrive."
  const pem = decryptSecret(app.private_key, encryptionKey)
  try {
    await configureAppWebhook({
      appId: app.app_id,
      privateKeyPem: pem,
      url: new URL("/v1/github/webhook", baseUrl).toString(),
      secret: githubWebhookSecret(app.app_id, encryptionKey),
    })
  } catch (error) {
    log.warn("github: webhook setup failed", { reason: (error as Error).message })
    return "Derive could not set the GitHub App's webhook. Try saving again."
  }
  const info = await getAppInfo(app.app_id, pem).catch(() => null)
  if (!info || info.events.includes(event)) return null
  const settings =
    info.owner?.type === "Organization"
      ? `https://github.com/organizations/${info.owner.login}/settings/apps/${app.slug}/permissions`
      : `https://github.com/settings/apps/${app.slug}/permissions`
  return `GitHub is not sending "${event}" events yet. Turn on the webhook and subscribe to ${event} at ${settings}`
}
