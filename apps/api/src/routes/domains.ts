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

/**
 * Vanity subdomains (domain mode C1, subdomain tier): assign `<label>.<base>` to an
 * artifact, list, and release. Gated on `share` (the same authority as visibility),
 * and only available when the server sets a base domain (DOCK_SUBDOMAIN_BASE).
 * Serving at the host root is handled by the host-dispatch middleware in app.ts.
 */
export const domainRoutes = (ctx: AppContext) => {
  const { meta, authorize } = ctx
  const base = ctx.deps.subdomainBase?.toLowerCase()
  const scheme = (() => {
    try {
      return new URL(ctx.deps.baseUrl).protocol
    } catch {
      return "https:"
    }
  })()
  const app = new Hono()

  const toJson = (d: DomainRecord) => ({
    host: d.host,
    url: `${scheme}//${d.host}`,
    kind: d.kind,
    created_at: d.created_at,
  })

  // The artifact's vanity hosts (and whether the server has a base configured).
  app.get("/v1/artifacts/:shortId/domains", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return fail(c, 404, "not found")
    const domains = await meta.getArtifactDomains(artifact.id)
    return c.json({ base: base ?? null, domains: domains.map(toJson) })
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

  // Release a vanity host (scoped to the artifact's workspace).
  app.delete("/v1/artifacts/:shortId/domains/:host", async (c) => {
    const artifact = await meta.getByShortId(c.req.param("shortId"))
    if (!artifact || !(await authorize(c, "read", artifact))) return fail(c, 404, "not found")
    if (!(await authorize(c, "share", artifact))) return fail(c, 403, "forbidden")
    const host = c.req.param("host").toLowerCase()
    const existing = await meta.getDomain(host)
    if (!existing || existing.artifact_id !== artifact.id) return fail(c, 404, "not found")
    await meta.deleteDomain(host, artifact.org_id)
    return c.json({ ok: true })
  })

  return app
}
