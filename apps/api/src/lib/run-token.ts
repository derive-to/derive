/**
 * Per-JOB capability tokens: the credential a Derive machine runs one job with.
 *
 * A job dispatched to a Derive machine (an Ortam sandbox) must act as its agent to fetch its
 * environment and account, write, and report, but agent keys are shown once and stored only as
 * a hash, so no hosted process can re-read one. Instead dispatch MINTS a token per job: signed,
 * scoped to exactly one (job, agent, workspace), and expiring on its own. agentFor resolves it to
 * the same agent principal a registered key would, and the job routes additionally pin it to ITS
 * job, so a leaked token is a bounded liability: one agent, one workspace, one job, minutes.
 *
 * The `dkjob_` prefix lets bearer resolution route without trial verification. The older
 * `dkrun_`, `dksess_`, `dkwfr_` and `dkattempt_` kinds retired with the lanes that minted them;
 * such a bearer now resolves to nobody.
 *
 * A thin wrapper over lib/capability-token.ts (the HMAC format publish/upload tokens share).
 */
import { signCapabilityToken, verifyCapabilityToken } from "./capability-token"
import { RUN_TOKEN_TTL_MS } from "./run-lifecycle"

/** What a capability token authorizes work on. `job` is a runner's: it acts as the agent on
 *  its one job's routes. `jobtool` is the model's, handed to it so it can call the job's source
 *  tools: it reaches `POST /v1/jobs/<job>/tool` and nothing else (agentFor enforces that). */
export type WorkKind = "job" | "jobtool"

const DOMAIN: Record<WorkKind, string> = {
  job: "derive-job-token:",
  jobtool: "derive-job-tool-token:",
}
const PREFIX: Record<WorkKind, string> = {
  job: "dkjob_",
  jobtool: "dkjtool_",
}

// The TTL belongs to the run lifecycle clock (run-lifecycle.ts), not to this file: it must
// EXCEED the work timeout so an honest job can still write its result, and fall SHORT of the
// reclaim lease so a requeued item's previous executor is provably powerless before a second
// one starts. Re-exported here for the token's callers.
export { RUN_TOKEN_TTL_MS }

/** Which kind of work token this bearer is, or null when it is none (a registered agent
 *  token, an OAuth access token, the static operator bearer). */
export const workTokenKind = (bearer: string): WorkKind | null =>
  bearer.startsWith(PREFIX.job) ? "job" : bearer.startsWith(PREFIX.jobtool) ? "jobtool" : null

/** Sign a capability token for one (work item, agent, workspace). */
export const signWorkToken = async (
  kind: WorkKind,
  secret: string,
  id: string,
  agentId: string,
  orgId: string,
  expEpochMs: number,
): Promise<string> =>
  `${PREFIX[kind]}${await signCapabilityToken(DOMAIN[kind], secret, [id, agentId, orgId], expEpochMs)}`

/** Verify a capability token of a KNOWN kind: the (id, agent, workspace) it authorizes, or null
 *  (wrong kind, bad signature, malformed, expired). Never throws. */
export const verifyWorkToken = async (
  kind: WorkKind,
  secret: string,
  token: string,
  nowMs: number,
): Promise<{ id: string; agentId: string; orgId: string } | null> => {
  if (!token.startsWith(PREFIX[kind])) return null
  const claim = await verifyCapabilityToken(
    DOMAIN[kind],
    secret,
    token.slice(PREFIX[kind].length),
    nowMs,
  )
  if (!claim) return null
  // Payload: `<id>.<agentId>.<orgId>` — all three id kinds are dot-free.
  const parts = claim.rest.split(".")
  if (parts.length !== 3) return null
  const [id, agentId, orgId] = parts
  if (!id || !agentId || !orgId) return null
  return { id, agentId, orgId }
}
