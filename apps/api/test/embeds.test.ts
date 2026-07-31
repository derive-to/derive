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

  it("a slot-bearing artifact leads its unfurl with its own numbers", async () => {
    // The single highest-leverage incentive in the whole slots bet: a link pasted in Slack
    // shows "pass 48 · fail 0" before anyone clicks, which is the mechanic that made
    // OpenGraph universal. It reaches the card through infoFor → dataSummary, and until
    // now NOTHING asserted it — so any refactor of the unfurl path could delete the
    // feature and leave every test green. It very nearly did: a concurrent PR extracts
    // infoFor into a shared lib from a copy that predates the slot read.
    const page =
      "<!doctype html><html><body><h1>Nightly</h1>" +
      '<script type="application/derive-data" data-slot="checks">{"pass":48,"fail":0}</script>' +
      "</body></html>"
    const short = await idOf(
      await upload("nightly.html", page, { visibility: "public", title: "Nightly checks" }),
    )
    // The OG card image a surface renders directly.
    const svg = await (await app.request(`/v1/og/${short}`)).text()
    expect(svg).toContain("pass 48")
    expect(svg).toContain("fail 0")

    // ...and og:description in the server-rendered head, which is what a crawler that
    // does not run JS actually reads. The numbers LEAD it.
    const a = createApp({
      meta,
      blobs: new FsBlobStore(join(dir, "blobs-embed-slot")),
      baseUrl: "http://derive.test",
      token: "tok",
      shell: SHELL,
    })
    const hop = await a.request(`/artifacts/${short}`, { headers: { authorization: "Bearer tok" } })
    const html = await (
      await a.request(hop.headers.get("location") ?? "", {
        headers: { authorization: "Bearer tok" },
      })
    ).text()
    expect(html).toMatch(/property="og:description" content="pass 48 · fail 0 ·/)

    // An artifact with no slot keeps the plain description, so the lead is data-driven
    // rather than a claim every card now makes.
    const plain = await idOf(
      await upload("bare.md", "# Plain", { visibility: "public", title: "Plain" }),
    )
    const plainHop = await a.request(`/artifacts/${plain}`, {
      headers: { authorization: "Bearer tok" },
    })
    const plainHtml = await (
      await a.request(plainHop.headers.get("location") ?? "", {
        headers: { authorization: "Bearer tok" },
      })
    ).text()
    expect(plainHtml).toContain('property="og:description"')
    expect(plainHtml).not.toContain("pass 48")
  })

  it("oembed returns a rich response with a sandboxed iframe", async () => {
    const short = await idOf(await upload("o.md", "# Hi", { visibility: "public", title: "Deck" }))
    const res = await app.request(
      `/v1/oembed?url=${encodeURIComponent(`http://derive.test/artifacts/${short}`)}`,
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

  it("the embed plaque's back-link carries the embed_badge source tag", async () => {
    const short = await idOf(
      await upload("e.md", "# Hi", { visibility: "public", title: "Tagged" }),
    )
    const res = await app.request(`/v1/embed/${short}`)
    expect(res.status).toBe(200)
    const shell = await res.text()
    // The plaque lands the viewer on the artifact page — a worker-first path, so
    // the capture middleware stamps the arrival with this surface.
    expect(shell).toContain("src=embed_badge")
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
      `/v1/oembed?url=${encodeURIComponent(`http://derive.test/artifacts/${short}`)}`,
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

  it("injects unfurl meta into the /artifacts/:ref shell for a public artifact", async () => {
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
    const bare = await a.request(`/artifacts/${short}`, {
      headers: { authorization: "Bearer tok" },
    })
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
    const bare = await a.request(`/artifacts/${short}`, {
      headers: { authorization: "Bearer tok" },
    })
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
    const res = await a.request(`/artifacts/${short}`) // anonymous (no token header)
    const html = await res.text()
    expect(html).not.toContain("og:title")
    expect(html).not.toContain("Private Page")
  })
})

describe("profile unfurl (/users/:handle)", () => {
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
      workspace_access: "member",
      link_role: "viewer",
      listed: "public",
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
    const res = await authed.request("/v1/og/users/niao")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("image/svg+xml")
    const svg = await res.text()
    expect(svg).toContain("<svg")
    expect(svg).toContain("Nia Okoye")
    expect(svg).toContain("@niao")
    expect(svg).toContain("1 work")
  })

  it("injects profile OG meta into the /users/:handle shell for crawlers", async () => {
    const a = createApp({
      meta: m,
      blobs: new FsBlobStore(join(dir, "blobs-og-profile-shell")),
      baseUrl: "http://derive.test",
      token: "tok",
      auth: undefined,
      shell: SHELL,
      defaultOrgId: "default",
    })
    const res = await a.request("/users/niao")
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('property="og:type" content="profile"')
    expect(html).toContain("Nia Okoye (@niao)")
    expect(html).toContain("/v1/og/users/niao")
    expect(html).toContain("id=root") // still the SPA shell for humans
  })

  it("serves a generic card + bare shell for an unclaimed handle (no leak)", async () => {
    const svg = await (await app.request("/v1/og/users/ghosthandle")).text()
    expect(svg).toContain("<svg")
    const a = createApp({
      meta,
      blobs: new FsBlobStore(join(dir, "blobs-og-profile-ghost")),
      baseUrl: "http://derive.test",
      token: "tok",
      shell: SHELL,
    })
    const html = await (await a.request("/users/ghosthandle")).text()
    expect(html).not.toContain("og:type")
    expect(html).toContain("id=root")
  })
})
