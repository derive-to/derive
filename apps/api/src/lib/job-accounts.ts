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

/** What a Claude credential really is, read from its prefix: `claude setup-token` prints an
 *  OAuth token (sk-ant-oat…), the Console issues API keys (sk-ant-api…). The kind decides how
 *  the runner hands it to Claude Code (CLAUDE_CODE_OAUTH_TOKEN vs ANTHROPIC_API_KEY), and a
 *  token under the wrong one fails to sign in, so the prefix wins over what was picked. */
export const credentialKind = (
  provider: AccountRecord["provider"],
  kind: AccountRecord["kind"],
  value: string,
): AccountRecord["kind"] => {
  if (provider !== "claude") return kind
  const v = value.trim()
  if (v.startsWith("sk-ant-oat")) return "oauth"
  if (v.startsWith("sk-ant-api")) return "api_key"
  return kind
}

/** A `v1.` secret that decrypts to itself never decrypted (decryptSecret fails open on a
 *  wrong key or a corrupt blob): unreadable, never handed to a runner as a token. */
const readable = (secret: string, key: string): string | null => {
  const value = decryptSecret(secret, key)
  return secret.startsWith("v1.") && value === secret ? null : value
}

/** Does this person hold a seat in the workspace? A lookup error answers no: a seat that
 *  cannot be confirmed does not spend anyone's key. */
export const hasSeat = async (meta: MetaStore, orgId: string, userId: string): Promise<boolean> =>
  !!(await meta.getMembership(orgId, userId).catch(() => null))

/** Has this agent's creator left its workspace? An owner-machine agent then runs nothing: the
 *  machine and the key it ran on were theirs. A creator-less (legacy) agent has not. */
export const creatorLeft = async (meta: MetaStore, agent: AgentRecord): Promise<boolean> =>
  !!agent.created_by && !(await hasSeat(meta, agent.org_id, agent.created_by))

/** WHO A JOB BILLS, picked the way resolveJobCredential picks its account: the owner of the
 *  account assigned to the agent; else the asker, where the asker's key would be the one used
 *  (a Derive machine, or the asker's own agent); else the agent's creator. Null = the
 *  workspace pool. The budget check reads this at ask, pull, schedule, dispatch and graph
 *  steps alike, so a job accepted at ask is never held later against another person's limit.
 *  On an owner machine the answer never depends on the asker. */
export const jobPayer = async (
  meta: MetaStore,
  agent: AgentRecord,
  askedBy: string | null,
): Promise<string | null> => {
  if (agent.account_id) {
    const acct = await meta.getAccount(agent.account_id).catch(() => null)
    if (acct && acct.org_id === agent.org_id)
      return acct.user_id === WORKSPACE_ACCOUNT_OWNER ? null : acct.user_id
  }
  if (askedBy && (agent.machine === "derive" || askedBy === agent.created_by)) return askedBy
  return agent.created_by ?? null
}

export const resolveJobCredential = async (
  meta: MetaStore,
  key: string | undefined,
  agent: AgentRecord,
  job: JobRecord,
  provider: ExecutionProvider,
): Promise<JobCredential> => {
  if (!key) return { credential: null, reason: "not_configured" }
  // An owner-machine agent whose creator has left runs on nobody's key, not even the pool's.
  if (agent.machine === "owner" && (await creatorLeft(meta, agent)))
    return { credential: null, reason: "none" }
  let sawUnreadable = false
  const want = accountProvider(provider)
  const accounts = await meta.listAccounts(agent.org_id)
  // A personal account pays only while its owner holds a seat in the agent's workspace: a
  // person who has left stops paying for its jobs, whichever tier names their account. The
  // pool belongs to the workspace and has no seat to check.
  const seated = async (a: AccountRecord): Promise<boolean> =>
    a.user_id === WORKSPACE_ACCOUNT_OWNER || (await hasSeat(meta, agent.org_id, a.user_id))
  const tryAccount = async (
    a: AccountRecord | undefined,
    source: string,
  ): Promise<JobCredential | null> => {
    if (!a || a.provider !== want || !a.secret_enc) return null
    if (!(await seated(a))) return null
    const value = readable(a.secret_enc, key)
    if (value === null) {
      sawUnreadable = true
      return null
    }
    // Accounts saved before the kind was inferred: deliver the right kind, and fix the record
    // so the Accounts page says what it is. A failed fix costs nothing; the next job retries.
    const kind = credentialKind(a.provider, a.kind, value)
    if (kind !== a.kind) await meta.updateAccount(a.id, a.org_id, { kind }).catch(() => null)
    return { credential: { kind, value }, source }
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
