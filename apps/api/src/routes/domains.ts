import type { ArtifactRecord, DomainRecord } from "@derive/core"
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

/** The artifact's ref (`<slug>-<short_id>`), the path segment in its URLs. */
const refOf = (a: ArtifactRecord): string => (a.slug ? `${a.slug}-${a.short_id}` : a.short_id)

/**
 * Per-artifact vanity subdomains (`<label>.<base>`, needs DERIVE_SUBDOMAIN_BASE): claim,
 * list, release; gated on `share`. Workspace custom domains are managed separately
 * (workspace-domains.ts) but surfaced here read-only as "also at <domain>/<ref>", so
 * the share dialog shows every URL an artifact is reachable at. Serving is in app.ts.
 */
export const domainRoutes = (ctx: AppContext) => {
  const { meta, requireArtifact, authorize } = ctx
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
    status: d.status,
    created_at: d.created_at,
  })

  // The artifact's subdomains (manageable) + the workspace's active custom domains
  // (read-only here; managed in workspace settings), each with this artifact's URL.
  app.get("/v1/artifacts/:shortId/domains", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    const [subs, wsDomains] = await Promise.all([
      meta.getArtifactDomains(artifact.id),
      meta.getWorkspaceDomains(artifact.org_id),
    ])
    const ref = refOf(artifact)
    return c.json({
      base: base ?? null,
      domains: subs.map(toJson),
      workspace_domains: wsDomains
        .filter((d) => d.status === "active")
        .map((d) => ({ host: d.host, url: `${scheme}//${d.host}/${ref}` })),
    })
  })

  // Claim `<label>.<base>` for the artifact. Idempotent if it is already yours.
  app.put("/v1/artifacts/:shortId/domains", async (c) => {
    if (!base) return fail(c, 501, "subdomains are not enabled on this server")
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
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

  // Release one of the artifact's subdomains (scoped to this artifact).
  app.delete("/v1/artifacts/:shortId/domains/:host", async (c) => {
    const artifact = await requireArtifact(c, "read")
    if (artifact instanceof Response) return artifact
    if (!(await authorize(c, "share", artifact))) return fail(c, 403, "forbidden")
    const host = c.req.param("host").toLowerCase()
    const existing = await meta.getDomain(host)
    if (!existing || existing.artifact_id !== artifact.id) return fail(c, 404, "not found")
    await meta.deleteDomain(host, artifact.org_id)
    return c.json({ ok: true })
  })

  return app
}
