import { join } from "node:path"
import { FsBlobStore } from "@dock/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import type { CustomDomainProvider } from "../src/lib/cloudflare-saas"
import { dir, meta, ownerApp } from "./helpers"

// A controllable fake Cloudflare for SaaS provider: create returns pending, refresh
// flips to active once `activate()` is called, remove records the torn-down id.
const makeFakeCf = () => {
  const removed: string[] = []
  let active = false
  const records = (host: string) => [
    { type: "CNAME" as const, name: host, value: "dock-saas.test" },
    { type: "TXT" as const, name: `_cf.${host}`, value: "v=token" },
  ]
  const cf: CustomDomainProvider = {
    cnameTarget: "dock-saas.test",
    create: async (host) => ({
      cfHostnameId: `cf_${host}`,
      status: "pending",
      records: records(host),
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
  const res = await app.request("/v1/artifacts", { method: "POST", body: form })
  return (await res.json()).short_id
}
const postJson = (app: ReturnType<typeof ownerApp>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("custom domains (Cloudflare for SaaS)", () => {
  it("attaches a domain (pending) with the DNS records, then serves it once active", async () => {
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

    const res = await postJson(owner, `/v1/artifacts/${short}/custom-domains`, {
      host: "launch.acme.com",
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ host: "launch.acme.com", kind: "custom", status: "pending" })
    expect(body.cname_target).toBe("dock-saas.test")
    expect(body.records).toEqual(
      expect.arrayContaining([{ type: "CNAME", name: "launch.acme.com", value: "dock-saas.test" }]),
    )

    // Pending → the host does NOT serve the artifact yet (falls through).
    expect(await (await anon.request("https://launch.acme.com/")).text()).not.toContain(
      "Acme Launch",
    )

    // Validate via CF, refresh → active → now it serves at the host root.
    activate()
    const refreshed = await postJson(
      owner,
      `/v1/artifacts/${short}/domains/launch.acme.com/refresh`,
      {},
    )
    expect((await refreshed.json()).status).toBe("active")
    const served = await anon.request("https://launch.acme.com/")
    expect(served.status).toBe(200)
    expect(await served.text()).toContain("Acme Launch")
  })

  it("lists custom-domain support + the attached domain", async () => {
    const { cf } = makeFakeCf()
    const owner = ownerApp({ meta, blobs, baseUrl: "https://dock.test", customDomains: cf })
    const short = await publish(owner, "<p>x</p>", { visibility: "public" })
    await postJson(owner, `/v1/artifacts/${short}/custom-domains`, { host: "docs.acme.com" })
    const list = await (await owner.request(`/v1/artifacts/${short}/domains`)).json()
    expect(list.custom_enabled).toBe(true)
    expect(list.cname_target).toBe("dock-saas.test")
    expect(list.domains.find((d: { host: string }) => d.host === "docs.acme.com").status).toBe(
      "pending",
    )
  })

  it("rejects invalid hosts and a host already attached elsewhere", async () => {
    const { cf } = makeFakeCf()
    const owner = ownerApp({ meta, blobs, baseUrl: "https://dock.test", customDomains: cf })
    const a = await publish(owner, "<p>a</p>", { visibility: "public" })
    const b = await publish(owner, "<p>b</p>", { visibility: "public" })
    expect(
      (await postJson(owner, `/v1/artifacts/${a}/custom-domains`, { host: "nodot" })).status,
    ).toBe(400)
    expect(
      (await postJson(owner, `/v1/artifacts/${a}/custom-domains`, { host: "dup.acme.com" })).status,
    ).toBe(201)
    expect(
      (await postJson(owner, `/v1/artifacts/${b}/custom-domains`, { host: "dup.acme.com" })).status,
    ).toBe(409)
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
    await postJson(owner, `/v1/artifacts/${short}/custom-domains`, { host: "gone.acme.com" })
    await postJson(owner, `/v1/artifacts/${short}/domains/gone.acme.com/refresh`, {})
    expect((await anon.request("https://gone.acme.com/")).status).toBe(200)
    const del = await owner.request(`/v1/artifacts/${short}/domains/gone.acme.com`, {
      method: "DELETE",
    })
    expect(del.status).toBe(200)
    expect(removed).toContain("cf_gone.acme.com")
    expect(await (await anon.request("https://gone.acme.com/")).text()).not.toContain("Bye")
  })

  it("501s when Cloudflare for SaaS is not configured", async () => {
    const owner = ownerApp({ meta, blobs, baseUrl: "https://dock.test" })
    const short = await publish(owner, "<p>x</p>", { visibility: "public" })
    const res = await postJson(owner, `/v1/artifacts/${short}/custom-domains`, {
      host: "x.acme.com",
    })
    expect(res.status).toBe(501)
  })
})
