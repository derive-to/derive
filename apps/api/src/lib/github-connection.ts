import { createHash } from "node:crypto"
import type { AgentRecord, ConnectionRecord, MetaStore, NewConnection } from "@derive/core"
import { parseConnectionIds, spendableConnections } from "./broker"

const connectionId = (orgId: string, installationId: string): string =>
  `conn_gh_${createHash("sha256").update(`${orgId}\0${installationId}`).digest("hex").slice(0, 24)}`

const inputFor = (input: {
  orgId: string
  userId: string
  installationId: string
  accountLogin: string | null
}): NewConnection => ({
  id: connectionId(input.orgId, input.installationId),
  org_id: input.orgId,
  user_id: input.userId,
  scope: "workspace",
  kind: "github_app",
  secret_enc: null,
  broker: "none",
  toolkit: "github",
  broker_ref: input.installationId,
  base_url: "https://api.github.com",
  scopes_label: input.accountLogin ?? `installation ${input.installationId}`,
  status: "active",
})

/**
 * One stable workspace connection per GitHub installation. Existing random-id rows from the
 * old manual connection path are reactivated in place so agents keep their bindings.
 * Fresh rows use a deterministic id; simultaneous callback replays race on that primary key,
 * then the loser reads the winner instead of creating a duplicate.
 */
export async function upsertGithubConnection(
  meta: MetaStore,
  input: {
    orgId: string
    userId: string
    installationId: string
    accountLogin: string | null
  },
): Promise<ConnectionRecord> {
  const candidate = inputFor(input)
  const existing = (await meta.listConnections(input.orgId, undefined, "workspace")).find(
    (cn) => cn.kind === "github_app" && cn.broker_ref === input.installationId,
  )
  if (existing) {
    const updated = await meta.updateConnectionCredential(existing.id, input.orgId, {
      status: "active",
      scopes_label: candidate.scopes_label,
    })
    if (updated) return updated
  }

  try {
    return await meta.createConnection(candidate)
  } catch (err) {
    const raced = await meta.getConnection(candidate.id)
    if (
      !raced ||
      raced.org_id !== input.orgId ||
      raced.kind !== "github_app" ||
      raced.broker_ref !== input.installationId
    )
      throw err
    const updated = await meta.updateConnectionCredential(raced.id, input.orgId, {
      status: "active",
      scopes_label: candidate.scopes_label,
    })
    if (!updated) throw err
    return updated
  }
}

/**
 * The GitHub connection through which an agent works in `owner/name`: one bound to the agent,
 * active, and installed on the account that owns the repository. Null when there is none.
 *
 * Judged by the installation's account rather than by a live repository list, because that is
 * what the task's checkout does (routes/jobs.ts, /git) and a check that is stricter or looser
 * than the checkout would refuse work that runs, or accept work that cannot. An installation
 * limited to selected repositories is the one case this admits and the checkout then refuses,
 * with GitHub's own answer.
 */
export const githubConnectionFor = async (
  meta: MetaStore,
  agent: Pick<AgentRecord, "org_id" | "connection_ids_json">,
  repository: string,
): Promise<ConnectionRecord | null> => {
  const owner = repository.split("@")[0]?.split("/")[0]?.toLowerCase() ?? ""
  if (!owner) return null
  const bound = await spendableConnections(
    meta,
    agent.org_id,
    parseConnectionIds(agent.connection_ids_json),
  )
  return (
    bound.find((cn) => cn.kind === "github_app" && cn.scopes_label?.toLowerCase() === owner) ?? null
  )
}
