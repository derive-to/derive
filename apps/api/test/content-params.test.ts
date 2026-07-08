import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { app, TEST_TOKEN, upload } from "./helpers"

const bearer = { authorization: `Bearer ${TEST_TOKEN}` }

describe("/v1/artifacts/:shortId/content — format, section, outline params", () => {
  it("defaults to raw source; format=markdown converts; format=text is flat text", async () => {
    const html =
      "<html><head><style>body{color:red}</style></head><body><h1>Doc</h1><p>hi</p></body></html>"
    const { short_id } = await (await upload("index.html", html)).json()

    const raw = await (await app.request(`/v1/artifacts/${short_id}/content`)).text()
    expect(raw).toBe(html)

    const mdRes = await app.request(`/v1/artifacts/${short_id}/content?format=markdown`)
    expect(mdRes.headers.get("x-derive-format")).toBe("markdown")
    const md = await mdRes.text()
    expect(md).toContain("# Doc")
    expect(md).not.toContain("color:red")

    const flat = await (await app.request(`/v1/artifacts/${short_id}/content?format=text`)).text()
    expect(flat).toContain("hi")
    expect(flat).not.toContain("# Doc")
  })

  it("?outline=1 returns the heading spine; ?section=<slug> returns just that part", async () => {
    const html = "<h1>Top</h1><h2>Alpha</h2><p>a-body</p><h2>Beta</h2><p>b-body</p>"
    const { short_id } = await (await upload("index.html", html)).json()

    const outline = await (await app.request(`/v1/artifacts/${short_id}/content?outline=1`)).json()
    expect(outline.sections.map((s: { slug: string }) => s.slug)).toEqual(["top", "alpha", "beta"])

    const sec = await app.request(`/v1/artifacts/${short_id}/content?section=alpha`)
    expect(sec.headers.get("x-derive-section")).toBe("alpha")
    const text = await sec.text()
    expect(text).toContain("a-body")
    expect(text).not.toContain("b-body")

    const missing = await app.request(`/v1/artifacts/${short_id}/content?section=nope`)
    expect(missing.status).toBe(404)
  })

  it("bundle pages: outline, a page, and page#slug", async () => {
    const zip = zipSync({
      "index.html": new TextEncoder().encode("<h1>Home</h1>"),
      "about.html": new TextEncoder().encode(
        "<h1>About</h1><h2>Part One</h2><p>one</p><h2>Part Two</h2><p>two</p>",
      ),
    })
    const { short_id } = await (await upload("site.zip", zip)).json()

    const outline = await (await app.request(`/v1/artifacts/${short_id}/content?outline=1`)).json()
    expect(outline.pages.map((p: { path: string }) => p.path).sort()).toEqual([
      "about.html",
      "index.html",
    ])

    const page = await (
      await app.request(`/v1/artifacts/${short_id}/content?section=about.html&format=markdown`)
    ).text()
    expect(page).toContain("## Part Two")

    // page#slug — a sibling section stops at the next heading of the same level.
    const slugRes = await app.request(
      `/v1/artifacts/${short_id}/content?section=about.html%23part-one&format=markdown`,
    )
    expect(slugRes.headers.get("x-derive-section")).toBe("about.html#part-one")
    const slug = await slugRes.text()
    expect(slug).toContain("one")
    expect(slug).not.toContain("Part Two")
  })

  it("diff: default is raw source lines; ?content=markdown diffs the readable form", async () => {
    const v1 =
      "<html><head><style>x{color:red}</style></head><body><p>alpha bravo</p></body></html>"
    const v2 =
      "<html><head><style>x{color:blue}</style></head><body><p>alpha BRAVO</p></body></html>"
    const { short_id } = await (await upload("d.html", v1)).json()
    await upload("d.html", v2, {}, short_id)

    const raw = await (await app.request(`/v1/artifacts/${short_id}/diff?from=1&to=2`)).text()
    expect(raw).toContain("<style>")

    const semantic = await (
      await app.request(`/v1/artifacts/${short_id}/diff?from=1&to=2&content=markdown`)
    ).text()
    expect(semantic).toContain("BRAVO")
    expect(semantic).not.toContain("<style>")
  })
})

describe("/v1 publish + proposals — edits form field", () => {
  it("versions: edits materializes a new version without a file upload", async () => {
    const { short_id } = await (
      await upload("e.html", "<h1>Title</h1><p>alpha beta gamma</p>")
    ).json()

    const res = await app.request(`/v1/artifacts/${short_id}/versions`, {
      method: "POST",
      headers: bearer,
      body: new URLSearchParams({
        edits: JSON.stringify([{ old_str: "beta", new_str: "BETA" }]),
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.published).toBe(2)

    const content = await (await app.request(`/v1/artifacts/${short_id}/content`)).text()
    expect(content).toContain("alpha BETA gamma")
  })

  it("versions: edits rejects a stale base_version", async () => {
    const { short_id } = await (await upload("e2.html", "<h1>x</h1><p>one</p>")).json()
    await upload("e2.html", "<h1>x</h1><p>two</p>", {}, short_id) // now v2

    const res = await app.request(`/v1/artifacts/${short_id}/versions`, {
      method: "POST",
      headers: bearer,
      body: new URLSearchParams({
        edits: JSON.stringify([{ old_str: "two", new_str: "TWO" }]),
        base_version: "1",
      }),
    })
    expect(res.status).toBe(409)
  })

  it("proposals: edits stages a proposal from the materialized text, live version untouched", async () => {
    const { short_id } = await (await upload("e3.html", "<h1>x</h1><p>keep this</p>")).json()

    const direct = await app.request(`/v1/artifacts/${short_id}/proposals`, {
      method: "POST",
      headers: bearer,
      body: new URLSearchParams({
        edits: JSON.stringify([{ old_str: "keep this", new_str: "changed this" }]),
      }),
    })
    expect(direct.status).toBe(201)
    const live = await (await app.request(`/v1/artifacts/${short_id}/content`)).text()
    expect(live).toContain("keep this")
    expect(live).not.toContain("changed this")
  })
})
