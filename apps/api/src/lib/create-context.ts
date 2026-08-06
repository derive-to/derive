import type { ContextRecord, MetaStore } from "@derive/core"
import { newId } from "@derive/core"
import { mintToken, sha256 } from "./crypto"

// Mint a managed agent, wire it to a manifest as a context: the recipe the automate tool's
// create_context action (mcp-tools/automate.ts) and the guided context builder share.
//
// The REST create route (routes/contexts.ts) keeps its own inline copy — it also takes an
// existing agent_id and connection_ids, and hands the minted token back over the wire, so it is
// a superset rather than a caller. That makes this recipe a thing kept in step by hand: a
// workspace must not be able to tell which door a context came through.

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
}

/** Thrown ONLY when the CONTEXT row insert fails (both mint attempts already
 *  succeeded) — the original DB error rides `cause`. This is the one failure a
 *  caller may recast as a friendly "a context with that name already exists".
 *  A mint failure is NOT wrapped and propagates as whatever the store threw, so
 *  a transient or opaque minting failure is never mislabeled as a name collision. */
export class ContextConflictError extends Error {
  constructor(cause: unknown) {
    super("context insert failed", { cause })
    this.name = "ContextConflictError"
  }
}

/** Mint a managed agent for `name` and wire it to `manifestArtifactId` as a new
 *  context. Agent names are unique per workspace, so a name collision with an
 *  existing agent suffixes a 4-char id and retries once — mirroring the REST
 *  create route (routes/contexts.ts). A name collision on the CONTEXT itself
 *  (after the agent is already minted) unwinds the mint and rethrows as
 *  `ContextConflictError`, so a failed create never strands an orphaned managed
 *  agent with a live token. */
export const createContextCore = async (
  meta: MetaStore,
  input: CreateContextCoreInput,
): Promise<CreateContextCoreResult> => {
  // Minted once and only ever hashed: neither caller has anywhere safe to put a standing
  // secret (an MCP tool result, a chat transcript), so it is never handed back. A dedicated
  // runner's token comes from REST agent rotate instead.
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
  // OUTSIDE the try on purpose: a mint failure that survives the retry is not a naming
  // problem, and the catch below exists to recast naming problems. It propagates raw so a
  // caller cannot relabel a dead store as "that name is taken".
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
    return { context, agentId: minted.id }
  } catch (err) {
    // A name-collision after the auto-mint must not strand an orphaned managed agent.
    await meta.deleteAgent(minted.id, input.orgId).catch(() => {})
    throw new ContextConflictError(err)
  }
}
