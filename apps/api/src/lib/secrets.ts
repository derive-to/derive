import { type ConnectionRecord, type MetaStore, newId } from "@derive/core"
import { decryptSecret, encryptSecret, safeEqual, sha256 } from "./crypto"

export interface SaveSecretInput {
  orgId: string
  userId: string
  scope: "personal" | "workspace"
  /** Display name. Labels identify a secret without disclosing any part of its value. */
  name?: string
  value: string
  toolkit: string
  /** Already validated by the caller; stored without a trailing slash. */
  baseUrl?: string | null
  /** Hand back a secret this person already saved with the same value, scope and base_url. */
  reuse: boolean
  /** Makes retries land on one row: the same request id always names the same secret. */
  requestId?: string
}

export type SaveSecretResult = {
  secret: ConnectionRecord
  /** created: stored now. reused: an earlier secret with this value. retried: this request id's. */
  outcome: "created" | "reused" | "retried"
}

/** Store a secret value encrypted, or return the one this person already has. The caller has
 *  checked that they may save at this scope. */
export async function saveSecret(
  meta: MetaStore,
  encryptionKey: string,
  input: SaveSecretInput,
): Promise<SaveSecretResult> {
  const baseUrl = input.baseUrl ? input.baseUrl.replace(/\/+$/, "") : null
  if (input.reuse) {
    // Only secrets the caller could attach anyway (their own personal ones, or workspace ones,
    // which saving at workspace scope already required manage for), so a match reveals
    // nothing new. Values are compared decrypted, in memory; nothing derived from them is kept.
    const same = (await meta.listConnections(input.orgId)).find(
      (cn) =>
        cn.kind === "secret" &&
        cn.status === "active" &&
        cn.scope === input.scope &&
        (input.scope === "workspace" || cn.user_id === input.userId) &&
        cn.base_url === baseUrl &&
        !!cn.secret_enc &&
        safeEqual(decryptSecret(cn.secret_enc, encryptionKey), input.value),
    )
    if (same) return { secret: same, outcome: "reused" }
  }
  const id = input.requestId
    ? `conn_${sha256(JSON.stringify([input.orgId, input.userId, input.requestId])).slice(0, 40)}`
    : newId("conn")
  const existing = await meta.getConnection(id)
  if (existing) return { secret: existing, outcome: "retried" }
  const secret = await meta
    .createConnection({
      id,
      org_id: input.orgId,
      user_id: input.userId,
      scope: input.scope,
      kind: "secret",
      secret_enc: encryptSecret(input.value, encryptionKey),
      // executeHttpTool adds the slash back when it resolves a path.
      base_url: baseUrl,
      broker: "none",
      toolkit: input.toolkit,
      // No vendor account stands behind a pasted value, but a run still identifies its tools
      // by ref, so mint a synthetic one. Nothing parses it; routing is on `kind`.
      broker_ref: newId("sref"),
      scopes_label: input.name?.trim() || "Stored secret",
      // Nothing to authorize, so it is usable immediately.
      status: "active",
    })
    .catch(async (error: unknown) => {
      // A concurrent retry with the same request id won the insert.
      const winner = await meta.getConnection(id)
      if (winner) return winner
      throw error
    })
  return { secret, outcome: "created" }
}
