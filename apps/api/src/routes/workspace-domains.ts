import type { DomainRecord } from "@dock/core"
import { Hono } from "hono"
import { z } from "zod"
import type { AppContext } from "../context"
import { fail, readJson } from "../lib/http"

// A fully-qualified domain (at least one dot).
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
 * Workspace custom domains (the easy "slap your own URL on it" path). An admin
 * attaches their domain to the workspace once; Cloudflare for SaaS issues + renews
 * the cert, and every artifact is then served at `<domain>/<ref>` (the host-dispatch
 * in app.ts does the routing). Bound to the workspace (org), not a single artifact,
 * so the `domain` row has a null artifact_id. Gated on workspace `manage`.
 */
export const workspaceDomainRoutes = (ctx: AppContext) => {
  const { meta, activeWorkspace, workspaceCan } = ctx
  const cd = ctx.deps.customDomains
  const app = new Hono()

  const toJson = (d: DomainRecord) => ({
    host: d.host,
    status: d.status,
    records: parseRecords(d.verification),
    created_at: d.created_at,
  })

  // The workspace's custom domains + whether the server supports them.
  app.get("/v1/workspace/domains", async (c) => {
    const org = await activeWorkspace(c)
    const domains = await meta.getWorkspaceDomains(org)
    return c.json({
      enabled: !!cd,
      cname_target: cd?.cnameTarget ?? null,
      domains: domains.map(toJson),
    })
  })

  // Attach a domain to the workspace. Registers a Cloudflare custom hostname and
  // stores it `pending` with the DNS to display; it serves once CF validates the cert.
  app.post("/v1/workspace/domains", async (c) => {
    if (!cd) return fail(c, 501, "custom domains are not enabled on this server")
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const org = await activeWorkspace(c)
    const body = await readJson(c, z.object({ host: z.string() }))
    if (body instanceof Response) return body
    const host = body.host
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/\.+$/, "")
    if (!FQDN.test(host)) return fail(c, 400, "enter a valid domain you control")
    const existing = await meta.getDomain(host)
    if (existing)
      return existing.org_id === org && !existing.artifact_id
        ? c.json(toJson(existing))
        : fail(c, 409, "that domain is already in use")
    let state: Awaited<ReturnType<typeof cd.create>>
    try {
      state = await cd.create(host)
    } catch (e) {
      return fail(c, 502, e instanceof Error ? e.message : "couldn't register the domain")
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
      return fail(c, 409, "that domain is already in use")
    }
    return c.json({ ...toJson(created), cname_target: cd.cnameTarget }, 201)
  })

  // Re-check a domain's validation status against Cloudflare.
  app.post("/v1/workspace/domains/:host/refresh", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const org = await activeWorkspace(c)
    const existing = await meta.getDomain(c.req.param("host").toLowerCase())
    if (!existing || existing.org_id !== org || existing.artifact_id)
      return fail(c, 404, "not found")
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
  })

  // Detach a domain (tears down the Cloudflare hostname too).
  app.delete("/v1/workspace/domains/:host", async (c) => {
    if (!(await workspaceCan(c, "manage"))) return fail(c, 403, "forbidden")
    const org = await activeWorkspace(c)
    const host = c.req.param("host").toLowerCase()
    const existing = await meta.getDomain(host)
    if (!existing || existing.org_id !== org || existing.artifact_id)
      return fail(c, 404, "not found")
    if (existing.cf_hostname_id && cd) await cd.remove(existing.cf_hostname_id).catch(() => {})
    await meta.deleteDomain(host, org)
    return c.json({ ok: true })
  })

  return app
}
