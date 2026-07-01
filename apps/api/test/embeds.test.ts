import { join } from "node:path"
import { newId } from "@derive/core"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { anonApp, app, dir, makeAuthedApp, meta, type TestUser, upload } from "./helpers"

const idOf = async (res: Response): Promise<string> => (await res.json()).short_id
const SHELL =
  "<!doctype html><html><head><title>Derive</title></head><body><div id=root></div></body></html>"

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
      `/v1/oembed?url=${encodeURIComponent(`http://derive.test/a/${short}`)}`,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      version: "1.0",
      type: "rich",
      provider_name: "Derive",
      title: "Deck",
    })
    expect(body.html).toContain("<iframe")
    // Name-first ref: the embed URL is /v1/embed/<slug>-<short_id>.
    expect(body.html).toContain(`/v1/embed/deck-${short}`)
  })

  it("oembed rejects a non-artifact url and a missing url", async () => {
    expect((await app.request("/v1/oembed")).status).toBe(400)
    const bad = await app.request(
      `/v1/oembed?url=${encodeURIComponent("http://derive.test/settings")}`,
    )
    expect(bad.status).toBe(404)
  })

  it("oembed 404s for a private artifact to an anonymous consumer", async () => {
    const short = await idOf(
      await upload("priv.md", "# secret", { visibility: "org", title: "Secret" }),
    )
    const res = await anonApp.request(
      `/v1/oembed?url=${encodeURIComponent(`http://derive.test/a/${short}`)}`,
    )
    expect(res.status).toBe(404)
  })

  it("renders the embeddable view with the artifact iframe and a view-on-Derive link", async () => {
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
    expect(html).toContain("View on Derive")
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
      baseUrl: "http://derive.test",
      token: "tok",
      shell: SHELL,
    })
    const short = await idOf(
      await upload("s.md", "# Hi", { visibility: "public", title: "Shared Page" }),
    )
    // A bare ref 302s to the canonical name-first URL; the unfurl meta lives there.
    const bare = await a.request(`/a/${short}`, { headers: { authorization: "Bearer tok" } })
    expect(bare.status).toBe(302)
    const res = await a.request(bare.headers.get("location") ?? "", {
      headers: { authorization: "Bearer tok" },
    })
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
      baseUrl: "http://derive.test",
      token: "tok",
      // No sync `shell`: only the async provider, as the Worker wires it.
      shellFetch: async () => SHELL,
    })
    const short = await idOf(
      await upload("sf.md", "# Hi", { visibility: "public", title: "Worker Page" }),
    )
    // A bare ref 302s to the canonical name-first URL; the unfurl meta lives there.
    const bare = await a.request(`/a/${short}`, { headers: { authorization: "Bearer tok" } })
    expect(bare.status).toBe(302)
    const res = await a.request(bare.headers.get("location") ?? "", {
      headers: { authorization: "Bearer tok" },
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('property="og:title"')
    expect(html).toContain("Worker Page")
  })

  it("serves the bare shell (no leaked meta) for a private artifact to anon", async () => {
    const a = createApp({
      meta,
      blobs: new FsBlobStore(join(dir, "blobs-embed-shell2")),
      baseUrl: "http://derive.test",
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

describe("profile unfurl (/u/:handle)", () => {
  const nia: TestUser = {
    id: "u_og_nia",
    email: "ognia@d.test",
    name: "Nia Okoye",
    username: "niao",
  }
  const { app: authed, meta: m } = makeAuthedApp("og-profile", [nia])

  // One public artifact authored by Nia, so the card/stats show "1 work".
  const seedWork = async () => {
    const art = await m.createArtifact({
      id: newId("a"),
      short_id: newId("s"),
      org_id: "default",
      slug: null,
      title: "Nia's doc",
      visibility: "public",
      kind: "file",
      spa: 0,
    })
    await m.addVersion(art.id, {
      id: newId("v"),
      blob_key: `blob_${newId("b")}`,
      content_type: "text/markdown",
      size_bytes: 1,
      author: "Nia Okoye",
      author_id: nia.id,
      message: null,
    })
  }

  it("renders the profile OG card SVG (name + work count)", async () => {
    await seedWork()
    const res = await authed.request("/v1/og/u/niao")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("image/svg+xml")
    const svg = await res.text()
    expect(svg).toContain("<svg")
    expect(svg).toContain("Nia Okoye")
    expect(svg).toContain("@niao")
    expect(svg).toContain("1 work")
  })

  it("injects profile OG meta into the /u/:handle shell for crawlers", async () => {
    const a = createApp({
      meta: m,
      blobs: new FsBlobStore(join(dir, "blobs-og-profile-shell")),
      baseUrl: "http://derive.test",
      token: "tok",
      auth: undefined,
      shell: SHELL,
      defaultOrgId: "default",
    })
    const res = await a.request("/u/niao")
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('property="og:type" content="profile"')
    expect(html).toContain("Nia Okoye (@niao)")
    expect(html).toContain("/v1/og/u/niao")
    expect(html).toContain("id=root") // still the SPA shell for humans
  })

  it("serves a generic card + bare shell for an unclaimed handle (no leak)", async () => {
    const svg = await (await app.request("/v1/og/u/ghosthandle")).text()
    expect(svg).toContain("<svg")
    const a = createApp({
      meta,
      blobs: new FsBlobStore(join(dir, "blobs-og-profile-ghost")),
      baseUrl: "http://derive.test",
      token: "tok",
      shell: SHELL,
    })
    const html = await (await a.request("/u/ghosthandle")).text()
    expect(html).not.toContain("og:type")
    expect(html).toContain("id=root")
  })
})
