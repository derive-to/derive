import type { ContextRuntimeRecord, MetaStore, RuntimeModelConnectionRecord } from "@derive/core"
import type { AppDeps } from "../context"
import { spendableConnections } from "./broker"
import { decryptSecret, sha256 } from "./crypto"
import { OrtamClient } from "./ortam-client"

type Controller = Pick<ContextRuntimeRecord, "api_url" | "org_id" | "context_id" | "connection_id">
export function managedRuntimeClient(
  config: NonNullable<AppDeps["runtime"]>,
  orgId: string,
  contextId: string,
  fetcher?: typeof fetch,
) {
  if (!config.managed?.apiKey) throw new Error("Cloud execution is not configured")
  return new OrtamClient(
    config.apiUrl,
    config.managed.apiKey,
    fetcher,
    sha256(JSON.stringify([orgId, contextId])),
  )
}

/** Controller credentials stay on the deployment. A retained reference can stop
 * compute after admission is revoked; rollout gates never block cleanup. */
export async function runtimeController(
  meta: MetaStore,
  config: NonNullable<AppDeps["runtime"]>,
  secret: string,
  runtime: Controller,
  fetcher?: typeof fetch,
  cleanup = false,
) {
  if (runtime.api_url !== config.apiUrl) throw new Error("Runtime belongs to a different Ortam API")
  if (runtime.connection_id === null)
    return managedRuntimeClient(config, runtime.org_id, runtime.context_id, fetcher)
  const connections = cleanup
    ? await meta.getConnectionsByIds([runtime.connection_id])
    : await spendableConnections(meta, runtime.org_id, [runtime.connection_id])
  const connection = connections.find(
    (c) => c.id === runtime.connection_id && c.org_id === runtime.org_id,
  )
  if (connection?.kind !== "secret" || !connection.secret_enc)
    throw new Error("Ortam connection is unavailable")
  const key = decryptSecret(connection.secret_enc, secret)
  if (key === connection.secret_enc) throw new Error("Ortam connection cannot be decrypted")
  return new OrtamClient(runtime.api_url, key, fetcher)
}

/** Connection IDs have a separate namespace from legacy Context-scoped subjects. */
export function managedModelClient(
  config: NonNullable<AppDeps["runtime"]>,
  connection: Pick<RuntimeModelConnectionRecord, "id" | "org_id" | "api_url">,
  fetcher?: typeof fetch,
) {
  if (!config.managed?.apiKey) throw new Error("Cloud execution is not configured")
  if (connection.api_url !== config.apiUrl)
    throw new Error("Model connection belongs to a different API")
  return new OrtamClient(
    connection.api_url,
    config.managed.apiKey,
    fetcher,
    sha256(JSON.stringify([connection.org_id, "model-connection", connection.id])),
  )
}
