import { createHash } from "node:crypto"
import type { ConnectionRecord, MetaStore, NewConnection } from "@derive/core"

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
 * old manual connection path are reactivated in place so contexts keep their bindings.
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
