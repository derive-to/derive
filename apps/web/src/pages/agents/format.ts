import type { Agent, AgentTrigger, Job, JobStatus } from "@/api"
import { API_BASE } from "@/api"
import type { IconName } from "@/components/icons"

// Words and grouping for the agent screens. Pure, so the three screens (home, one agent,
// Settings › Machines) say the same thing about the same agent.

/** The agents a person sees: never the rows auto-minted for a context. */
export const rosterOf = <A extends Agent>(agents: A[]): A[] => agents.filter((a) => !a.managed)

export const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? ""

export const firstName = (name: string | null | undefined): string | null =>
  name?.trim().split(/\s+/)[0] || null

/** A runner that pulled work in the last two minutes is on (it polls every few seconds). */
const ONLINE_MS = 120_000

export type MachineMark = { label: string; on: boolean }

/** Where an agent's jobs run, in words, and whether that machine is answering. */
export function machineOf(agent: Agent, names: Map<string, string>): MachineMark {
  if (agent.machine === "derive") return { label: "Derive", on: true }
  if (!agent.seen_at) return { label: "No machine", on: false }
  const owner = firstName(agent.created_by ? names.get(agent.created_by) : null)
  const label = owner ? `${owner}'s machine` : "Owner's machine"
  const on = Date.now() - new Date(agent.seen_at).getTime() < ONLINE_MS
  return on ? { label, on } : { label: `${label}, off`, on }
}

/** The owner-machine label alone, for Settings › Machines. */
export const ownerMachineName = (userId: string | null, names: Map<string, string>): string => {
  const owner = firstName(userId ? names.get(userId) : null)
  return owner ? `${owner}'s machine` : "Owner's machine"
}

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** A cron line in words for the common shapes; the cron itself otherwise. */
export function cronLabel(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string]
  if (dom !== "*" || mon !== "*") return cron
  const step = /^\*\/(\d+)$/.exec(m)
  if (step && h === "*" && dow === "*") return `Every ${step[1]} min`
  if (/^\d+$/.test(m) && h === "*" && dow === "*") return "Hourly"
  if (!/^\d+$/.test(m) || !/^\d+$/.test(h)) return cron
  const at = `${Number(h)}:${m.padStart(2, "0")}`
  if (dow === "*") return `Every day ${at}`
  if (dow === "1-5") return `Weekdays ${at}`
  if (/^[0-7]$/.test(dow)) return `${DAYS[Number(dow) % 7]} ${at}`
  if (/^[0-7](,[0-7])+$/.test(dow))
    return `${dow
      .split(",")
      .map((d) => DAY_SHORT[Number(d) % 7])
      .join(", ")} ${at}`
  return cron
}

/** An agent's enabled schedules. */
export const schedulesOf = (triggers: AgentTrigger[] | undefined): AgentTrigger[] =>
  (triggers ?? []).filter((t) => t.kind === "schedule" && t.enabled && t.cron)

/** "14:05" today, "Aug 19" this year, "Aug 19, 2025" before that. Always shown mono. */
export function when(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  })
}

/** How long something has taken: "under 1 min", "4 min", "2 h". */
export function took(fromIso: string, toIso?: string | null): string {
  const ms = Math.max(
    0,
    (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime(),
  )
  const min = Math.floor(ms / 60_000)
  if (min < 1) return "under 1 min"
  if (min < 120) return `${min} min`
  return `${Math.floor(min / 60)} h`
}

export const OPEN_STATUSES: readonly JobStatus[] = ["queued", "running", "needs_you"]

/** One glyph per job state: the shape carries it, not a colour. */
export const JOB_ICON: Record<JobStatus, IconName> = {
  queued: "job-queued",
  running: "job-running",
  needs_you: "job-needs-you",
  succeeded: "job-succeeded",
  failed: "job-failed",
  lost: "job-failed",
  cancelled: "job-cancelled",
}

/** Why a job did not finish, as the job recorded it. */
export const failureOf = (job: Job): string | null =>
  job.result.failure?.reason ?? (job.status === "lost" ? "no reply came back" : null)

export type AgentGroup = "running" | "scheduled" | "asked" | "never"

/** The Agents home, grouped by state. Needs-you rows are per JOB (each one is a question a
 *  person answers); every agent also sits in exactly one of the other groups. */
export function groupAgents(
  agents: Agent[],
  openJobs: Job[],
  recentJobs: Job[],
  triggersOf: (id: string) => AgentTrigger[] | undefined,
): {
  needs: { job: Job; agent: Agent }[]
  groups: Record<AgentGroup, Agent[]>
  lastWorked: Map<string, string>
  running: Map<string, Job[]>
} {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const needs = openJobs
    .filter((j) => j.status === "needs_you" && byId.has(j.agent_id))
    .flatMap((job) => {
      const agent = byId.get(job.agent_id)
      return agent ? [{ job, agent }] : []
    })
  const running = new Map<string, Job[]>()
  for (const j of openJobs)
    if (j.status === "running" || j.status === "queued")
      running.set(j.agent_id, [...(running.get(j.agent_id) ?? []), j])
  const lastWorked = new Map<string, string>()
  for (const j of [...openJobs, ...recentJobs]) {
    const at = j.finished_at ?? j.started_at ?? j.created_at
    const prev = lastWorked.get(j.agent_id)
    if (!prev || at > prev) lastWorked.set(j.agent_id, at)
  }
  const groups: Record<AgentGroup, Agent[]> = { running: [], scheduled: [], asked: [], never: [] }
  for (const a of agents) {
    if (running.has(a.id)) groups.running.push(a)
    else if (schedulesOf(triggersOf(a.id)).length) groups.scheduled.push(a)
    else if (lastWorked.has(a.id) || a.seen_at) groups.asked.push(a)
    else groups.never.push(a)
  }
  const recent = (a: Agent) => lastWorked.get(a.id) ?? a.seen_at ?? a.created_at
  groups.asked.sort((x, y) => recent(y).localeCompare(recent(x)))
  return { needs, groups, lastWorked, running }
}

/** The line that starts an owner-machine agent's runner, given its key. The same shape the
 *  API returns as `runner_command` when the agent is created. */
export function runnerCommand(agentId: string, key: string): string {
  const server = API_BASE || (typeof window === "undefined" ? "" : window.location.origin)
  return `DERIVE_TOKEN=${key} npx -y @derive-to/cli runner serve --agent ${agentId} --server ${server}`
}
