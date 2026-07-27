import type { MetaStore } from "@derive/core"

/**
 * WHO PAYS for a run or an ask — one definition, used at both ends.
 *
 * There are two moments that need this answer and they must never disagree. The EXECUTOR asks
 * it when a run is already in flight (routes/model-credentials.ts), and fails closed if nobody
 * pays. The ENQUEUE path asks it before creating work at all, so a workspace with no credential
 * gets a clear refusal instead of a container that boots, discovers the same thing, and bills
 * container time to say so.
 *
 * If those two resolutions drift, both failure modes are bad: a preflight that is stricter than
 * the executor refuses work that would have run, and one that is looser queues work that cannot.
 * So the tier list lives here and both callers import it.
 *
 * The tiers, in order:
 *   1. INITIATOR — whoever caused this work. The asker of a session, the `initiated_by` of a
 *      run. Their plan, their bill.
 *   2. OWNER — the agent's registrant, and only when the workspace has explicitly lent that
 *      agent their plan (org_settings.ownerLendAgents). Opt-in, per agent, off by default.
 *   3. POOL — a workspace-level credential stored against a sentinel user, for work with no
 *      person behind it (a clock, an event) or a person who has connected nothing.
 *
 * A tier counts as payable when it holds ANY model credential. The stored kinds are api_key,
 * oauth and login, and each is a legitimate way to pay, so presence is what is checked — not a
 * particular shape. The executor still resolves the specific provider and decrypts, which is
 * where an unreadable secret is caught; this is a "can anyone pay at all" question.
 */

/** The sentinel user a workspace-level (pool) credential is stored against. */
export const POOL_USER = "__workspace_pool__"

/** Which tier paid, for messages and telemetry. */
export type PayerSource = "initiator" | "asker" | "owner" | "pool"

export interface Payer {
  userId: string
  source: PayerSource
}

/** The tiers AFTER the initiator — owner-lend, then the workspace pool. Shared so the executor
 *  path and the enqueue preflight can't drift on who else may pay. */
export const fallbackPayerTiers = async (
  meta: MetaStore,
  orgId: string,
  agentId: string,
  agentCreatedBy: string | null,
): Promise<Payer[]> => {
  const out: Payer[] = []
  if (agentCreatedBy) {
    const settings = await meta.getOrgSettings(orgId)
    if (settings.ownerLendAgents?.includes(agentId))
      out.push({ userId: agentCreatedBy, source: "owner" })
  }
  out.push({ userId: POOL_USER, source: "pool" })
  return out
}

/** The full ordered chain for a piece of work, initiator first when there is one. */
export const payerChain = async (
  meta: MetaStore,
  input: { orgId: string; agentId: string; agentCreatedBy: string | null; initiator: Payer | null },
): Promise<Payer[]> => [
  ...(input.initiator ? [input.initiator] : []),
  ...(await fallbackPayerTiers(meta, input.orgId, input.agentId, input.agentCreatedBy)),
]

/**
 * The FIRST tier that holds a credential, or null when nothing in the chain can pay.
 *
 * Deliberately provider-agnostic. At enqueue nobody has chosen a provider yet — the executor
 * picks one from its own configuration — so requiring a specific one here would refuse a
 * workspace that has connected Codex because the question happened to be asked about Claude.
 */
export const findPayer = async (
  meta: MetaStore,
  input: { orgId: string; agentId: string; agentCreatedBy: string | null; initiator: Payer | null },
): Promise<Payer | null> => {
  for (const tier of await payerChain(meta, input)) {
    const creds = await meta.listModelCredentials(input.orgId, tier.userId).catch(() => [])
    if (creds.length > 0) return tier
  }
  return null
}

/** What to tell someone whose work cannot be paid for. Names every option that would fix it,
 *  because "no model plan connected" alone does not say whose, or what would count. */
export const NO_PAYER_MESSAGE =
  "no model plan is connected for this work, so it would fail as soon as it ran. " +
  "Connect one in Settings → Model plans (an API key, an OAuth connection, or a CLI login all " +
  "count), or have the workspace add a shared plan, or lend this agent the owner's plan."
