import { join } from "node:path"
import { FsBlobStore } from "@dock/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import type { CustomDomainProvider } from "../src/lib/cloudflare-saas"
import { dir, meta, ownerApp } from "./helpers"

// A controllable fake Cloudflare for SaaS provider: create → pending, refresh flips
// to active after activate(), remove records the torn-down id.
const makeFakeCf = () => {
  const removed: string[] = []
  let active = false
  const cf: CustomDomainProvider = {
    cnameTarget: "dock-saas.test",
    create: async (host) => ({
      cfHostnameId: `cf_${host}`,
      status: "pending",
      records: [
        { type: "CNAME", name: host, value: "dock-saas.test" },
        { type: "TXT", name: `_cf.${host}`, value: "v=token" },
      ],
    }),
    refresh: async (id) => ({
      cfHostnameId: id,
      status: active ? "active" : "pending",
      records: [],
    }),
    remove: async (id) => {
      removed.push(id)
    },
  }
  return {
    cf,
    removed,
    activate: () => {
      active = true
    },
  }
}

const blobs = new FsBlobStore(join(dir, "blobs-custom-domains"))

const publish = async (
  app: ReturnType<typeof ownerApp>,
  content: string,
  fields: Record<string, string> = {},
): Promise<string> => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(content)]), "page.html")
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return (await (await app.request("/v1/artifacts", { method: "POST", body: form })).json())
    .short_id
}
const postJson = (app: ReturnType<typeof ownerApp>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("workspace custom domains (Cloudflare for SaaS)", () => {
  it("attaches a workspace domain, validates, and serves artifacts at <domain>/<ref>", async () => {
    const { cf, activate } = makeFakeCf()
    const owner = ownerApp({ meta, blobs, baseUrl: "https://dock.test", customDomains: cf })
    const anon = createApp({
      meta,
      blobs,
      baseUrl: "https://dock.test",
      token: "tok",
      customDomains: cf,
    })
    const short = await publish(owner, "<h1>Acme Launch</h1>", {
      visibility: "public",
      title: "Launch",
    })

    const res = await postJson(owner, "/v1/workspace/domains", { host: "docs.acme.com" })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ host: "docs.acme.com", status: "pending" })
    expect(body.cname_target).toBe("dock-saas.test")
    expect(body.records).toEqual(
      expect.arrayContaining([{ type: "CNAME", name: "docs.acme.com", value: "dock-saas.test" }]),
    )

    // Pending → not served yet.
    expect(await (await anon.request(`https://docs.acme.com/${short}`)).text()).not.toContain(
      "Acme Launch",
    )

    // Validate via CF → active → the workspace's artifact serves under the domain.
    activate()
    expect(
      (await (await postJson(owner, "/v1/workspace/domains/docs.acme.com/refresh", {})).json())
        .status,
    ).toBe("active")
    const served = await anon.request(`https://docs.acme.com/${short}`)
    expect(served.status).toBe(200)
    expect(await served.text()).toContain("Acme Launch")
  })

  it("lists workspace domains + surfaces them read-only on the artifact's share data", async () => {
    const { cf, activate } = makeFakeCf()
    activate()
    const owner = ownerApp({ meta, blobs, baseUrl: "https://dock.test", customDomains: cf })
    const short = await publish(owner, "<p>x</p>", { visibility: "public" })
    await postJson(owner, "/v1/workspace/domains", { host: "pages.acme.com" })
    await postJson(owner, "/v1/workspace/domains/pages.acme.com/refresh", {})

    const ws = await (await owner.request("/v1/workspace/domains")).json()
    expect(ws.enabled).toBe(true)
    expect(ws.domains.find((d: { host: string }) => d.host === "pages.acme.com").status).toBe(
      "active",
    )

    // The per-artifact share data shows the artifact's URL on the workspace domain.
    const art = await (await owner.request(`/v1/artifacts/${short}/domains`)).json()
    const wd = art.workspace_domains.find((d: { host: string }) => d.host === "pages.acme.com")
    expect(wd?.url).toMatch(new RegExp(`^https://pages\\.acme\\.com/${short}`))
  })

  it("never serves one workspace's artifact under another workspace's domain", async () => {
    const { cf } = makeFakeCf()
    const owner = ownerApp({ meta, blobs, baseUrl: "https://dock.test", customDomains: cf })
    const anon = createApp({
      meta,
      blobs,
      baseUrl: "https://dock.test",
      token: "tok",
      customDomains: cf,
    })
    const short = await publish(owner, "<h1>Mine</h1>", { visibility: "public" })
    // A domain owned by a different workspace, active.
    await meta.setDomain({
      host: "evil.test",
      org_id: "other-org",
      kind: "custom",
      status: "active",
      cf_hostname_id: "cf_evil",
    })
    expect(await (await anon.request(`https://evil.test/${short}`)).text()).not.toContain("Mine")
  })

  it("tears down the Cloudflare hostname on delete and stops serving", async () => {
    const { cf, removed, activate } = makeFakeCf()
    activate()
    const owner = ownerApp({ meta, blobs, baseUrl: "https://dock.test", customDomains: cf })
    const anon = createApp({
      meta,
      blobs,
      baseUrl: "https://dock.test",
      token: "tok",
      customDomains: cf,
    })
    const short = await publish(owner, "<h1>Bye</h1>", { visibility: "public" })
    await postJson(owner, "/v1/workspace/domains", { host: "gone.acme.com" })
    await postJson(owner, "/v1/workspace/domains/gone.acme.com/refresh", {})
    expect((await anon.request(`https://gone.acme.com/${short}`)).status).toBe(200)
    const del = await owner.request("/v1/workspace/domains/gone.acme.com", { method: "DELETE" })
    expect(del.status).toBe(200)
    expect(removed).toContain("cf_gone.acme.com")
    expect(await (await anon.request(`https://gone.acme.com/${short}`)).text()).not.toContain("Bye")
  })

  it("rejects invalid hosts, a host in use, and 501s when CF is unconfigured", async () => {
    const { cf } = makeFakeCf()
    const owner = ownerApp({ meta, blobs, baseUrl: "https://dock.test", customDomains: cf })
    expect((await postJson(owner, "/v1/workspace/domains", { host: "nodot" })).status).toBe(400)
    expect((await postJson(owner, "/v1/workspace/domains", { host: "dup.acme.com" })).status).toBe(
      201,
    )
    expect((await postJson(owner, "/v1/workspace/domains", { host: "dup.acme.com" })).status).toBe(
      200,
    )
    const noCf = ownerApp({ meta, blobs, baseUrl: "https://dock.test" })
    expect((await postJson(noCf, "/v1/workspace/domains", { host: "x.acme.com" })).status).toBe(501)
  })
})
