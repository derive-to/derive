import type { Agent, Job } from "@/api"

// Tasks nothing will pick up. Read by the rail's Inbox count and the Inbox page, and by the
// agent screens through pages/agents/format.

/** A runner silent for a day is down, not between polls: its waiting tasks go to the Inbox. */
export const MACHINE_DOWN_MS = 24 * 3_600_000

/** An agent on its owner's machine whose runner has never polled, or not for a day. */
export const machineDown = (
  agent: Pick<Agent, "machine" | "seen_at">,
  now: number = Date.now(),
): boolean =>
  agent.machine === "owner" &&
  (!agent.seen_at || now - new Date(agent.seen_at).getTime() > MACHINE_DOWN_MS)

/** The queued tasks nothing will pick up: their agent's machine is down. */
export const stuckJobs = (jobs: Job[], agents: Agent[], now: number = Date.now()): Job[] => {
  const byId = new Map(agents.map((a) => [a.id, a]))
  return jobs.filter((j) => {
    const agent = byId.get(j.agent_id)
    return j.status === "queued" && !!agent && machineDown(agent, now)
  })
}

/** The list's agents carry `can_manage`; a bare Agent (one agent's page) does not. */
type Roster = Agent & { can_manage?: boolean }

export type StuckRows = {
  /** The viewer's own machines: one row each, holding every agent and task waiting on it. */
  mine: Map<string, { agent: Agent; jobs: Job[] }[]>
  /** Tasks on someone else's machine the viewer asked, or whose agent they manage: one row each. */
  others: { job: Job; agent: Agent }[]
}

/** What the Inbox shows the viewer about stuck tasks, in rows. The rail counts the same rows,
 *  so the badge and the page never disagree. A job the viewer can neither start nor cancel
 *  is left out. */
export const stuckRows = (
  jobs: Job[],
  agents: Roster[],
  meId: string | undefined,
  now: number = Date.now(),
): StuckRows => {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const mine: StuckRows["mine"] = new Map()
  const others: StuckRows["others"] = []
  for (const job of stuckJobs(jobs, agents, now)) {
    const agent = byId.get(job.agent_id)
    if (!agent) continue
    if (meId && agent.created_by === meId) {
      const list = mine.get(meId) ?? []
      const row = list.find((r) => r.agent.id === agent.id)
      if (row) row.jobs.push(job)
      else list.push({ agent, jobs: [job] })
      mine.set(meId, list)
    } else if (job.asked_by === meId || agent.can_manage === true) others.push({ job, agent })
  }
  return { mine, others }
}

export const stuckRowCount = (rows: StuckRows): number => rows.mine.size + rows.others.length
