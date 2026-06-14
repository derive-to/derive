import { join } from "node:path"
import { FsBlobStore } from "@dock/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { anonApp, app, dir, meta, upload } from "./helpers"

const idOf = async (res: Response): Promise<string> => (await res.json()).short_id
const SHELL =
  "<!doctype html><html><head><title>Dock</title></head><body><div id=root></div></body></html>"

describe("unfurl + embed", () => {
  it("serves the OG card as an SVG with the title for a public artifact", async () => {
    const short = await idOf(
      await upload("p.md", "# Hello", { visibility: "public", title: "My Report" }),
    )
    const res = await app.request(`/v1/og/${short}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("image/svg+xml")
    const svg = await res.text()
    expect(svg).toContain("<svg")
    expect(svg).toContain("My Report")
  })

  it("oembed returns a rich response with a sandboxed iframe", async () => {
    const short = await idOf(await upload("o.md", "# Hi", { visibility: "public", title: "Deck" }))
    const res = await app.request(
      `/v1/oembed?url=${encodeURIComponent(`http://dock.test/a/${short}`)}`,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      version: "1.0",
      type: "rich",
      provider_name: "Dock",
      title: "Deck",
    })
    expect(body.html).toContain("<iframe")
    expect(body.html).toContain(`/v1/embed/${short}`)
  })

  it("oembed rejects a non-artifact url and a missing url", async () => {
    expect((await app.request("/v1/oembed")).status).toBe(400)
    const bad = await app.request(
      `/v1/oembed?url=${encodeURIComponent("http://dock.test/settings")}`,
    )
    expect(bad.status).toBe(404)
  })

  it("oembed 404s for a private artifact to an anonymous consumer", async () => {
    const short = await idOf(
      await upload("priv.md", "# secret", { visibility: "org", title: "Secret" }),
    )
    const res = await anonApp.request(
      `/v1/oembed?url=${encodeURIComponent(`http://dock.test/a/${short}`)}`,
    )
    expect(res.status).toBe(404)
  })

  it("renders the embeddable view with the artifact iframe and a view-on-Dock link", async () => {
    const short = await idOf(
      await upload("e.md", "# Hi", { visibility: "public", title: "Embed Me" }),
    )
    const res = await app.request(`/v1/embed/${short}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    // Frameable by design: no X-Frame-Options, an explicit frame-ancestors *.
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors *")
    const html = await res.text()
    expect(html).toContain("<iframe")
    expect(html).toContain("View on Dock")
    expect(html).toContain("Embed Me")
    expect(html).toContain(`/raw/${short}/v/`)
  })

  it("hides the title from an anonymous viewer of a private artifact's OG card", async () => {
    const short = await idOf(
      await upload("h.md", "# secret", { visibility: "org", title: "Hush Hush" }),
    )
    const svg = await (await anonApp.request(`/v1/og/${short}`)).text()
    expect(svg).not.toContain("Hush Hush")
    expect(svg).toContain("private")
  })

  it("injects unfurl meta into the /a/:ref shell for a public artifact", async () => {
    const a = createApp({
      meta,
      blobs: new FsBlobStore(join(dir, "blobs-embed-shell")),
      baseUrl: "http://dock.test",
      token: "tok",
      shell: SHELL,
    })
    const short = await idOf(
      await upload("s.md", "# Hi", { visibility: "public", title: "Shared Page" }),
    )
    const res = await a.request(`/a/${short}`, { headers: { authorization: "Bearer tok" } })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('property="og:title"')
    expect(html).toContain("Shared Page")
    expect(html).toContain("application/json+oembed")
    // Still the SPA shell — humans get the app.
    expect(html).toContain("id=root")
  })

  it("injects via an async shell provider (the edge Worker's ASSETS path)", async () => {
    const a = createApp({
      meta,
      blobs: new FsBlobStore(join(dir, "blobs-embed-shellfetch")),
      baseUrl: "http://dock.test",
      token: "tok",
      // No sync `shell`: only the async provider, as the Worker wires it.
      shellFetch: async () => SHELL,
    })
    const short = await idOf(
      await upload("sf.md", "# Hi", { visibility: "public", title: "Worker Page" }),
    )
    const res = await a.request(`/a/${short}`, { headers: { authorization: "Bearer tok" } })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('property="og:title"')
    expect(html).toContain("Worker Page")
  })

  it("serves the bare shell (no leaked meta) for a private artifact to anon", async () => {
    const a = createApp({
      meta,
      blobs: new FsBlobStore(join(dir, "blobs-embed-shell2")),
      baseUrl: "http://dock.test",
      token: "tok",
      shell: SHELL,
    })
    const short = await idOf(
      await upload("s2.md", "# secret", { visibility: "org", title: "Private Page" }),
    )
    const res = await a.request(`/a/${short}`) // anonymous (no token header)
    const html = await res.text()
    expect(html).not.toContain("og:title")
    expect(html).not.toContain("Private Page")
  })
})
