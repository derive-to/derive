import { join } from "node:path"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import type { CustomDomainProvider } from "../src/lib/cloudflare-saas"
import { dir, meta, ownerApp } from "./helpers"

const BASE = "derived.app"
const blobs = new FsBlobStore(join(dir, "blobs-domains"))
// Owner (token-authed) sets domains + publishes; anon serves them like the public.
const owner = ownerApp({ meta, blobs, baseUrl: "http://derive.test", subdomainBase: BASE })
const anon = createApp({
  meta,
  blobs,
  baseUrl: "http://derive.test",
  subdomainBase: BASE,
  token: "tok",
})

const publish = async (content: string, fields: Record<string, string> = {}): Promise<string> => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(content)]), "page.html")
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  const res = await owner.request("/v1/artifacts", { method: "POST", body: form })
  return (await res.json()).short_id
}
const setLabel = (short: string, label: string) =>
  owner.request(`/v1/artifacts/${short}/domains`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label }),
  })

describe("vanity subdomains", () => {
  it("assigns a subdomain and serves the artifact at its host root", async () => {
    const short = await publish("<h1>Launch</h1>", { visibility: "public", title: "Launch" })
    const put = await setLabel(short, "launch")
    expect(put.status).toBe(201)
    expect((await put.json()).host).toBe(`launch.${BASE}`)

    const list = await owner.request(`/v1/artifacts/${short}/domains`)
    expect((await list.json()).domains[0].host).toBe(`launch.${BASE}`)

    // The public, at the vanity host root, gets the artifact bytes (no /raw prefix).
    const served = await anon.request(`http://launch.${BASE}/`)
    expect(served.status).toBe(200)
    expect(served.headers.get("content-type")).toContain("text/html")
    const html = await served.text()
    expect(html).toContain("Launch")
    // The draft discovery chip is drafts-only: a claimed artifact on its vanity
    // host serves clean bytes with no injected attribution.
    expect(html).not.toContain("data-derive-draft-chip")
  })

  it("409s a label already taken by another artifact", async () => {
    const a = await publish("<p>a</p>", { visibility: "public" })
    const b = await publish("<p>b</p>", { visibility: "public" })
    expect((await setLabel(a, "dup")).status).toBe(201)
    expect((await setLabel(b, "dup")).status).toBe(409)
  })

  it("is idempotent for the same artifact, and rejects invalid + reserved labels", async () => {
    const short = await publish("<p>x</p>", { visibility: "public" })
    expect((await setLabel(short, "mine")).status).toBe(201)
    expect((await setLabel(short, "mine")).status).toBe(200) // already yours
    expect((await setLabel(short, "Bad Label!")).status).toBe(400)
    expect((await setLabel(short, "www")).status).toBe(400) // reserved
  })

  it("never serves a gated artifact to the anonymous public", async () => {
    const short = await publish("<p>secret</p>", { visibility: "org", title: "Secret" })
    expect((await setLabel(short, "private")).status).toBe(201)
    expect((await anon.request(`http://private.${BASE}/`)).status).toBe(404)
  })

  it("releases a subdomain", async () => {
    const short = await publish("<p>x</p>", { visibility: "public" })
    await setLabel(short, "temp")
    const del = await owner.request(`/v1/artifacts/${short}/domains/temp.${BASE}`, {
      method: "DELETE",
    })
    expect(del.status).toBe(200)
    expect((await anon.request(`http://temp.${BASE}/`)).status).toBe(404)
  })
})

describe("workspace custom domains (Cloudflare for SaaS)", () => {
  // A controllable fake Cloudflare for SaaS provider: create → pending, refresh flips
  // to active after activate(), remove records the torn-down id.
  const makeFakeCf = () => {
    const removed: string[] = []
    let active = false
    const cf: CustomDomainProvider = {
      cnameTarget: "derive-saas.test",
      create: async (host) => ({
        cfHostnameId: `cf_${host}`,
        status: "pending",
        records: [
          { type: "CNAME", name: host, value: "derive-saas.test" },
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

  it("attaches a workspace domain, validates, and serves artifacts at <domain>/<ref>", async () => {
    const { cf, activate } = makeFakeCf()
    const owner = ownerApp({ meta, blobs, baseUrl: "https://derive.test", customDomains: cf })
    const anon = createApp({
      meta,
      blobs,
      baseUrl: "https://derive.test",
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
    expect(body.cname_target).toBe("derive-saas.test")
    expect(body.records).toEqual(
      expect.arrayContaining([{ type: "CNAME", name: "docs.acme.com", value: "derive-saas.test" }]),
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

  it("never serves one workspace's artifact under another workspace's domain", async () => {
    const { cf } = makeFakeCf()
    const owner = ownerApp({ meta, blobs, baseUrl: "https://derive.test", customDomains: cf })
    const anon = createApp({
      meta,
      blobs,
      baseUrl: "https://derive.test",
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
    const owner = ownerApp({ meta, blobs, baseUrl: "https://derive.test", customDomains: cf })
    const anon = createApp({
      meta,
      blobs,
      baseUrl: "https://derive.test",
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
})
