import type { MetaStore } from "@derive/core"
import { brokerFor, type RunTool, toolsForRun } from "./broker"

/**
 * THE CONNECTIONS A CONVERSATION MAY REACH, and their tools — resolved on demand.
 *
 * A packaged run declares its own connections, so a Stripe-bound run sees Stripe tools and
 * nothing else. A conversation declares nothing: somebody types a sentence and the agent
 * decides what to do. `chatSources` is the missing declaration, made once by whoever owns the
 * credential, and this module is the ONE place it is enforced — both discovery and invocation
 * go through `boundSources`, so a connection nobody declared is not merely un-listed, it is
 * unreachable.
 *
 * ON DEMAND, never in the prompt. MCP tool definitions are large and the chat surface has a
 * size budget that has already forced trimming; declaring every tool of every connected server
 * would blow it outright. So the turn reads an index, reads one catalog, and calls — the shape
 * the skills index already uses for procedure, applied to tool schemas.
 */

/** The declared, still-live connections for this workspace. Intersects the admin's list with
 *  what actually exists: a connection deleted after being declared simply is not there. */
export const boundSources = async (
  meta: MetaStore,
  orgId: string,
  askerId: string | null,
): Promise<{ id: string; toolkit: string; kind: string; scope: string }[]> => {
  const settings = await meta.getOrgSettings(orgId).catch(() => null)
  const declared = settings?.chatSources ?? []
  if (declared.length === 0) return []
  const live = await meta.listConnections(orgId).catch(() => [])
  return (
    live
      .filter((c) => declared.includes(c.id))
      // SCOPE DECIDES WHO, the declaration decides WHETHER. A workspace connection is the team's
      // and reaches everyone's chat; a PERSONAL one is one person's credential and reaches only
      // theirs — declaring it must not lend somebody else's Stripe to the whole team. Without
      // this filter the declaration alone would do exactly that, silently, and the borrower would
      // never know whose account answered.
      .filter((c) => c.scope === "workspace" || c.user_id === askerId)
      .map((c) => ({ id: c.id, toolkit: c.toolkit, kind: String(c.kind), scope: c.scope }))
  )
}

/** The tools one declared connection offers. Empty for anything not declared — the refusal is
 *  here rather than at the call site, so a new caller cannot forget it. */
export const sourceTools = async (
  meta: MetaStore,
  orgId: string,
  ownerUserId: string | null,
  encryptionKey: string | undefined,
  connectionId: string,
): Promise<RunTool[]> => {
  const bound = await boundSources(meta, orgId, ownerUserId)
  if (!bound.some((s) => s.id === connectionId)) return []
  const broker = await brokerFor(meta, orgId, ownerUserId, encryptionKey)
  return await toolsForRun(meta, broker, orgId, [connectionId], undefined, encryptionKey)
}
