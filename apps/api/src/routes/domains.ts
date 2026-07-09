import type { ArtifactRecord, DomainRecord } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"

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
 * The ArtifactDomain response schema is the single source for the web client's type.
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
  const app = new OpenAPIHono<BlankEnv>()

  const toJson = (d: DomainRecord) => ({
    host: d.host,
    url: `${scheme}//${d.host}`,
    kind: d.kind,
    status: d.status,
    created_at: d.created_at,
  })

  // kind/status mirror core's DomainKind/DomainStatus unions, so the generated web type
  // carries the closed set (not a bare string). app.openapi type-checks the handler's
  // DomainRecord values against these enums, so they can't drift from core silently.
  const ArtifactDomain = z
    .object({
      host: z.string().describe("The hostname the artifact is served at."),
      url: z.string().describe("That host with scheme, ready to link to."),
      kind: z
        .enum(["subdomain", "custom"])
        .describe('"subdomain" = a vanity <label>.<base>; "custom" = a workspace custom domain.'),
      status: z
        .enum(["active", "pending", "error"])
        .describe(
          '"active" = serving; "pending" = awaiting DNS/cert; "error" = validation failed.',
        ),
      created_at: z.string(),
    })
    .openapi("ArtifactDomain")

  // The artifact's subdomains (manageable) + the workspace's active custom domains
  // (read-only here; managed in workspace settings), each with this artifact's URL.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts/{shortId}/domains",
      tags: ["Domains"],
      summary: "List an artifact's subdomains + the workspace domains it's reachable at.",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "The subdomain base, the artifact's subdomains, and workspace domains.",
          content: {
            "application/json": {
              schema: z.object({
                base: z
                  .string()
                  .nullable()
                  .describe("Base host subdomains hang off (e.g. derive.to); null if disabled."),
                domains: z
                  .array(ArtifactDomain)
                  .describe("The artifact's own vanity subdomains, managed here."),
                workspace_domains: z
                  .array(
                    z.object({
                      host: z.string(),
                      url: z
                        .string()
                        .describe("This artifact's URL on that domain, including its ref."),
                    }),
                  )
                  .describe("Workspace custom domains this artifact is served at (read-only)."),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const artifact = await requireArtifact(c, "read")
      if (artifact instanceof Response) return bail(artifact)
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
    },
  )

  // Claim `<label>.<base>` for the artifact. Idempotent if it is already yours.
  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/artifacts/{shortId}/domains",
      tags: ["Domains"],
      summary: "Claim a vanity subdomain for the artifact.",
      request: { params: z.object({ shortId: z.string() }) },
      responses: {
        200: {
          description: "The subdomain (already claimed by this artifact).",
          content: { "application/json": { schema: ArtifactDomain } },
        },
        201: {
          description: "The newly claimed subdomain.",
          content: { "application/json": { schema: ArtifactDomain } },
        },
      },
    }),
    async (c) => {
      if (!base) return bail(fail(c, 501, "subdomains are not enabled on this server"))
      const artifact = await requireArtifact(c, "read")
      if (artifact instanceof Response) return bail(artifact)
      if (!(await authorize(c, "share", artifact))) return bail(fail(c, 403, "forbidden"))
      const body = await readJson(c, z.object({ label: z.string() }))
      if (body instanceof Response) return bail(body)
      const label = body.label.trim().toLowerCase()
      if (!LABEL.test(label) || RESERVED.has(label))
        return bail(fail(c, 400, "invalid or reserved subdomain label"))
      const host = `${label}.${base}`
      const existing = await meta.getDomain(host)
      if (existing) {
        if (existing.artifact_id === artifact.id) return c.json(toJson(existing))
        return bail(fail(c, 409, "that subdomain is taken"))
      }
      const created = await meta.setDomain({
        host,
        artifact_id: artifact.id,
        org_id: artifact.org_id,
        kind: "subdomain",
      })
      if (!created) return bail(fail(c, 409, "that subdomain is taken"))
      return c.json(toJson(created), 201)
    },
  )

  // Release one of the artifact's subdomains (scoped to this artifact).
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/artifacts/{shortId}/domains/{host}",
      tags: ["Domains"],
      summary: "Release one of the artifact's subdomains.",
      request: { params: z.object({ shortId: z.string(), host: z.string() }) },
      responses: {
        200: {
          description: "The subdomain was released.",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      const artifact = await requireArtifact(c, "read")
      if (artifact instanceof Response) return bail(artifact)
      if (!(await authorize(c, "share", artifact))) return bail(fail(c, 403, "forbidden"))
      const host = c.req.param("host").toLowerCase()
      const existing = await meta.getDomain(host)
      if (!existing || existing.artifact_id !== artifact.id) return bail(fail(c, 404, "not found"))
      await meta.deleteDomain(host, artifact.org_id)
      return c.json({ ok: true })
    },
  )

  return app
}
