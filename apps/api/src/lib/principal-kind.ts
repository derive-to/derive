/**
 * Which kind of principal an id names — the one place that knows an agent id's shapes.
 *
 * Agent ids come in exactly three: a registered agent (`ag_…`, minted in routes/agents.ts),
 * an OAuth client or minted API token (`oauth:<clientId>`, context.ts `agentFor`), and the
 * built-in chat agent (DERIVE_AUTHOR_ID). Everything else that names anyone is a person.
 * Records keep the id; readers ask here, so the activity stream can tell an agent's turn
 * from a person's without a directory lookup — and still can after the agent is gone.
 */
import type { MetaStore } from "@derive/core"

export type PrincipalKind = "user" | "agent"

/** The built-in Derive chat agent's principal id — written as a comment's `author_id` and a
 *  version's `agent_id`, and reserved so no directory row can collide with it. */
export const DERIVE_AUTHOR_ID = "derive"
export const DERIVE_AGENT_NAME = "Derive"

export const principalKind = (id: string | null | undefined): PrincipalKind | null =>
  !id
    ? null
    : id === DERIVE_AUTHOR_ID || id.startsWith("ag_") || id.startsWith("oauth:")
      ? "agent"
      : "user"

/** An agent's current display name, from wherever its kind keeps it — the built-in's
 *  constant, an OAuth client's registered name, a registered agent's row. Null when the
 *  id is no agent's, or the agent is gone: the caller falls back to what it recorded. */
export const agentName = async (
  meta: Pick<MetaStore, "getAgent" | "getOAuthClientName">,
  id: string,
): Promise<string | null> => {
  if (id === DERIVE_AUTHOR_ID) return DERIVE_AGENT_NAME
  if (id.startsWith("oauth:"))
    return (await meta.getOAuthClientName(id.slice("oauth:".length))) || null
  if (id.startsWith("ag_")) return (await meta.getAgent(id))?.name ?? null
  return null
}
