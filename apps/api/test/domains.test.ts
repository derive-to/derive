import { join } from "node:path"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import type { CustomDomainProvider } from "../src/lib/cloudflare-saas"
import { as, dir, jsonAs, makeAuthedApp, meta, ownerApp } from "./helpers"

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

  it("serves the host root as a revalidating alias for the current version", async () => {
    // Named versions, so the inline-save window (which also revalidates) is not what
    // keeps these responses out of the immutable cache.
    const short = await publish("<h1>First cut</h1>", { visibility: "public", name: "First" })
    expect((await setLabel(short, "alias")).status).toBe(201)
    const first = await anon.request(`http://alias.${BASE}/`)
    expect(await first.text()).toContain("First cut")
    // The root is the same URL after every publish: a year-long immutable cache here
    // would keep showing the first cut to anyone who had opened it.
    expect(first.headers.get("cache-control")).toBe("no-cache")

    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>Second cut</h1>")]), "page.html")
    form.append("name", "Second")
    const next = await owner.request(`/v1/artifacts/${short}/versions`, {
      method: "POST",
      body: form,
    })
    expect(next.status).toBe(201)
    const second = await anon.request(`http://alias.${BASE}/`)
    expect(await second.text()).toContain("Second cut")
    expect(second.headers.get("cache-control")).toBe("no-cache")
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

describe("workspace subdomains (<label>.<base>/<ref>)", () => {
  const blobs = new FsBlobStore(join(dir, "blobs-workspace-subdomain"))
  const owner = ownerApp({ meta, blobs, baseUrl: "https://derive.test", subdomainBase: BASE })
  const anon = createApp({
    meta,
    blobs,
    baseUrl: "https://derive.test",
    subdomainBase: BASE,
    token: "tok",
  })
  const publish = async (content: string, fields: Record<string, string> = {}) => {
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode(content)]), "page.html")
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    return (await (await owner.request("/v1/artifacts", { method: "POST", body: form })).json())
      .short_id as string
  }
  const claim = (label: string) =>
    owner.request("/v1/workspace/subdomain", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    })
  const release = () => owner.request("/v1/workspace/subdomain", { method: "DELETE" })

  it("claims a label and serves every workspace artifact at <label>.<base>/<ref>", async () => {
    const short = await publish("<h1>Acme Q3</h1>", { visibility: "public", title: "Q3 Update" })
    const put = await claim("Acme")
    expect(put.status).toBe(201)
    const body = await put.json()
    expect(body).toMatchObject({ host: `acme.${BASE}`, label: "acme" })
    expect(body.url).toBe(`https://acme.${BASE}`)

    // The list reports the base + the one label alongside the custom domains.
    const list = await (await owner.request("/v1/workspace/domains")).json()
    expect(list.subdomain_base).toBe(BASE)
    expect(list.subdomain).toMatchObject({ host: `acme.${BASE}`, label: "acme" })
    // A subdomain is not a Cloudflare custom domain: it never appears in that list.
    expect(list.domains.map((d: { host: string }) => d.host)).not.toContain(`acme.${BASE}`)

    // Served by ref, and by the slugged ref.
    const served = await anon.request(`https://acme.${BASE}/${short}`)
    expect(served.status).toBe(200)
    expect(await served.text()).toContain("Acme Q3")
    expect((await anon.request(`https://acme.${BASE}/q3-update-${short}`)).status).toBe(200)

    // The artifact's own domain list shows the workspace subdomain URL ("Also at").
    const ad = await (await owner.request(`/v1/artifacts/${short}/domains`)).json()
    expect(ad.workspace_domains).toContainEqual({
      host: `acme.${BASE}`,
      url: `https://acme.${BASE}/q3-update-${short}`,
    })

    // The host root has nothing to show: bounce to the app, never "not found".
    const root = await anon.request(`https://acme.${BASE}/`)
    expect(root.status).toBe(302)
    expect(root.headers.get("location")).toBe("https://derive.test")
  })

  it("caches only settled pinned versions as immutable; bare refs and open pins revalidate", async () => {
    const short = await publish("<h1>Pinned</h1>", { visibility: "public", name: "Pinned" })
    const form = new FormData()
    form.append("file", new Blob([new TextEncoder().encode("<h1>Later</h1>")]), "page.html")
    form.append("name", "Later")
    expect(
      (await owner.request(`/v1/artifacts/${short}/versions`, { method: "POST", body: form }))
        .status,
    ).toBe(201)
    const bare = await anon.request(`https://acme.${BASE}/${short}`)
    expect(await bare.text()).toContain("Later")
    expect(bare.headers.get("cache-control")).toBe("no-cache")
    // v1 is superseded, so no save can change its bytes again: cache it hard.
    const pinned = await anon.request(`https://acme.${BASE}/${short}@v1`)
    expect(await pinned.text()).toContain("Pinned")
    expect(pinned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")

    // A pinned URL to an unnamed current web version is not final yet: an inline save
    // inside the edit window rewrites its bytes under the same @v1, so it revalidates.
    const open = await publish("<h1>Open</h1>", { visibility: "public" })
    const live = await anon.request(`https://acme.${BASE}/${open}@v1`)
    expect(await live.text()).toContain("Open")
    expect(live.headers.get("cache-control")).toBe("no-cache")
  })

  it("is idempotent, rejects invalid + reserved labels, and 409s a taken label", async () => {
    expect((await claim("acme")).status).toBe(200) // already ours
    expect((await claim("Not Valid!")).status).toBe(400)
    expect((await claim("login")).status).toBe(400) // reserved
    expect((await claim("www")).status).toBe(400)
    // An artifact-level vanity subdomain holds the same namespace.
    const short = await publish("<p>x</p>", { visibility: "public" })
    await owner.request(`/v1/artifacts/${short}/domains`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "launchpad" }),
    })
    expect((await claim("launchpad")).status).toBe(409)
    // And a workspace label blocks an artifact claiming it.
    const art = await owner.request(`/v1/artifacts/${short}/domains`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "acme" }),
    })
    expect(art.status).toBe(409)
  })

  it("swapping the label releases the old host", async () => {
    const short = await publish("<h1>Swap</h1>", { visibility: "public" })
    expect((await anon.request(`https://acme.${BASE}/${short}`)).status).toBe(200)
    const put = await claim("acme-corp")
    expect(put.status).toBe(201)
    expect((await anon.request(`https://acme-corp.${BASE}/${short}`)).status).toBe(200)
    expect((await anon.request(`https://acme.${BASE}/${short}`)).status).toBe(404)
    const list = await (await owner.request("/v1/workspace/domains")).json()
    expect(list.subdomain.label).toBe("acme-corp")
  })

  it("never serves another workspace's artifact, nor a gated one, under the label", async () => {
    const short = await publish("<h1>Mine</h1>", { visibility: "public" })
    const gated = await publish("<h1>Secret</h1>", { visibility: "org" })
    await meta.setDomain({ host: `other.${BASE}`, org_id: "other-org", kind: "subdomain" })
    expect(await (await anon.request(`https://other.${BASE}/${short}`)).text()).not.toContain(
      "Mine",
    )
    expect((await anon.request(`https://acme-corp.${BASE}/${gated}`)).status).toBe(404)
  })

  it("releasing the label stops serving, clears any stray row, and 404s when there is none", async () => {
    const short = await publish("<h1>Bye</h1>", { visibility: "public" })
    // A swap that inserted its new row but failed to delete the old one leaves two;
    // the newest is what the list reports and a release clears both.
    await meta.setDomain({ host: `stray.${BASE}`, org_id: "default", kind: "subdomain" })
    const list = await (await owner.request("/v1/workspace/domains")).json()
    expect(list.subdomain.label).toBe("stray")
    expect((await release()).status).toBe(200)
    expect((await anon.request(`https://acme-corp.${BASE}/${short}`)).status).toBe(404)
    expect((await anon.request(`https://stray.${BASE}/${short}`)).status).toBe(404)
    expect((await release()).status).toBe(404)
    const after = await (await owner.request("/v1/workspace/domains")).json()
    expect(after.subdomain).toBeNull()
  })

  it("501s when the server has no subdomain base", async () => {
    const plain = ownerApp({ meta, blobs, baseUrl: "https://derive.test" })
    const res = await plain.request("/v1/workspace/subdomain", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "nobase" }),
    })
    expect(res.status).toBe(501)
    const list = await (await plain.request("/v1/workspace/domains")).json()
    expect(list.subdomain_base).toBeNull()
  })

  it("needs the manage role: an editor can neither claim nor release", async () => {
    const u = (n: number) => ({ id: `sd${n}`, email: `sd${n}@x.test`, name: `SD${n}` })
    const { app } = makeAuthedApp("subdomain_role", [u(1), u(2)], "editor", {
      deps: { subdomainBase: BASE },
    })
    const editor = as("sd2@x.test")
    expect(
      (await app.request("/v1/workspace/subdomain", jsonAs(editor, { label: "ed" }, "PUT"))).status,
    ).toBe(403)
    expect(
      (await app.request("/v1/workspace/subdomain", { method: "DELETE", headers: editor })).status,
    ).toBe(403)
  })

  it("keeps the custom-domain routes off the subdomain namespace", async () => {
    // Both kinds enabled: a subdomain row must be invisible to the Cloudflare routes.
    const cf: CustomDomainProvider = {
      cnameTarget: "derive-saas.test",
      create: async (host) => ({ cfHostnameId: `cf_${host}`, status: "active", records: [] }),
      refresh: async (id) => ({ cfHostnameId: id, status: "active", records: [] }),
      remove: async () => {},
    }
    const both = ownerApp({
      meta,
      blobs,
      baseUrl: "https://derive.test",
      subdomainBase: BASE,
      customDomains: cf,
    })
    const bothAnon = createApp({
      meta,
      blobs,
      baseUrl: "https://derive.test",
      subdomainBase: BASE,
      customDomains: cf,
      token: "tok",
    })
    const json = (path: string, method: string, body?: unknown) =>
      both.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      })
    expect((await json("/v1/workspace/subdomain", "PUT", { label: "twin" })).status).toBe(201)
    // A `.<base>` host is not a custom domain; the label routes own that namespace.
    expect((await json("/v1/workspace/domains", "POST", { host: `twin.${BASE}` })).status).toBe(400)
    expect((await json("/v1/workspace/domains", "POST", { host: `other.${BASE}` })).status).toBe(
      400,
    )
    // The custom-domain DELETE and refresh do not see the subdomain row.
    expect((await json(`/v1/workspace/domains/twin.${BASE}`, "DELETE")).status).toBe(404)
    expect((await json(`/v1/workspace/domains/twin.${BASE}/refresh`, "POST", {})).status).toBe(404)
    const list = await (await both.request("/v1/workspace/domains")).json()
    expect(list.subdomain.label).toBe("twin")
    // A customer's own domain has no page at its root and never bounces to us.
    await json("/v1/workspace/domains", "POST", { host: "docs.twin.test" })
    expect((await bothAnon.request("https://docs.twin.test/")).status).toBe(404)
    expect((await bothAnon.request(`https://twin.${BASE}/`)).status).toBe(302)
    await json("/v1/workspace/subdomain", "DELETE")
    await json("/v1/workspace/domains/docs.twin.test", "DELETE")
  })
})
