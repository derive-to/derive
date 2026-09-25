import type { ConnectionRecord } from "@derive/core"
import { sha256 } from "./crypto"

/** An opaque version of encrypted storage, never a hash of the plaintext value. */
export const credentialRevision = (connection: ConnectionRecord) =>
  sha256(JSON.stringify([connection.secret_enc, connection.status, connection.scopes_label]))

export const credentialVisible = (connection: ConnectionRecord, userId: string) =>
  connection.kind === "secret" &&
  (connection.scope === "workspace" || connection.user_id === userId)

export const credentialView = (
  connection: ConnectionRecord,
  userId: string,
  canManage: boolean,
) => ({
  id: connection.id,
  name: connection.scopes_label ?? connection.toolkit,
  owner_id: connection.scope === "personal" ? connection.user_id : null,
  scope: connection.scope,
  status: connection.status,
  created_at: connection.created_at,
  revision: credentialRevision(connection),
  health: "not_checked" as const,
  can_manage: connection.scope === "workspace" ? canManage : connection.user_id === userId,
  can_use:
    connection.status === "active" &&
    (connection.scope === "workspace" ? canManage : connection.user_id === userId),
})
