import type { ConnectionRecord, MetaStore } from "@derive/core"
import type { AppDeps } from "../context"
import { BoatClient } from "./boat-client"
import { decryptSecret, sha256 } from "./crypto"
import { runnerRunsJobs } from "./runtime-setup"

export const BOAT_API_URL = "https://boat.dev/api/v1"
export const boatConnectionId = (org: string) => `conn_boat_${sha256(org).slice(0, 32)}`

/** Compute credentials stay in the controller. They never become an agent tool or secret. */
export const boatConnection = async (meta: MetaStore, org: string) => {
  const cn = await meta.getConnection(boatConnectionId(org))
  return cn?.org_id === org &&
    cn.scope === "workspace" &&
    cn.kind === "runtime" &&
    cn.toolkit === "boat" &&
    cn.base_url === BOAT_API_URL
    ? cn
    : null
}

export const boatClient = (
  cn: ConnectionRecord,
  key: string | undefined,
  fetcher?: typeof fetch,
) => {
  if (!key || !cn.secret_enc) throw new Error("boat.dev connection is unavailable")
  const value = decryptSecret(cn.secret_enc, key)
  if (!cn.secret_enc.startsWith("v1.") || value === cn.secret_enc)
    throw new Error("boat.dev connection is unreadable")
  return new BoatClient(BOAT_API_URL, value, fetcher)
}

export const cloudEnabled = async (meta: MetaStore, config: AppDeps["runtime"], org: string) => {
  if (!config || !runnerRunsJobs(config.runnerPath, config.runnerVersion)) return false
  if (config.provider === "boat") return (await boatConnection(meta, org))?.status === "active"
  return !!config.managed?.apiKey && config.managed.workspaceIds.has(org)
}
