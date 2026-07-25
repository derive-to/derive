/**
 * Per-WORK capability tokens — the unattended-execution credential.
 *
 * A hosted executor (a Cloudflare Container, a Node child process, any substrate) must act as an
 * agent to claim its work, pull sources, write, and settle — but managed-agent tokens are shown
 * once and stored only as a hash, so no hosted process can re-read one. Instead of storing a
 * standing secret, dispatch MINTS a token per unit of work: signed, scoped to exactly one
 * (work item, agent, workspace), and expiring on its own. agentFor resolves it to the same agent
 * principal a registered token would (so the write path needs no changes), and the work endpoints
 * additionally pin it to ITS item — a leaked token is a bounded liability: one agent, one
 * workspace, one job, minutes.
 *
 * TWO KINDS, ONE MACHINE. A `run` is an automation firing; a `session` is somebody asking a
 * context. They are the same call — (context, instruction) — differing only in what started them,
 * so they get the same credential shape and the same executor. The prefix (`dkrun_` / `dksess_`)
 * lets bearer resolution route without trial verification, and keeps the two scopes from ever
 * being confused for one another: a session token can never claim a run, or vice versa.
 *
 * A thin wrapper over lib/capability-token.ts (the HMAC format publish/upload tokens share).
 */
import { signCapabilityToken, verifyCapabilityToken } from "./capability-token"
import { RUN_TOKEN_TTL_MS } from "./run-lifecycle"

/** What a capability token authorizes work on. */
export type WorkKind = "run" | "session"

const DOMAIN: Record<WorkKind, string> = {
  run: "derive-run-token:",
  session: "derive-session-token:",
}
const PREFIX: Record<WorkKind, string> = { run: "dkrun_", session: "dksess_" }

// The TTL belongs to the run lifecycle clock (run-lifecycle.ts), not to this file: it must
// EXCEED the work timeout so an honest job can still write its result, and fall SHORT of the
// reclaim lease so a requeued item's previous executor is provably powerless before a second
// one starts. Re-exported here for the token's callers.
export { RUN_TOKEN_TTL_MS }

/** Which kind of work token this bearer is, or null when it is neither (a registered agent
 *  token, an OAuth access token, the static operator bearer). */
export const workTokenKind = (bearer: string): WorkKind | null => {
  if (bearer.startsWith(PREFIX.run)) return "run"
  if (bearer.startsWith(PREFIX.session)) return "session"
  return null
}

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
 *  (wrong kind, bad signature, malformed, expired). Never throws. Each kind has its own signing
 *  domain, so a token minted for a session cannot verify as a run even with a matching payload. */
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

// ---- Run-shaped aliases (the original surface, unchanged for its callers) ----

export const isRunToken = (bearer: string): boolean => workTokenKind(bearer) === "run"

export const signRunToken = (
  secret: string,
  runId: string,
  agentId: string,
  orgId: string,
  expEpochMs: number,
): Promise<string> => signWorkToken("run", secret, runId, agentId, orgId, expEpochMs)

export const verifyRunToken = async (
  secret: string,
  token: string,
  nowMs: number,
): Promise<{ runId: string; agentId: string; orgId: string } | null> => {
  const c = await verifyWorkToken("run", secret, token, nowMs)
  return c && { runId: c.id, agentId: c.agentId, orgId: c.orgId }
}
