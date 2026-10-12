import {
  type AgentRecord,
  type JobRecord,
  type MembershipRecord,
  type MetaStore,
  roleAllows,
} from "@derive/core"
import type { Backplane } from "../bus"
import type { RuntimeConfig } from "./runtime-setup"

export interface JobDeps {
  meta: MetaStore
  cloud?: { secret?: string; config?: RuntimeConfig }
  bus?: Pick<Backplane, "publish">
  /** Is this agent a graph (its instructions page holds a workflow)? Its work opens as `graph`
   *  jobs the server walks. Absent: never (a caller with no page store). */
  isGraph?: (agent: AgentRecord) => Promise<boolean>
  /** Tell the people a job concerns that it needs them or finished (lib/notify-job.ts). Called
   *  once per transition, after the status-guarded write that made it landed; `actorId` is the
   *  person whose own action caused it, who is not told. Absent: nobody is told. */
  announce?: (job: JobRecord, actorId?: string | null) => Promise<void>
}

// ---- Who may ask -------------------------------------------------------------------------

/** One policy for detail reads and the roster's batched membership read. */
export const agentAccess = (
  agent: AgentRecord,
  member: MembershipRecord | null,
  caller?: Pick<AgentRecord, "id" | "role" | "org_id"> | null,
) => {
  if (!member || member.org_id !== agent.org_id) return { can_ask: false, can_manage: false }
  const creator = agent.created_by === member.user_id
  return {
    can_ask:
      (!caller || (caller.org_id === agent.org_id && roleAllows(caller.role, "publish"))) &&
      agent.managed !== 1 &&
      (agent.ask_policy === "workspace" || creator || member.role === "owner"),
    can_manage:
      (member.role === "owner" || (creator && member.role !== "viewer")) &&
      (!caller ||
        (caller.id.startsWith("oauth:") &&
          caller.org_id === agent.org_id &&
          (roleAllows(caller.role, "manage") || (roleAllows(caller.role, "publish") && creator)))),
  }
}

/** A person may ask an agent when they are a member of its workspace and the agent's ask
 *  policy lets them: `workspace` lets every member ask; `invited` lets the agent's creator
 *  and workspace owners ask. */
export const canAskAgent = async (
  meta: MetaStore,
  agent: AgentRecord,
  userId: string,
  caller?: Pick<AgentRecord, "id" | "role" | "org_id"> | null,
): Promise<boolean> => {
  const m = await meta.getMembership(agent.org_id, userId).catch(() => null)
  return agentAccess(agent, m, caller).can_ask
}

/** A person may manage an agent (edit, pause, triggers, delete) when they created it or own
 *  the workspace. */
export const canManageAgent = async (
  meta: MetaStore,
  agent: AgentRecord,
  userId: string,
): Promise<boolean> => {
  // Both doors need a live seat: a creator who has left the workspace manages nothing.
  const m = await meta.getMembership(agent.org_id, userId).catch(() => null)
  return agentAccess(agent, m).can_manage
}

/** A person may act on a job (follow up, cancel, retry, answer) when they asked it or manage
 *  its agent. Seeing a job is wider (every member); steering someone else's is not. */
export const canSteerJob = async (
  meta: MetaStore,
  agent: AgentRecord,
  job: JobRecord,
  userId: string,
  caller?: Pick<AgentRecord, "id" | "role" | "org_id"> | null,
): Promise<boolean> => {
  const access = agentAccess(agent, await meta.getMembership(agent.org_id, userId), caller)
  return (job.asked_by === userId && access.can_ask) || access.can_manage
}

/** Whose jobs are a person's to act on (the Inbox): the ones they asked, or on agents they
 *  manage (canManageAgent's rule, read with one membership lookup). `"all"` for a workspace
 *  owner, who manages every agent; null for someone with no seat here. */
export const inboxScope = async (
  meta: MetaStore,
  orgId: string,
  userId: string,
): Promise<"all" | { askedBy: string; agentIds: string[] } | null> => {
  const seat = await meta.getMembership(orgId, userId).catch(() => null)
  if (!seat) return null
  if (seat.role === "owner") return "all"
  const own =
    seat.role === "viewer"
      ? []
      : (await meta.listAgents(orgId)).filter((a) => a.created_by === userId)
  return { askedBy: userId, agentIds: own.map((a) => a.id) }
}
