import type { ConnectionRecord, MetaStore } from "@derive/core"
import { BoatClient } from "./boat-client"
import { decryptSecret, sha256 } from "./crypto"
import { OrtamClient } from "./ortam-client"
import type { RuntimeConfig } from "./runtime-setup"
import { runnerRunsJobs } from "./runtime-setup"

export const BOAT_API_URL = "https://boat.dev/api/v1"
export const ORTAM_API_URL = "https://api.ortam.dev/v1"
export type SandboxProvider = "boat" | "ortam"
export const sandboxApiUrl = (provider: SandboxProvider) =>
  provider === "boat" ? BOAT_API_URL : ORTAM_API_URL
// Keep the durable connection id: existing Boat sandboxes pin this id for cleanup.
export const runtimeConnectionId = (org: string) => `conn_boat_${sha256(org).slice(0, 32)}`

/** Compute credentials stay in the controller. They never become an agent tool or secret. */
export const runtimeConnection = async (meta: MetaStore, org: string) => {
  const cn = await meta.getConnection(runtimeConnectionId(org))
  return cn?.org_id === org &&
    cn.scope === "workspace" &&
    cn.kind === "runtime" &&
    (cn.toolkit === "boat" || cn.toolkit === "ortam") &&
    cn.base_url === sandboxApiUrl(cn.toolkit)
    ? cn
    : null
}

export const boatConnection = async (meta: MetaStore, org: string) => {
  const cn = await runtimeConnection(meta, org)
  return cn?.toolkit === "boat" ? cn : null
}

const connectionKey = (cn: Pick<ConnectionRecord, "secret_enc">, key: string | undefined) => {
  if (!key || !cn.secret_enc) throw new Error("Sandbox connection is unavailable")
  const value = decryptSecret(cn.secret_enc, key)
  if (!cn.secret_enc.startsWith("v1.") || value === cn.secret_enc)
    throw new Error("Sandbox connection is unreadable")
  return value
}

export const boatClient = (
  cn: Pick<ConnectionRecord, "secret_enc">,
  key: string | undefined,
  fetcher?: typeof fetch,
) => new BoatClient(BOAT_API_URL, connectionKey(cn, key), fetcher)

export const connectionClient = (
  cn: Pick<ConnectionRecord, "secret_enc" | "toolkit">,
  key: string | undefined,
  fetcher?: typeof fetch,
) =>
  cn.toolkit === "boat"
    ? boatClient(cn, key, fetcher)
    : new OrtamClient(ORTAM_API_URL, connectionKey(cn, key), "", fetcher, "api_key")

export const workspaceRuntime = async (
  meta: MetaStore,
  config: RuntimeConfig | undefined,
  org: string,
) => {
  const cn = await runtimeConnection(meta, org)
  return cn
    ? {
        provider: cn.toolkit as SandboxProvider,
        apiUrl: sandboxApiUrl(cn.toolkit as SandboxProvider),
        connection: cn,
      }
    : {
        provider: config?.provider ?? "ortam",
        apiUrl: config?.apiUrl ?? ORTAM_API_URL,
        connection: null,
      }
}

export const cloudEnabled = async (
  meta: MetaStore,
  config: RuntimeConfig | undefined,
  org: string,
) => {
  if (!meta.jobExecution) return false
  if (!config || !runnerRunsJobs(config.runnerPath, config.runnerVersion)) return false
  const cn = await runtimeConnection(meta, org)
  if (cn) return cn.status === "active"
  return (
    config.provider !== "boat" && !!config.managed?.apiKey && config.managed.workspaceIds.has(org)
  )
}
