import type { DomainRecord } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { bail, fail, readJson } from "../lib/http"
import { isClaimableLabel, normalizeLabel } from "../lib/subdomain-labels"

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
 * Workspace domains: the two ways a workspace puts its own name on its links. Both
 * bind to the workspace (org), not a single artifact, so the `domain` row has a null
 * artifact_id and app.ts serves every workspace artifact at `<host>/<ref>`.
 *
 *  · The workspace SUBDOMAIN (`<label>.<base>`, needs DERIVE_SUBDOMAIN_BASE): one label
 *    per workspace, claimed here, live the instant it is stored (the wildcard cert +
 *    route already cover it). Nothing to verify: it is a name on OUR domain, first
 *    come first served, so the reserved list + the plan gate are the only brakes.
 *  · CUSTOM domains (Cloudflare for SaaS): an admin attaches their own hostname; CF
 *    issues + renews the cert and the row is `pending` until it validates.
 *
 * Gated on workspace `manage`. The WorkspaceDomain, WorkspaceSubdomain and
 * DomainDnsRecord response schemas are the single source for the web client's types.
 */
export const workspaceDomainRoutes = (ctx: AppContext) => {
  const { meta, activeWorkspace, requireWorkspace, billingState, blockCopy } = ctx
  const cd = ctx.deps.customDomains
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
    status: d.status,
    records: parseRecords(d.verification),
    created_at: d.created_at,
  })
  const subToJson = (d: DomainRecord) => ({
    host: d.host,
    label: base && d.host.endsWith(`.${base}`) ? d.host.slice(0, -(base.length + 1)) : d.host,
    url: `${scheme}//${d.host}`,
    status: d.status,
    created_at: d.created_at,
  })
  // The workspace's one subdomain row, if any: org-bound, no artifact, kind subdomain.
  const currentSubdomain = async (org: string): Promise<DomainRecord | null> =>
    (await meta.getWorkspaceDomains(org)).find((d) => d.kind === "subdomain") ?? null

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
  const WorkspaceSubdomain = z
    .object({
      host: z.string().describe("The full host, `<label>.<base>`."),
      label: z.string().describe("The label the workspace chose."),
      url: z.string().describe("The host with scheme; artifacts live at `<url>/<ref>`."),
      status: z
        .enum(["active", "pending", "error"])
        .describe("Always active for a subdomain: it serves the moment it is claimed."),
      created_at: z.string(),
    })
    .openapi("WorkspaceSubdomain")

  // Everything the Domains settings page needs in one read: the subdomain (and
  // whether the server offers one), the custom domains (and whether it offers those).
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/workspace/domains",
      tags: ["Domains"],
      summary: "List the workspace's subdomain and custom domains, and what this server supports.",
      responses: {
        200: {
          description:
            "The subdomain base + claimed label, whether custom domains are enabled, the CNAME target, and the custom domains.",
          content: {
            "application/json": {
              schema: z.object({
                subdomain_base: z
                  .string()
                  .nullable()
                  .describe(
                    "The base a workspace subdomain hangs off (e.g. derive.page); null when subdomains are off here.",
                  ),
                // A union, not `.nullable()`: that would mark the registered component
                // itself nullable and every consumer of WorkspaceSubdomain would see
                // `| null` (the PUT responses included).
                subdomain: z
                  .union([WorkspaceSubdomain, z.null()])
                  .describe("The workspace's claimed subdomain, or null."),
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
      const all = await meta.getWorkspaceDomains(org)
      const sub = all.find((d) => d.kind === "subdomain") ?? null
      return c.json({
        subdomain_base: base ?? null,
        subdomain: sub ? subToJson(sub) : null,
        enabled: !!cd,
        cname_target: cd?.cnameTarget ?? null,
        domains: all.filter((d) => d.kind === "custom").map(toJson),
      })
    },
  )

  // Claim (or change) the workspace's subdomain. One label per workspace: claiming a
  // new one releases the old host outright (no forwarding), so a label can never be
  // hoarded. Idempotent when the label is already this workspace's.
  app.openapi(
    createRoute({
      method: "put",
      path: "/v1/workspace/subdomain",
      tags: ["Domains"],
      summary: "Claim or change the workspace's subdomain.",
      responses: {
        200: {
          description: "The subdomain (already this workspace's).",
          content: { "application/json": { schema: WorkspaceSubdomain } },
        },
        201: {
          description: "The newly claimed subdomain; any previous label is released.",
          content: { "application/json": { schema: WorkspaceSubdomain } },
        },
      },
    }),
    async (c) => {
      if (!base) return bail(fail(c, 501, "subdomains are not enabled on this server"))
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const body = await readJson(c, z.object({ label: z.string() }))
      if (body instanceof Response) return bail(body)
      const label = normalizeLabel(body.label)
      if (!isClaimableLabel(label)) return bail(fail(c, 400, "invalid or reserved subdomain label"))
      const host = `${label}.${base}`
      const current = await currentSubdomain(org)
      if (current?.host === host) return c.json(subToJson(current))
      // A Team feature. Checked before the namespace so a Free workspace learns about
      // the plan, not about whether "acme" happens to be free.
      if (!(await billingState(org)).customDomainEntitled)
        return bail(
          fail(c, 402, blockCopy.custom_domain.message, { code: blockCopy.custom_domain.code }),
        )
      // The host is globally unique across artifact subdomains, workspace subdomains
      // and custom domains: the insert refuses a taken one, which is the 409.
      const created = await meta.setDomain({ host, org_id: org, kind: "subdomain" })
      if (!created) return bail(fail(c, 409, "that subdomain is taken"))
      // Swap: the old label goes the moment the new one is live, never before, so a
      // failed claim leaves the workspace exactly where it was.
      if (current) await meta.deleteDomain(current.host, org)
      return c.json(subToJson(created), 201)
    },
  )

  // Release the workspace's subdomain. Links on it stop working immediately.
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/workspace/subdomain",
      tags: ["Domains"],
      summary: "Release the workspace's subdomain.",
      responses: {
        200: {
          description: "The subdomain was released.",
          content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
        },
      },
    }),
    async (c) => {
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      const current = await currentSubdomain(org)
      if (!current) return bail(fail(c, 404, "not found"))
      await meta.deleteDomain(current.host, org)
      return c.json({ ok: true })
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
