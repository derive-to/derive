import {
  type AccountRecord,
  type AgentRecord,
  type ExecutionProvider,
  type JobRecord,
  type MetaStore,
  WORKSPACE_ACCOUNT_OWNER,
} from "@derive/core"
import { decryptSecret } from "./crypto"
import { fallbackPayerTiers } from "./payer"

// WHICH MODEL ACCOUNT A JOB RUNS WITH, resolved once for every runner.
//
// In order: the account assigned to the agent, the asker's own account for that provider,
// the workspace pool. Until the cutover migrates stored credentials into `model_account`, the
// legacy tiers (the asker's model plan, an owner-lent plan, the pool plan) follow, so runners
// that work today keep working.

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
  const tryAccount = (a: AccountRecord | undefined, source: string): JobCredential | null => {
    if (!a || a.provider !== want || !a.secret_enc || a.kind === "ortam_signin") return null
    const value = readable(a.secret_enc, key)
    if (value === null) {
      sawUnreadable = true
      return null
    }
    return { credential: { kind: a.kind, value }, source }
  }
  const assigned = tryAccount(
    accounts.find((a) => a.id === agent.account_id),
    "agent",
  )
  if (assigned) return assigned
  if (job.asked_by) {
    const mine = tryAccount(
      accounts.find((a) => a.user_id === job.asked_by && a.provider === want),
      "asker",
    )
    if (mine) return mine
  }
  const pool = tryAccount(
    accounts.find((a) => a.user_id === WORKSPACE_ACCOUNT_OWNER && a.provider === want),
    "pool",
  )
  if (pool) return pool

  // Legacy tiers, removed at cutover.
  const tiers = [
    ...(job.asked_by ? [{ userId: job.asked_by, source: "asker" }] : []),
    ...(await fallbackPayerTiers(meta, agent.org_id, agent.id, agent.created_by)),
  ]
  for (const { userId, source } of tiers) {
    const cred = await meta.getModelCredential(agent.org_id, userId, provider)
    if (!cred) continue
    const value = readable(cred.secret, key)
    if (value === null) {
      sawUnreadable = true
      continue
    }
    return { credential: { kind: cred.kind, value }, source }
  }
  return { credential: null, reason: sawUnreadable ? "unreadable" : "none" }
}
