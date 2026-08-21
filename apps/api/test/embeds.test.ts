import { join } from "node:path"
import { newId, newShortId } from "@derive/core"
import { FsBlobStore } from "@derive/storage/fs"
import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { anonApp, app, dir, meta, upload } from "./helpers"

const idOf = async (res: Response): Promise<string> => (await res.json()).short_id
const SHELL =
  '<!doctype html><html><head><meta name="robots" content="noindex,nofollow"><title>Derive</title></head><body><div id=root></div></body></html>'

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

  it("a fact-bearing artifact leads its unfurl with its own numbers", async () => {
    // The single highest-leverage incentive in the whole facts bet: a link pasted in Slack
    // shows "pass 48 · fail 0" before anyone clicks, which is the mechanic that made
    // OpenGraph universal. It reaches the card through infoFor → dataSummary, and until
    // now NOTHING asserted it — so any refactor of the unfurl path could delete the
    // feature and leave every test green. It very nearly did: a concurrent PR extracts
    // infoFor into a shared lib from a copy that predates the fact read.
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
    expect(html).toContain('name="robots" content="index,follow"')
    expect(html).toContain('rel="canonical"')
    expect(html.match(/name="robots"/g)).toHaveLength(1)
    // Still the SPA shell — humans get the app.
    expect(html).toContain("id=root")
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
    expect(res.status).toBe(404)
    const html = await res.text()
    expect(html).not.toContain("og:title")
    expect(html).not.toContain("Private Page")
    expect(html).toContain('name="robots" content="noindex,nofollow"')
  })
})

describe("agent-readable share URLs (.md + Accept: text/markdown)", () => {
  // The Accept header Claude-family agent fetchers send on every request.
  const AGENT_ACCEPT = "text/markdown, text/html, */*"
  const BROWSER_ACCEPT =
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
  // Unlike the sibling embed apps, this one READS version blobs, so it must share
  // the upload helper's blob directory — a throwaway dir would 404 every body.
  const a = createApp({
    meta,
    blobs: new FsBlobStore(join(dir, "blobs")),
    baseUrl: "http://derive.test",
    token: "tok",
    shell: SHELL,
  })

  it("serves an HTML artifact as markdown at the .md suffix, anonymously", async () => {
    const short = await idOf(
      await upload(
        "news.html",
        "<!doctype html><html><body><h1>Big News</h1><p>Body words.</p></body></html>",
        { visibility: "public", title: "Big News" },
      ),
    )
    const res = await a.request(`/artifacts/big-news-${short}.md`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/markdown")
    const md = await res.text()
    expect(md).toContain("# Big News")
    expect(md).toContain("Body words.")
    expect(md).not.toContain("<h1")
    // Listed-public is indexable: no noindex marker, and the HTML page stays canonical.
    expect(res.headers.get("x-robots-tag")).toBeNull()
    expect(res.headers.get("link")).toContain('rel="canonical"')
  })

  it("negotiates markdown on the page URL for a client that asks for it", async () => {
    const short = await idOf(
      await upload("n.html", "<!doctype html><html><body><h1>Negotiated</h1></body></html>", {
        visibility: "public",
        title: "Negotiated",
      }),
    )
    const md = await a.request(`/artifacts/negotiated-${short}`, {
      headers: { accept: AGENT_ACCEPT },
    })
    expect(md.status).toBe(200)
    expect(md.headers.get("content-type")).toContain("text/markdown")
    expect(await md.text()).toContain("# Negotiated")

    const html = await a.request(`/artifacts/negotiated-${short}`, {
      headers: { accept: BROWSER_ACCEPT },
    })
    expect(html.status).toBe(200)
    expect(html.headers.get("content-type")).toContain("text/html")
    expect(await html.text()).toContain("id=root")

    // q=0 explicitly refuses markdown.
    const refused = await a.request(`/artifacts/negotiated-${short}`, {
      headers: { accept: "text/markdown;q=0, */*" },
    })
    expect(refused.headers.get("content-type")).toContain("text/html")

    // Two representations at one URL: every branch must tell caches to key on Accept.
    expect(md.headers.get("vary")).toContain("Accept")
    expect(html.headers.get("vary")).toContain("Accept")
  })

  it("passes a markdown-entry bundle (a skill) through verbatim", async () => {
    // pickBundleEntry prefers SKILL.md over non-root HTML, so a skill's entry is
    // markdown — running it through the HTML converter would strip its structure.
    const source = "---\nname: my-skill\n---\n\n# My Skill\n\nUse when X.\n"
    const zip = zipSync({
      "SKILL.md": new TextEncoder().encode(source),
      "assets/demo.html": new TextEncoder().encode("<h1>demo</h1>"),
    })
    const short = await idOf(
      await upload("skill.zip", zip, { visibility: "public", title: "My Skill" }),
    )
    const res = await a.request(`/artifacts/my-skill-${short}.md`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(source)
  })

  it("gates pinned versions at @vN.md behind the public-history rule", async () => {
    const short = await idOf(
      await upload("v.md", "# One", { visibility: "public", title: "Versioned" }),
    )
    await upload("v.md", "# Two", {}, short)
    // The current version reads anonymously; history does NOT (mirrors /raw's
    // anonHistoryBlocked — an old version's bytes are as hidden as the workbench).
    expect(await (await a.request(`/artifacts/versioned-${short}.md`)).text()).toContain("# Two")
    expect((await a.request(`/artifacts/versioned-${short}@v1.md`)).status).toBe(404)
    // An authorised reader still gets the pinned version.
    const authed = await a.request(`/artifacts/versioned-${short}@v1.md`, {
      headers: { authorization: "Bearer tok" },
    })
    expect(authed.status).toBe(200)
    expect(await authed.text()).toContain("# One")
    // Opting the page into public history opens it to the world link too.
    await app.request(`/v1/artifacts/${short}/access`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicHistory: true }),
    })
    const anon = await a.request(`/artifacts/versioned-${short}@v1.md`)
    expect(anon.status).toBe(200)
    expect(await anon.text()).toContain("# One")
  })

  it("leaks nothing through the markdown surface for a gated artifact", async () => {
    const short = await idOf(
      await upload("h.md", "# top secret", { visibility: "org", title: "Hush Doc" }),
    )
    const res = await a.request(`/artifacts/${short}.md`) // anonymous
    expect(res.status).toBe(404)
    const body = await res.text()
    expect(body).not.toContain("secret")
    expect(body).not.toContain("Hush")
    expect(res.headers.get("x-robots-tag")).toContain("noindex")
    // The negotiated form of the same request stays small too — no app shell.
    const neg = await a.request(`/artifacts/${short}`, { headers: { accept: AGENT_ACCEPT } })
    expect(neg.status).toBe(404)
    expect(neg.headers.get("content-type")).toContain("text/markdown")
    expect(await neg.text()).not.toContain("id=root")
  })

  it("refuses the body of an expired draft (the sweep may not have run yet)", async () => {
    // authorize() knows nothing about expiry — an unclaimed draft keeps its viewer
    // world link until the sweep deletes it, so the fence must live in the handler.
    // The blob is REAL: with a dangling blob_key this 404s for the wrong reason
    // (missing blob) and the test pins nothing.
    const blobKey = await new FsBlobStore(join(dir, "blobs")).put(
      new TextEncoder().encode("# stale body"),
    )
    const art = await meta.createArtifact({
      id: newId("a"),
      // A ref-resolvable short id (newId's underscore prefix never parses out of a ref).
      short_id: newShortId(),
      org_id: "default",
      slug: "stale-draft",
      title: "Stale Draft",
      workspace_access: "none",
      link_role: "viewer",
      listed: "none",
      kind: "file",
      spa: 0,
      expires_at: "2020-01-01T00:00:00.000Z",
    })
    await meta.addVersion(art.id, {
      id: newId("v"),
      blob_key: blobKey,
      content_type: "text/markdown",
      size_bytes: 12,
      author: "t",
      author_id: null,
      message: null,
    })
    const res = await a.request(`/artifacts/stale-draft-${art.short_id}.md`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain("stale body")
  })

  it("serves link-shared but unlisted docs with a noindex marker", async () => {
    // The modern access triple: anyone with the URL may view, but it is listed
    // nowhere — readable to an agent holding the link, still noindex for crawlers.
    const short = await idOf(
      await upload("q.md", "# quiet", { link_role: "viewer", listed: "none", title: "Quiet Doc" }),
    )
    const res = await a.request(`/artifacts/quiet-doc-${short}.md`) // anonymous
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("# quiet")
    expect(res.headers.get("x-robots-tag")).toContain("noindex")
  })
})

describe("profile unfurl (/users/:handle)", () => {
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
    const response = await a.request("/users/ghosthandle")
    expect(response.status).toBe(404)
    const html = await response.text()
    expect(html).not.toContain("og:type")
    expect(html).toContain('name="robots" content="noindex,nofollow"')
    expect(html).toContain("id=root")
  })
})
