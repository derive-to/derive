import type { ContextRecord, MetaStore } from "@derive/core"
import { newId } from "@derive/core"
import { mintToken, sha256 } from "./crypto"

// The one place that mints a managed agent and wires it to a manifest as a context —
// the create_context branch of the automate tool (mcp-tools/automate.ts) and the
// guided context builder both call this. The REST create route (routes/contexts.ts)
// has its own inline copy (it also supports agent_id and connection_ids, and returns
// the token over the wire) and is not refactored onto this helper in this change; the
// recipe below must stay byte-identical to both so a workspace can't tell which door a
// context came through.

export interface CreateContextCoreInput {
  orgId: string
  userId: string
  name: string
  /** Internal artifact id (not the short_id) of the manifest to wire. */
  manifestArtifactId: string
  maxRunMs?: number
  maxConcurrency?: number
}

export interface CreateContextCoreResult {
  context: ContextRecord
  agentId: string
  /** Present so the HTTP route can keep returning it once; the builder and automate
   *  discard it — an MCP transcript / builder transcript is a bad place for a
   *  standing secret. */
  agentToken: string
}

/** Mint a managed agent for `name` and wire it to `manifestArtifactId` as a new
 *  context. Agent names are unique per workspace, so a name collision with an
 *  existing agent suffixes a 4-char id and retries once — mirroring the REST
 *  create route (routes/contexts.ts) and automate.ts's `create_context` action.
 *  A name collision on the CONTEXT itself (after the agent is already minted)
 *  unwinds the mint before rethrowing, so a failed create never strands an
 *  orphaned managed agent with a live token. */
export const createContextCore = async (
  meta: MetaStore,
  input: CreateContextCoreInput,
): Promise<CreateContextCoreResult> => {
  const agentToken = mintToken("dk_agt")
  const mint = (name: string) =>
    meta.createAgent({
      id: newId("ag"),
      org_id: input.orgId,
      name,
      token: sha256(agentToken),
      role: "editor",
      created_by: input.userId,
      managed: 1,
    })
  const minted = await mint(input.name).catch(() => mint(`${input.name} ${newId("x").slice(-4)}`))
  try {
    const context = await meta.createContext({
      id: newId("ctx"),
      org_id: input.orgId,
      name: input.name,
      agent_id: minted.id,
      manifest_artifact_id: input.manifestArtifactId,
      created_by: input.userId,
      max_run_ms: input.maxRunMs ?? null,
      ...(input.maxConcurrency ? { max_concurrency: input.maxConcurrency } : {}),
    })
    return { context, agentId: minted.id, agentToken }
  } catch (err) {
    // A name-collision after the auto-mint must not strand an orphaned managed agent.
    await meta.deleteAgent(minted.id, input.orgId).catch(() => {})
    throw err
  }
}
