import type { DomainStatus } from "@derive/core"

/**
 * Cloudflare for SaaS (Custom Hostnames) — the BYO-custom-domain provider. Cloudflare
 * owns the hard part (issuing, validating, and renewing the per-domain TLS cert); we
 * just register the hostname, surface the DNS the customer must add, and poll status.
 * Uses only `fetch`, so it runs in both the Node and the Workers entry.
 * Docs: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/
 */
export interface CustomDomainDnsRecord {
  type: "CNAME" | "TXT"
  name: string
  value: string
}
export interface CustomDomainState {
  /** Cloudflare custom-hostname id (stored for refresh + teardown). */
  cfHostnameId: string
  status: DomainStatus
  /** DNS records the customer adds at their registrar to point + validate the domain. */
  records: CustomDomainDnsRecord[]
}
export interface CustomDomainProvider {
  /** The CNAME target customers point their domain at (the SaaS fallback origin). */
  readonly cnameTarget: string
  create(host: string): Promise<CustomDomainState>
  refresh(cfHostnameId: string): Promise<CustomDomainState>
  remove(cfHostnameId: string): Promise<void>
}

interface CfResult {
  id: string
  hostname?: string
  status?: string
  ssl?: { status?: string }
  ownership_verification?: { type?: string; name?: string; value?: string }
}

const toState = (cnameTarget: string, host: string, r: CfResult): CustomDomainState => {
  const records: CustomDomainDnsRecord[] = [{ type: "CNAME", name: host, value: cnameTarget }]
  const ov = r.ownership_verification
  if (ov?.type === "txt" && ov.name && ov.value)
    records.push({ type: "TXT", name: ov.name, value: ov.value })
  const ssl = r.ssl?.status
  const status: DomainStatus =
    r.status === "active" && ssl === "active"
      ? "active"
      : ssl === "validation_timed_out" || r.status === "blocked" || r.status === "moved"
        ? "error"
        : "pending"
  return { cfHostnameId: r.id, status, records }
}

export const cloudflareCustomDomains = (cfg: {
  apiToken: string
  zoneId: string
  cnameTarget: string
  fetchImpl?: typeof fetch
}): CustomDomainProvider => {
  const f = cfg.fetchImpl ?? fetch
  const base = `https://api.cloudflare.com/client/v4/zones/${cfg.zoneId}/custom_hostnames`
  const headers = { authorization: `Bearer ${cfg.apiToken}`, "content-type": "application/json" }

  // CF wraps every response in {success, result, errors}. Throw the first error so the
  // route can turn it into a clean 4xx/5xx rather than leaking a half-parsed body.
  const call = async (url: string, init?: RequestInit): Promise<CfResult> => {
    const res = await f(url, { ...init, headers })
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean
      result?: CfResult
      errors?: { message?: string }[]
    }
    if (!res.ok || !body.success || !body.result)
      throw new Error(body.errors?.[0]?.message ?? `cloudflare error (${res.status})`)
    return body.result
  }

  return {
    cnameTarget: cfg.cnameTarget,
    async create(host) {
      const result = await call(base, {
        method: "POST",
        body: JSON.stringify({ hostname: host, ssl: { method: "http", type: "dv" } }),
      })
      return toState(cfg.cnameTarget, host, result)
    },
    async refresh(cfHostnameId) {
      const result = await call(`${base}/${cfHostnameId}`)
      return toState(cfg.cnameTarget, result.hostname ?? "", result)
    },
    async remove(cfHostnameId) {
      await call(`${base}/${cfHostnameId}`, { method: "DELETE" })
    },
  }
}

/** Build the provider from env, or undefined when Cloudflare for SaaS isn't configured
 *  (custom domains then 501). Shared by the Node and Workers entries. */
export const customDomainsFromEnv = (
  env: { CF_API_TOKEN?: string; CF_ZONE_ID?: string; CF_SAAS_FALLBACK_ORIGIN?: string },
  fetchImpl?: typeof fetch,
): CustomDomainProvider | undefined =>
  env.CF_API_TOKEN && env.CF_ZONE_ID && env.CF_SAAS_FALLBACK_ORIGIN
    ? cloudflareCustomDomains({
        apiToken: env.CF_API_TOKEN,
        zoneId: env.CF_ZONE_ID,
        cnameTarget: env.CF_SAAS_FALLBACK_ORIGIN,
        fetchImpl,
      })
    : undefined
