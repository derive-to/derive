/**
 * Per-run capability tokens — the unattended-execution credential.
 *
 * A hosted run (a Cloudflare Container, a Node child process, any substrate) must act as its
 * automation's agent to claim, pull, write, and finish — but managed-agent tokens are shown once
 * and stored only as a hash, so no hosted process can re-read one. Instead of storing a standing
 * secret, dispatch MINTS a token per run: signed, scoped to exactly one (run, agent, workspace),
 * and expiring on its own. agentFor resolves it to the same agent principal a registered token
 * would (so the write path needs no changes), and the run endpoints additionally pin it to ITS
 * run — a leaked token is a bounded liability: one agent, one workspace, one run, minutes.
 *
 * A thin wrapper over lib/capability-token.ts (the HMAC format publish/upload tokens share),
 * with a `dkrun_` prefix so bearer resolution can route it without trial verification.
 */
import { signCapabilityToken, verifyCapabilityToken } from "./capability-token"
import { RUN_TOKEN_TTL_MS } from "./run-lifecycle"

const DOMAIN = "derive-run-token:"
const PREFIX = "dkrun_"

// The TTL belongs to the run lifecycle clock (run-lifecycle.ts), not to this file: it must
// EXCEED the run timeout so an honest run can still write its result, and fall SHORT of the
// reclaim lease so a requeued run's previous executor is provably powerless before a second
// one starts. Re-exported here for the token's callers.
export { RUN_TOKEN_TTL_MS }

export const isRunToken = (bearer: string): boolean => bearer.startsWith(PREFIX)

/** Sign a run capability token for one (run, agent, workspace). */
export const signRunToken = async (
  secret: string,
  runId: string,
  agentId: string,
  orgId: string,
  expEpochMs: number,
): Promise<string> =>
  `${PREFIX}${await signCapabilityToken(DOMAIN, secret, [runId, agentId, orgId], expEpochMs)}`

/** Verify a run token: the (run, agent, workspace) it authorizes, or null (bad signature,
 *  malformed, expired). Never throws. */
export const verifyRunToken = async (
  secret: string,
  token: string,
  nowMs: number,
): Promise<{ runId: string; agentId: string; orgId: string } | null> => {
  if (!token.startsWith(PREFIX)) return null
  const claim = await verifyCapabilityToken(DOMAIN, secret, token.slice(PREFIX.length), nowMs)
  if (!claim) return null
  // Payload: `<runId>.<agentId>.<orgId>` — all three id kinds are dot-free.
  const parts = claim.rest.split(".")
  if (parts.length !== 3) return null
  const [runId, agentId, orgId] = parts
  if (!runId || !agentId || !orgId) return null
  return { runId, agentId, orgId }
}
