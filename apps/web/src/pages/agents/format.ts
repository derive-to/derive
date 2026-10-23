import type { Agent, AgentTrigger, Job, JobDetail, JobStatus } from "@/api"
import { API_BASE } from "@/api"
import type { IconName } from "@/components/icons"

export { MACHINE_DOWN_MS, machineDown, stuckJobs } from "@/lib/stuck-jobs"

// Words and grouping for the agent screens. Pure, so the three screens (home, one agent,
// Settings › Machines) say the same thing about the same agent.

/** The agents a person sees: never the hidden row an imported paper keeps for itself. */
export const rosterOf = <A extends Agent>(agents: A[]): A[] => agents.filter((a) => !a.managed)

export const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? ""

export const firstName = (name: string | null | undefined): string | null =>
  name?.trim().split(/\s+/)[0] || null

/** A runner that pulled work in the last two minutes is on (it polls every few seconds). */
const ONLINE_MS = 120_000

export type MachineMark = { label: string; on: boolean }

/** Where an agent's jobs run, in words, and whether that machine is answering. */
export function machineOf(
  agent: Pick<Agent, "machine" | "seen_at" | "created_by">,
  names: Map<string, string>,
): MachineMark {
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
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** A cron field as the numbers it names, in the order written: null for "*", undefined for a
 *  shape these screens do not read (steps, names). */
function cronField(field: string, max: number): number[] | null | undefined {
  if (field === "*") return null
  const out: number[] = []
  for (const part of field.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part)
    if (!m) return undefined
    const a = Number(m[1])
    const b = m[2] === undefined ? a : Number(m[2])
    if (a > max || b > max || b < a) return undefined
    for (let i = a; i <= b; i++) out.push(i)
  }
  return out.length ? out : undefined
}

const joinAnd = (items: string[]): string =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`

/** "September to February" for a run of months, else the months named. */
function monthSpan(months: number[]): string {
  const run = months.every((m, i) => i === 0 || m === ((months[i - 1] ?? 0) % 12) + 1)
  const name = (m: number) => MONTHS[m - 1] ?? String(m)
  if (run && months.length > 1) return `${name(months[0] ?? 1)} to ${name(months.at(-1) ?? 1)}`
  return months.map((m) => name(m).slice(0, 3)).join(", ")
}

/** The parts of a cron these screens can read: one minute, hours, days of the week, months.
 *  Null for a shape they cannot. */
export function cronParts(cron: string): {
  minute: number
  hours: number[] | null
  days: number[] | null
  months: number[] | null
} | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string]
  if (dom !== "*" || !/^\d+$/.test(m) || Number(m) > 59) return null
  const hours = cronField(h, 23)
  const days = cronField(dow, 7)
  const months = cronField(mon, 12)
  if (hours === undefined || days === undefined || months === undefined) return null
  // Sunday is 0 or 7; a list reads in calendar order whatever order it was written in.
  const week = days ? [...new Set(days.map((d) => d % 7))].sort((a, b) => a - b) : null
  return { minute: Number(m), hours, days: week, months }
}

/** A cron line in words for the common shapes; the cron itself otherwise. */
export function cronLabel(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string]
  if (dom !== "*") return cron
  const step = /^\*\/(\d+)$/.exec(m)
  if (step && h === "*" && dow === "*" && mon === "*") return `Every ${step[1]} min`
  if (/^\d+$/.test(m) && h === "*" && dow === "*" && mon === "*") return "Hourly"
  const read = cronParts(cron)
  if (!read || !read.hours) return cron
  const minute = String(read.minute).padStart(2, "0")
  const at = joinAnd(read.hours.map((x) => `${x}:${minute}`))
  const week = read.days?.join(",")
  const days =
    !read.days || week === "0,1,2,3,4,5,6"
      ? "Every day"
      : week === "1,2,3,4,5"
        ? "Weekdays"
        : read.days.length === 1
          ? DAYS[read.days[0] ?? 0]
          : read.days.map((d) => DAY_SHORT[d]).join(", ")
  if (!days) return cron
  return `${days} ${at}${read.months ? `, ${monthSpan(read.months)}` : ""}`
}

/** The wall-clock parts of an instant in a time zone. */
function wallClock(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(at)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: DAY_SHORT.indexOf(get("weekday")),
  }
}

/** The zone's offset from UTC at an instant, in ms, read off the clock it shows then. */
const offsetAt = (zone: string, at: Date): number => {
  const w = wallClock(at, zone)
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - at.getTime()
}

/** When a schedule next fires, for the shapes cronLabel reads; null for any other. Days are
 *  walked by their midday so a clock change never skips one, and a wall time becomes an
 *  instant with the offset in force at that instant (read twice, so a change in the night
 *  before lands too). A wall time a spring-forward skips fires when the clock next exists. */
export function nextRun(cron: string, tz: string | null, now: Date = new Date()): Date | null {
  const read = cronParts(cron)
  if (!read) return null
  const zone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const hours = read.hours ?? Array.from({ length: 24 }, (_, i) => i)
  try {
    const start = wallClock(now, zone)
    const noon = Date.UTC(start.year, start.month - 1, start.day, 12)
    for (let offset = 0; offset <= 400; offset++) {
      const wall = wallClock(new Date(noon + offset * 86_400_000), zone)
      if (read.months && !read.months.includes(wall.month)) continue
      if (read.days && !read.days.includes(wall.weekday)) continue
      for (const hour of hours) {
        const wallUtc = Date.UTC(wall.year, wall.month - 1, wall.day, hour, read.minute)
        const first = wallUtc - offsetAt(zone, new Date(wallUtc))
        let instant = new Date(wallUtc - offsetAt(zone, new Date(first)))
        // A wall time the clock skips (2:00 on a spring-forward day) fires when the clock
        // next exists, an hour on.
        if (wallClock(instant, zone).hour !== hour)
          instant = new Date(instant.getTime() + 3_600_000)
        if (instant.getTime() > now.getTime()) return instant
      }
    }
  } catch {
    return null
  }
  return null
}

/** "today 16:00", "tomorrow 4:00", "Oct 27 9:00": a coming instant, in the viewer's clock. */
export function whenNext(at: Date, now: Date = new Date()): string {
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  if (at.toDateString() === now.toDateString()) return `today ${time}`
  if (at.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`
}

/** The zone's short name ("EDT") when it is not the viewer's own; null when it is. */
export function zoneLabel(tz: string | null): string | null {
  if (!tz || tz === Intl.DateTimeFormat().resolvedOptions().timeZone) return null
  try {
    return (
      new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
        .formatToParts(new Date())
        .find((p) => p.type === "timeZoneName")?.value ?? null
    )
  } catch {
    return null
  }
}

/** An agent's enabled schedules. */
export const schedulesOf = (triggers: AgentTrigger[] | undefined): AgentTrigger[] =>
  (triggers ?? []).filter((t) => t.kind === "schedule" && t.enabled && t.cron)

/** An agent that runs on a clock or an event. Its page leads with what it is waiting on, not
 *  an ask box: nobody asks it for things, the schedule does. */
export const isScheduled = (triggers: AgentTrigger[] | undefined): boolean =>
  (triggers ?? []).some((t) => t.enabled && (t.kind !== "schedule" || !!t.cron))

/** "Today", "Yesterday", "Oct 21": the day a run belongs to, in the viewer's clock. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return "Today"
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday"
  return when(iso)
}

/** "04:00": the clock time of an instant, for the left edge of a run row. */
export const clockOf = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })

const PULL_REQUEST = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:pull|issues)\/(\d+)\b/

/** What a task is about, as a row's title: a GitHub link reads as repo#N, anything else as
 *  the first line of what was asked. */
export function jobSubject(job: Pick<Job, "instruction">): string {
  const line = firstLine(job.instruction)
  const pr = PULL_REQUEST.exec(line)
  return pr ? `${pr[2]}#${pr[3]}` : line
}

/** "$3.29": a job's estimated spend across its runs, or null when nothing was measured. */
export function jobSpend(job: Job): string | null {
  const runs = job.result.runs ?? []
  const known = runs
    .map((r) => r.model_cost_micro_usd ?? r.harness_estimate_micro_usd ?? r.api_estimate_micro_usd)
    .filter((n): n is number => typeof n === "number")
  if (!known.length) return null
  const dollars = known.reduce((a, b) => a + b, 0) / 1_000_000
  return dollars < 0.01 ? "<$0.01" : `$${dollars.toFixed(2)}`
}

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
  job.result.failure?.reason ?? (job.status === "lost" ? "No reply came back" : null)

/** A job's title: the schedule that opened it, else the first line of what was asked. */
export function jobTitle(job: Job, triggers: AgentTrigger[] | undefined): string {
  if (job.trigger_id) {
    const t = (triggers ?? []).find((x) => x.id === job.trigger_id)
    return t?.cron ? cronLabel(t.cron) : "Scheduled run"
  }
  return firstLine(job.instruction)
}

/** What a run did, as the title of its row on a scheduled agent's page: the runner's one line
 *  when it left one, else what stopped it. */
export function runTitle(job: Job): string {
  switch (job.status) {
    case "needs_you":
      return "Asked you"
    case "cancelled":
      return job.result.superseded_by ? "Asked the same question again" : "Stopped"
    case "failed":
    case "lost":
      return failureOf(job) ?? "Failed"
    case "queued":
      return "Waiting"
    case "running":
      return "Running"
    default:
      return job.result.summary || job.result.effects?.[0]?.label || "Done"
  }
}

/** The grey line after a settled task's title: the runner's summary, else what stopped it. */
export function jobOutcome(job: Job): string | undefined {
  switch (job.status) {
    case "needs_you":
      return job.needs?.question
    case "cancelled":
      return job.result.superseded_by ? "Superseded by a later run" : "Stopped"
    case "failed":
    case "lost":
      return failureOf(job) ?? undefined
    case "succeeded":
      return job.result.summary || job.result.effects?.[0]?.label
    default:
      return undefined
  }
}

/** The one grey line after a job's title: its outcome, or what it is waiting on. */
export function jobDetail(job: Job): string | undefined {
  switch (job.status) {
    case "needs_you":
      return job.needs?.question
    case "failed":
    case "lost":
      return failureOf(job) ?? undefined
    case "cancelled":
      return job.result.superseded_by ? "Superseded by a later run" : "Cancelled"
    case "queued":
      return "Waiting"
    case "succeeded":
      return job.result.effects?.[0]?.label
    default:
      return undefined
  }
}

/** "Asked 4 times since Oct 9": how long a schedule has been asking the same thing. */
export function askedLine(job: Job): string | null {
  const n = job.needs?.asked_times ?? 1
  if (n < 2) return null
  const since = job.needs?.first_asked_at
  return since ? `Asked ${n} times since ${when(since)}` : `Asked ${n} times`
}

/** "Your machine" for the viewer's own; "Rob's machine" for a teammate's. */
export const machineName = (
  owner: string | null,
  names: Map<string, string>,
  meId: string | undefined,
): string => (owner && owner === meId ? "Your machine" : ownerMachineName(owner, names))

/** A machine's state in words: "On", "Off since Sep 30", "Never connected". */
export const machineState = (seenAt: string | null, now: number = Date.now()): string => {
  if (!seenAt) return "Never connected"
  return now - new Date(seenAt).getTime() < ONLINE_MS ? "On" : `Off since ${when(seenAt)}`
}

export type MachineGroup<A extends Agent = Agent> = {
  /** The creator whose machine runs these agents; null when the creator left. */
  owner: string | null
  agents: A[]
  /** The machine's freshest check-in across its agents. */
  seenAt: string | null
}

/** The Agents home, grouped by where agents run. Needs-you rows are per JOB (each one is a
 *  question a person answers). Then every agent sits in exactly one group: Derive, one group
 *  per owner's machine (the viewer's first), and "not set up" for owner-machine agents whose
 *  runner has never checked in. */
export function groupAgents<A extends Agent>(
  agents: A[],
  openJobs: Job[],
  recentJobs: Job[],
  meId: string | undefined,
): {
  needs: { job: Job; agent: A }[]
  derive: A[]
  machines: MachineGroup<A>[]
  notSetUp: A[]
  lastWorked: Map<string, string>
  running: Map<string, Job[]>
  waiting: Map<string, Job[]>
} {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const needs = openJobs
    .filter((j) => j.status === "needs_you" && byId.has(j.agent_id))
    .flatMap((job) => {
      const agent = byId.get(job.agent_id)
      return agent ? [{ job, agent }] : []
    })
  const running = new Map<string, Job[]>()
  const waiting = new Map<string, Job[]>()
  for (const j of openJobs) {
    if (j.status === "running") running.set(j.agent_id, [...(running.get(j.agent_id) ?? []), j])
    if (j.status === "queued") waiting.set(j.agent_id, [...(waiting.get(j.agent_id) ?? []), j])
  }
  const lastWorked = new Map<string, string>()
  for (const j of [...openJobs, ...recentJobs]) {
    const at = j.finished_at ?? j.started_at ?? j.created_at
    const prev = lastWorked.get(j.agent_id)
    if (!prev || at > prev) lastWorked.set(j.agent_id, at)
  }
  const recent = (a: A) => lastWorked.get(a.id) ?? a.seen_at ?? a.created_at
  const byRecent = (x: A, y: A) => recent(y).localeCompare(recent(x))
  const derive = agents.filter((a) => a.machine === "derive").sort(byRecent)
  const notSetUp = agents.filter((a) => a.machine === "owner" && !a.seen_at).sort(byRecent)
  const byOwner = new Map<string | null, A[]>()
  for (const a of agents)
    if (a.machine === "owner" && a.seen_at)
      byOwner.set(a.created_by, [...(byOwner.get(a.created_by) ?? []), a])
  const machines: MachineGroup<A>[] = [...byOwner]
    .map(([owner, list]) => ({
      owner,
      agents: list.sort(byRecent),
      seenAt: list.reduce<string | null>(
        (best, a) => (a.seen_at && (!best || a.seen_at > best) ? a.seen_at : best),
        null,
      ),
    }))
    .sort((x, y) =>
      x.owner === meId ? -1 : y.owner === meId ? 1 : (y.seenAt ?? "").localeCompare(x.seenAt ?? ""),
    )
  return { needs, derive, machines, notSetUp, lastWorked, running, waiting }
}

/** The line that starts an owner-machine agent's runner, given its key. The same shape the
 *  API returns as `runner_command` when the agent is created. */
export function runnerCommand(agentId: string, key: string): string {
  const server = API_BASE || (typeof window === "undefined" ? "" : window.location.origin)
  return `DERIVE_TOKEN=${key} npx -y @derive-to/cli runner serve --agent ${agentId} --server ${server}`
}

/** Account defaults and custom IDs stay available; named choices are shared by setup. */
export const modelChoices = (provider: Agent["provider"]) =>
  provider === "claude-code"
    ? [
        { id: "opus", label: "Opus (newest)" },
        { id: "sonnet", label: "Sonnet (newest)" },
        { id: "haiku", label: "Haiku (newest)" },
      ]
    : [
        { id: "gpt-6-luna", label: "Luna · lower cost" },
        { id: "gpt-6.1-sol", label: "Sol · complex work" },
      ]

/** What an action in a turn's activity was, in words. */
export const EVENT_LABELS: Record<string, string> = {
  command_execution: "Ran",
  file_change: "Changed",
  mcp_tool_call: "Used",
  web_search: "Searched",
  plan_update: "Updated its plan",
  tool_use: "Used",
}

type JobEvent = NonNullable<JobDetail["events"]>[number]
export const eventLine = (event: JobEvent) =>
  event.label
    ? `${EVENT_LABELS[event.kind] ?? "Worked"} ${event.label}`
    : (EVENT_LABELS[event.kind] ?? "Worked on this task")

/** The grey line under an open job: what it is waiting on, in words, or how it ended. */
export function detailOf(
  job: Job,
  agent: Agent,
  names: Map<string, string> = new Map(),
  meId?: string,
): string | undefined {
  if (job.status === "needs_you") return job.needs?.question
  if (job.status === "failed" || job.status === "lost") return failureOf(job) ?? undefined
  if (job.status === "cancelled") return "Stopped before completion"
  if (job.status === "queued" && agent.runtime?.phase === "creating")
    return "Preparing its first sandbox. This can take a few minutes."
  if (job.status === "queued" && agent.runtime?.phase === "provisioning")
    return "Installing its tools. Your task starts when setup finishes."
  if (job.status === "queued" && agent.runtime?.phase === "stopping")
    return "Saving the sandbox so it is ready for your task."
  if (job.status === "queued" && agent.runtime?.phase === "failed")
    return "Sandbox setup did not finish. Derive will try again."
  if (job.status === "queued" && agent.paused) return "Resume this agent in Settings to start"
  if (job.status === "queued" && agent.machine === "owner" && !machineOf(agent, names).on) {
    const machine = machineName(agent.created_by, names, meId).replace(/^Your/, "your")
    return agent.seen_at
      ? `Waiting for ${machine}, off since ${when(agent.seen_at)}`
      : `Waiting for ${machine}, never connected`
  }
  if (job.status === "queued") return "Waiting for its turn"
  if (job.status === "running" && job.machine_waiting)
    return `Waiting to start: ${job.machine_waiting}`
  if (job.status === "running" && job.machine_phase === "creating")
    return "Building its own machine from the agent's image…"
  if (job.status === "running" && job.machine_phase === "provisioning")
    return "Setting up its machine. The first start takes a minute or two."
  if (job.status === "running" && job.machine_phase === "starting") return "Waking its machine…"
  if (job.status === "running" && ["ready", "launching"].includes(job.machine_phase ?? ""))
    return "Starting the task…"
  if (job.status === "running" && job.machine_phase === "stopping") return "Saving its files…"
  if (job.status === "succeeded" && job.machine_phase === "stopping")
    return "Your result is ready. Stopping compute and collecting its receipt."
  if (job.machine_phase === "parked")
    return job.task.session
      ? "Paused with its files kept. Attach to pick it up where it left off."
      : "Its machine is paused with the files kept, ready for a follow-up."
  if (job.status === "succeeded") return job.result.effects?.[0]?.label
  return undefined
}
