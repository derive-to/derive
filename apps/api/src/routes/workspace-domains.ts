import type { DomainRecord } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"

// A fully-qualified domain (at least one dot).
const FQDN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** The DNS records the verification blob stores (Cloudflare for SaaS: a CNAME). */
type DnsRecord = { type: string; name: string; value: string }
const parseRecords = (v: string | null): DnsRecord[] | undefined => {
  if (!v) return undefined
  try {
    return JSON.parse(v) as DnsRecord[]
  } catch {
    return undefined
  }
}

/**
 * Workspace custom domains (the easy "slap your own URL on it" path). An admin
 * attaches their domain to the workspace once; Cloudflare for SaaS issues + renews
 * the cert, and every artifact is then served at `<domain>/<ref>` (the host-dispatch
 * in app.ts does the routing). Bound to the workspace (org), not a single artifact,
 * so the `domain` row has a null artifact_id. Gated on workspace `manage`. The
 * WorkspaceDomain + DomainDnsRecord response schemas are the single source for the
 * web client's types.
 */
export const workspaceDomainRoutes = (ctx: AppContext) => {
  const { meta, activeWorkspace, requireWorkspace } = ctx
  const cd = ctx.deps.customDomains
  const app = new OpenAPIHono<BlankEnv>()

  const toJson = (d: DomainRecord) => ({
    host: d.host,
    status: d.status,
    records: parseRecords(d.verification),
    created_at: d.created_at,
  })

  const DomainDnsRecord = z
    .object({
      type: z.string().describe("DNS record type to create (e.g. CNAME)."),
      name: z.string().describe("The name/host to create the DNS record at."),
      value: z.string().describe("The value the DNS record should point at."),
    })
    .openapi("DomainDnsRecord")
  const WorkspaceDomain = z
    .object({
      host: z.string().describe("The custom domain attached to the workspace."),
      status: z
        .enum(["active", "pending", "error"])
        .describe(
          '"active" = serving; "pending" = awaiting DNS/cert; "error" = validation failed.',
        ),
      records: z
        .array(DomainDnsRecord)
        .optional()
        .describe("DNS records to add while pending; absent once the domain is active."),
      created_at: z.string(),
    })
    .openapi("WorkspaceDomain")

  // The workspace's custom domains + whether the server supports them.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspace/domains",
      tags: ["Domains"],
      summary: "List the workspace's custom domains and whether they're supported here.",
      responses: {
        200: {
          description: "Whether custom domains are enabled, the CNAME target, and the domains.",
          content: {
            "application/json": {
              schema: z.object({
                enabled: z.boolean().describe("True when this server supports custom domains."),
                cname_target: z
                  .string()
                  .nullable()
                  .describe("The CNAME target to point domains at; null when they're disabled."),
                domains: z
                  .array(WorkspaceDomain)
                  .describe("The workspace's attached custom domains."),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const org = await activeWorkspace(c)
      const domains = await meta.getWorkspaceDomains(org)
      return c.json({
        enabled: !!cd,
        cname_target: cd?.cnameTarget ?? null,
        domains: domains.map(toJson),
      })
    },
  )

  // Attach a domain to the workspace. Registers a Cloudflare custom hostname and
  // stores it `pending` with the DNS to display; it serves once CF validates the cert.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/workspace/domains",
      tags: ["Domains"],
      summary: "Attach a custom domain to the workspace.",
      responses: {
        200: {
          description: "The domain (already attached to this workspace).",
          content: {
            "application/json": {
              schema: WorkspaceDomain.extend({
                cname_target: z.string().describe("The CNAME target to point your domain at."),
              }),
            },
          },
        },
        201: {
          description: "The newly attached domain, pending DNS validation.",
          content: {
            "application/json": {
              schema: WorkspaceDomain.extend({
                cname_target: z.string().describe("The CNAME target to point your domain at."),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      if (!cd) return bail(fail(c, 501, "custom domains are not enabled on this server"))
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const body = await readJson(c, z.object({ host: z.string() }))
      if (body instanceof Response) return bail(body)
      const host = body.host
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "")
        .replace(/\.+$/, "")
      if (!FQDN.test(host)) return bail(fail(c, 400, "enter a valid domain you control"))
      const existing = await meta.getDomain(host)
      if (existing) {
        // Idempotent re-add: return the same shape as a fresh create (with cname_target)
        // so the client always has the DNS target to show, never a partial response.
        if (existing.org_id === org && !existing.artifact_id)
          return c.json({ ...toJson(existing), cname_target: cd.cnameTarget })
        return bail(fail(c, 409, "that domain is already in use"))
      }
      let state: Awaited<ReturnType<typeof cd.create>>
      try {
        state = await cd.create(host)
      } catch (e) {
        return bail(fail(c, 502, e instanceof Error ? e.message : "couldn't register the domain"))
      }
      const created = await meta.setDomain({
        host,
        org_id: org,
        kind: "custom",
        status: state.status,
        cf_hostname_id: state.cfHostnameId,
        verification: JSON.stringify(state.records),
      })
      if (!created) {
        await cd.remove(state.cfHostnameId).catch(() => {})
        return bail(fail(c, 409, "that domain is already in use"))
      }
      return c.json({ ...toJson(created), cname_target: cd.cnameTarget }, 201)
    },
  )

  // Re-check a domain's validation status against Cloudflare.
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/workspace/domains/{host}/refresh",
      tags: ["Domains"],
      summary: "Re-check a custom domain's validation status.",
      request: { params: z.object({ host: z.string() }) },
      responses: {
        200: {
          description: "The domain's current status.",
          content: { "application/json": { schema: WorkspaceDomain } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const existing = await meta.getDomain(c.req.param("host").toLowerCase())
      if (!existing || existing.org_id !== org || existing.artifact_id)
        return bail(fail(c, 404, "not found"))
      if (!existing.cf_hostname_id || !cd) return c.json(toJson(existing))
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
    },
  )

  // Detach a domain (tears down the Cloudflare hostname too).
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/workspace/domains/{host}",
      tags: ["Domains"],
      summary: "Detach a custom domain from the workspace.",
      request: { params: z.object({ host: z.string() }) },
      responses: {
        200: {
          description: "The domain was detached.",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const host = c.req.param("host").toLowerCase()
      const existing = await meta.getDomain(host)
      if (!existing || existing.org_id !== org || existing.artifact_id)
        return bail(fail(c, 404, "not found"))
      if (existing.cf_hostname_id && cd) await cd.remove(existing.cf_hostname_id).catch(() => {})
      await meta.deleteDomain(host, org)
      return c.json({ ok: true })
    },
  )

  return app
}
