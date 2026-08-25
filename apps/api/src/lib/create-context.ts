import { type ContextRecord, type MetaStore, newId } from "@derive/core"
import { mintToken, sha256 } from "./crypto"

export interface CreateContextCoreInput {
  orgId: string
  userId: string
  name: string
  manifestArtifactId: string
  /** Reuse an existing agent; omitted auto-mints a managed one. */
  agentId?: string
  maxRunMs?: number
  maxConcurrency?: number
  connectionIds?: string[]
  /** Server-owned context metadata (for example an imported legacy diagram selector). */
  config?: string | null
}

export interface CreateContextCoreResult {
  context: ContextRecord
  agentId: string
}

export interface CreateContextCoreResultWithToken extends CreateContextCoreResult {
  /** Present only for an auto-mint when explicitly requested by the REST create route. */
  agentToken?: string
}

export class ContextConflictError extends Error {
  constructor(cause: unknown) {
    super("context insert failed", { cause })
    this.name = "ContextConflictError"
  }
}

export function createContextCore(
  meta: MetaStore,
  input: CreateContextCoreInput & { returnAgentToken: true },
): Promise<CreateContextCoreResultWithToken>
export function createContextCore(
  meta: MetaStore,
  input: CreateContextCoreInput & { returnAgentToken?: false },
): Promise<CreateContextCoreResult>
export async function createContextCore(
  meta: MetaStore,
  input: CreateContextCoreInput & { returnAgentToken?: boolean },
): Promise<CreateContextCoreResultWithToken> {
  let agentId = input.agentId
  let agentToken: string | undefined
  let minted = false

  if (!agentId) {
    agentToken = mintToken("dk_agt")
    const mint = (name: string) =>
      meta.createAgent({
        id: newId("ag"),
        org_id: input.orgId,
        name,
        token: sha256(agentToken as string),
        role: "editor",
        created_by: input.userId,
        managed: 1,
      })
    const agent = await mint(input.name).catch(() => mint(`${input.name} ${newId("x").slice(-4)}`))
    agentId = agent.id
    minted = true
  }

  try {
    const context = await meta.createContext({
      id: newId("ctx"),
      org_id: input.orgId,
      name: input.name,
      agent_id: agentId,
      manifest_artifact_id: input.manifestArtifactId,
      created_by: input.userId,
      max_run_ms: input.maxRunMs ?? null,
      ...(input.maxConcurrency !== undefined ? { max_concurrency: input.maxConcurrency } : {}),
      connection_ids: input.connectionIds?.length ? JSON.stringify(input.connectionIds) : null,
      config: input.config ?? null,
    })
    return {
      context,
      agentId,
      ...(input.returnAgentToken && agentToken ? { agentToken } : {}),
    }
  } catch (error) {
    if (minted) await meta.deleteAgent(agentId, input.orgId).catch(() => {})
    throw new ContextConflictError(error)
  }
}
