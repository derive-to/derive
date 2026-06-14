import type { DomainRecord } from "@dock/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { fail, readJson } from "../lib/http"

// Labels an artifact may never claim — they belong to the app or common infra.
const RESERVED = new Set([
  "www",
  "app",
  "api",
  "admin",
  "mail",
  "smtp",
  "ns",
  "ns1",
  "ns2",
  "cdn",
  "static",
  "assets",
  "dashboard",
  "status",
  "docs",
  "help",
])
// A single DNS label: 1-63 chars, a-z0-9 and hyphens, not hyphen-edged.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
// A fully-qualified domain (at least one dot), for bring-your-own custom domains.
const FQDN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

const parseRecords = (v: string | null): unknown => {
  if (!v) return undefined
  try {
    return JSON.parse(v)
  } catch {
    return undefined
  }
}

/**
 * Domain mode (C1). Two tiers, same `domain` table + host-dispatch:
 *  - vanity subdomains `<label>.<base>` (needs DOCK_SUBDOMAIN_BASE), always active.
 *  - bring-your-own custom domains via Cloudflare for SaaS (needs `customDomains`):
 *    registered as a CF custom hostname, `pending` until the cert + ownership validate.
 * All mutations are gated on `share` (the same authority as visibility); serving at the
 * host root is handled by the host-dispatch middleware in app.ts.
 */
export const domainRoutes = (ctx: AppContext) => {
  const { meta, authorize } = ctx
  const base = ctx.deps.subdomainBase?.toLowerCase()
  const cd = ctx.deps.customDomains
  const scheme = (() => {
    try {
      return new URL(ctx.deps.baseUrl).protocol
    } catch {
      return "https:"
    }
  })()
  const appHost = (() => {
    try {
      return new URL(ctx.deps.baseUrl).host.toLowerCase()
    } catch {
      return null
    }
  })()
  const app = new Hono()

  const toJson = (d: DomainRecord) => ({
    host: d.host,
    url: `${scheme}//${d.host}`,
    kind: d.kind,
    status: d.status,
    records: parseRecords(d.verification),
    created_at: d.created_at,
  })

  // The artifact's hosts + what the server supports (drives the share UI).
  app.get("/v1/artifacts/:shortId/domains", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return fail(c, 404, "not found")
    const domains = await meta.getArtifactDomains(artifact.id)
    return c.json({
      base: base ?? null,
      custom_enabled: !!cd,
      cname_target: cd?.cnameTarget ?? null,
      domains: domains.map(toJson),
    })
  })

  // Claim `<label>.<base>` for the artifact. Idempotent if it is already yours.
  app.put("/v1/artifacts/:shortId/domains", async (c) => {
    if (!base) return fail(c, 501, "subdomains are not enabled on this server")
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return fail(c, 404, "not found")
    if (!(await authorize(c, "share", artifact))) return fail(c, 403, "forbidden")
    const body = await readJson(c, z.object({ label: z.string() }))
    if (body instanceof Response) return body
    const label = body.label.trim().toLowerCase()
    if (!LABEL.test(label) || RESERVED.has(label))
      return fail(c, 400, "invalid or reserved subdomain label")
    const host = `${label}.${base}`
    const existing = await meta.getDomain(host)
    if (existing)
      return existing.artifact_id === artifact.id
        ? c.json(toJson(existing))
        : fail(c, 409, "that subdomain is taken")
    const created = await meta.setDomain({
      host,
      artifact_id: artifact.id,
      org_id: artifact.org_id,
      kind: "subdomain",
    })
    if (!created) return fail(c, 409, "that subdomain is taken")
    return c.json(toJson(created), 201)
  })

  // Attach a bring-your-own domain. Registers a Cloudflare custom hostname and stores
  // it `pending` with the DNS records to display; it serves once CF validates the cert.
  app.post("/v1/artifacts/:shortId/custom-domains", async (c) => {
    if (!cd) return fail(c, 501, "custom domains are not enabled on this server")
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return fail(c, 404, "not found")
    if (!(await authorize(c, "share", artifact))) return fail(c, 403, "forbidden")
    const body = await readJson(c, z.object({ host: z.string() }))
    if (body instanceof Response) return body
    const host = body.host.trim().toLowerCase().replace(/\.+$/, "")
    if (!FQDN.test(host) || (base && host.endsWith(`.${base}`)) || host === appHost)
      return fail(c, 400, "enter a valid domain you control")
    const existing = await meta.getDomain(host)
    if (existing)
      return existing.artifact_id === artifact.id
        ? c.json(toJson(existing))
        : fail(c, 409, "that domain is already attached")
    let state: Awaited<ReturnType<typeof cd.create>>
    try {
      state = await cd.create(host)
    } catch (e) {
      return fail(c, 502, e instanceof Error ? e.message : "couldn't register the domain")
    }
    const created = await meta.setDomain({
      host,
      artifact_id: artifact.id,
      org_id: artifact.org_id,
      kind: "custom",
      status: state.status,
      cf_hostname_id: state.cfHostnameId,
      verification: JSON.stringify(state.records),
    })
    if (!created) {
      await cd.remove(state.cfHostnameId).catch(() => {})
      return fail(c, 409, "that domain is already attached")
    }
    return c.json({ ...toJson(created), cname_target: cd.cnameTarget }, 201)
  })

  // Re-check a custom domain's validation status against Cloudflare.
  app.post("/v1/artifacts/:shortId/domains/:host/refresh", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return fail(c, 404, "not found")
    if (!(await authorize(c, "share", artifact))) return fail(c, 403, "forbidden")
    const existing = await meta.getDomain(c.req.param("host").toLowerCase())
    if (!existing || existing.artifact_id !== artifact.id) return fail(c, 404, "not found")
    if (existing.kind !== "custom" || !existing.cf_hostname_id || !cd)
      return c.json(toJson(existing))
    try {
      const state = await cd.refresh(existing.cf_hostname_id)
      const updated = await meta.updateDomain(existing.host, {
        status: state.status,
        verification: JSON.stringify(state.records),
      })
      return c.json(toJson(updated ?? existing))
    } catch {
      return c.json(toJson(existing))
    }
  })

  // Release a host (scoped to the artifact's workspace); tears down the CF hostname too.
  app.delete("/v1/artifacts/:shortId/domains/:host", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return fail(c, 404, "not found")
    if (!(await authorize(c, "share", artifact))) return fail(c, 403, "forbidden")
    const host = c.req.param("host").toLowerCase()
    const existing = await meta.getDomain(host)
    if (!existing || existing.artifact_id !== artifact.id) return fail(c, 404, "not found")
    if (existing.kind === "custom" && existing.cf_hostname_id && cd)
      await cd.remove(existing.cf_hostname_id).catch(() => {})
    await meta.deleteDomain(host, artifact.org_id)
    return c.json({ ok: true })
  })

  return app
}
