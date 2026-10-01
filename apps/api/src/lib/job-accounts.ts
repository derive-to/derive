import {
  type AccountRecord,
  type AgentRecord,
  type ExecutionProvider,
  type JobRecord,
  type MetaStore,
  WORKSPACE_ACCOUNT_OWNER,
} from "@derive/core"
import { decryptSecret } from "./crypto"

// WHICH MODEL ACCOUNT A JOB RUNS WITH, resolved once for every runner.
//
// In order: the account assigned to the agent, the asker's own account for that provider,
// the workspace pool. The asker's tier applies only where the asker's secret stays on a machine
// nobody else holds: a Derive machine, or the asker's own agent. On a teammate's `owner`
// machine the job runs on the agent creator's account instead, since whoever runs the job holds
// the credential it runs with. Model accounts are the only source: the older stored model
// plans were carried into accounts at the agents cutover.

export type JobCredential =
  | { credential: { kind: "oauth" | "api_key" | "login"; value: string }; source: string }
  | { credential: null; reason: "none" | "unreadable" | "not_configured" }

const accountProvider = (p: ExecutionProvider): AccountRecord["provider"] =>
  p === "codex" ? "codex" : "claude"

/** A `v1.` secret that decrypts to itself never decrypted (decryptSecret fails open on a
 *  wrong key or a corrupt blob): unreadable, never handed to a runner as a token. */
const readable = (secret: string, key: string): string | null => {
  const value = decryptSecret(secret, key)
  return secret.startsWith("v1.") && value === secret ? null : value
}

export const resolveJobCredential = async (
  meta: MetaStore,
  key: string | undefined,
  agent: AgentRecord,
  job: JobRecord,
  provider: ExecutionProvider,
): Promise<JobCredential> => {
  if (!key) return { credential: null, reason: "not_configured" }
  let sawUnreadable = false
  const want = accountProvider(provider)
  const accounts = await meta.listAccounts(agent.org_id)
  // A personal account pays only while its owner holds a seat in the agent's workspace: a
  // person who has left stops paying for its jobs, whichever tier names their account. The
  // pool belongs to the workspace and has no seat to check.
  const seated = async (a: AccountRecord): Promise<boolean> =>
    a.user_id === WORKSPACE_ACCOUNT_OWNER ||
    !!(await meta.getMembership(agent.org_id, a.user_id).catch(() => null))
  const tryAccount = async (
    a: AccountRecord | undefined,
    source: string,
  ): Promise<JobCredential | null> => {
    if (!a || a.provider !== want || !a.secret_enc || a.kind === "ortam_signin") return null
    if (!(await seated(a))) return null
    const value = readable(a.secret_enc, key)
    if (value === null) {
      sawUnreadable = true
      return null
    }
    return { credential: { kind: a.kind, value }, source }
  }
  const assigned = await tryAccount(
    accounts.find((a) => a.id === agent.account_id),
    "agent",
  )
  if (assigned) return assigned
  const payer =
    job.asked_by && (agent.machine === "derive" || job.asked_by === agent.created_by)
      ? job.asked_by
      : agent.created_by
  if (payer) {
    const mine = await tryAccount(
      accounts.find((a) => a.user_id === payer && a.provider === want),
      payer === job.asked_by ? "asker" : "creator",
    )
    if (mine) return mine
  }
  const pool = await tryAccount(
    accounts.find((a) => a.user_id === WORKSPACE_ACCOUNT_OWNER && a.provider === want),
    "pool",
  )
  if (pool) return pool

  return { credential: null, reason: sawUnreadable ? "unreadable" : "none" }
}
