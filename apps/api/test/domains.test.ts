import { join } from "node:path"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
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

  it("404s an unknown subdomain", async () => {
    expect((await anon.request(`http://nope.${BASE}/`)).status).toBe(404)
  })

  it("301s the base apex and www to the app origin", async () => {
    for (const host of [BASE, `www.${BASE}`]) {
      const res = await anon.request(`http://${host}/anything`)
      expect(res.status).toBe(301)
      expect(res.headers.get("location")).toBe("http://derive.test")
    }
  })

  it("rejects the sandbox host's label as reserved", async () => {
    const short = await publish("<p>x</p>", { visibility: "public" })
    expect((await setLabel(short, "raw")).status).toBe(400)
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

  it("501s when the server has no base domain configured", async () => {
    const noBase = ownerApp({ meta, blobs, baseUrl: "http://derive.test" })
    const short = await publish("<p>x</p>", { visibility: "public" })
    const res = await noBase.request(`/v1/artifacts/${short}/domains`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    })
    expect(res.status).toBe(501)
  })
})
