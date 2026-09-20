import { type DomainRecord, labelError, normalizeLabel } from "@derive/core"
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"
import type { BlankEnv } from "hono/types"
import type { AppContext } from "../context"
import { hostUrl } from "../lib/domains"
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
 * Workspace domains: hosts bound to the workspace (org) rather than one artifact, so
 * the `domain` row has a null artifact_id and app.ts serves every workspace artifact
 * at `<host>/<ref>`. Two kinds:
 *  - the workspace subdomain, `<label>.<base>` (needs DERIVE_SUBDOMAIN_BASE): one per
 *    workspace, first come first served, live as soon as the row exists;
 *  - custom domains (Cloudflare for SaaS): the customer's own hostname, `pending`
 *    until CF validates the cert.
 * Gated on workspace `manage`. The response schemas are the source of the web
 * client's types.
 */
export const workspaceDomainRoutes = (ctx: AppContext) => {
  const { meta, activeWorkspace, requireWorkspace, billingState, blockCopy } = ctx
  const cd = ctx.deps.customDomains
  const base = ctx.deps.subdomainBase?.toLowerCase()
  const app = new OpenAPIHono<BlankEnv>()

  const toJson = (d: DomainRecord) => ({
    host: d.host,
    status: d.status,
    records: parseRecords(d.verification),
    created_at: d.created_at,
  })
  const subToJson = (d: DomainRecord, base: string) => ({
    host: d.host,
    label: d.host.slice(0, -(base.length + 1)),
    url: hostUrl(ctx.deps.baseUrl, d.host),
    created_at: d.created_at,
  })
  // Newest first. There is meant to be at most one. Nothing in the store enforces
  // that (D1 has no transactions to swap inside), so a swap whose delete failed, or
  // two admins claiming at once, can leave two rows: the newest is the truth, and
  // the next claim or release clears the rest.
  const subdomainRows = (rows: DomainRecord[]): DomainRecord[] =>
    rows
      .filter((d) => d.kind === "subdomain")
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const subdomainsOf = async (org: string): Promise<DomainRecord[]> =>
    subdomainRows(await meta.getWorkspaceDomains(org))
  const release = (rows: DomainRecord[], org: string) =>
    Promise.all(rows.map((d) => meta.deleteDomain(d.host, org)))

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
      created_at: z.string(),
    })
    .openapi("WorkspaceSubdomain")

  // One read for the Domains settings page: subdomain support + claim, custom-domain
  // support + list.
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
                // Not `.nullable()`: that mutates the registered component, and the PUT
                // responses would inherit `| null`.
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
      // A claim made under a base that has since been unset is not served; hide it.
      const sub = base ? subdomainRows(all)[0] : undefined
      return c.json({
        subdomain_base: base ?? null,
        subdomain: sub && base ? subToJson(sub, base) : null,
        enabled: !!cd,
        cname_target: cd?.cnameTarget ?? null,
        domains: all.filter((d) => d.kind === "custom").map(toJson),
      })
    },
  )

  // Claim or change the workspace's subdomain. One per workspace: a new label
  // releases the old host, no forwarding. Idempotent on the current label.
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
      const org = await requireWorkspace(c, "manage")
      if (org instanceof Response) return bail(org)
      if (!base) return bail(fail(c, 501, "subdomains are not enabled on this server"))
      const body = await readJson(c, z.object({ label: z.string() }))
      if (body instanceof Response) return bail(body)
      const label = normalizeLabel(body.label)
      const invalid = labelError(label)
      if (invalid) return bail(fail(c, 400, invalid))
      const host = `${label}.${base}`
      const existing = await subdomainsOf(org)
      const same = existing.find((d) => d.host === host)
      if (same) {
        await release(
          existing.filter((d) => d !== same),
          org,
        )
        return c.json(subToJson(same, base))
      }
      // Plan gate before the namespace check, so a Free workspace hears about the
      // plan rather than about whether the label is free. The gate is on claiming
      // only: a lapsed plan keeps serving on its label (links must not break on a
      // failed card), unlike white-label, which is re-checked at render.
      if (!(await billingState(org)).customDomainEntitled)
        return bail(
          fail(c, 402, blockCopy.custom_domain.message, { code: blockCopy.custom_domain.code }),
        )
      // `host` is unique across every kind of domain row; a conflict is the 409.
      const created = await meta.setDomain({ host, org_id: org, kind: "subdomain" })
      if (!created) return bail(fail(c, 409, "that subdomain is taken"))
      // Insert first, then release: a refused claim leaves the old label in place.
      await release(existing, org)
      return c.json(subToJson(created, base), 201)
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
      const existing = await subdomainsOf(org)
      if (existing.length === 0) return bail(fail(c, 404, "not found"))
      await release(existing, org)
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
      // `*.<base>` is the subdomain namespace: label routes, reserved list, plan gate.
      if (base && host.endsWith(`.${base}`))
        return bail(fail(c, 400, `claim a ${base} name as your workspace subdomain instead`))
      const existing = await meta.getDomain(host)
      if (existing) {
        // Idempotent re-add: return the same shape as a fresh create (with cname_target)
        // so the client always has the DNS target to show, never a partial response.
        if (existing.org_id === org && existing.kind === "custom")
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
      if (!existing || existing.org_id !== org || existing.kind !== "custom")
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
      if (!existing || existing.org_id !== org || existing.kind !== "custom")
        return bail(fail(c, 404, "not found"))
      if (existing.cf_hostname_id && cd) await cd.remove(existing.cf_hostname_id).catch(() => {})
      await meta.deleteDomain(host, org)
      return c.json({ ok: true })
    },
  )

  return app
}
