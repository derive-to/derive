import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, publishAs } from "./helpers"

// REST counterpart of the MCP `search` tool (apps/api/src/mcp.ts) — both surfaces
// (and the self-hosted stdio CLI, which calls this route over HTTP) run the SAME
// shared engine in apps/api/src/lib/search.ts, so these tests focus on what's
// specific to the REST surface: routing, auth/visibility, and response shape —
// not re-testing the grep engine itself (already covered in mcp.test.ts).
describe("/v1/artifacts/:shortId/search and /v1/artifacts/search — REST search", () => {
  const users = [
    { id: "srch1", email: "search-owner@x.test", name: "Owner" },
    { id: "srch2", email: "search-member@x.test", name: "Member" },
  ]

  it("single-artifact search: literal match, case sensitivity, missing query, 404s", async () => {
    const { app: a } = makeAuthedApp("rest-search-one", users, "editor")
    const res = await publishAs(
      a,
      "# Report\n\nalpha line\nbeta line with Pricing\n",
      { title: "Report" },
      as("search-owner@x.test"),
    )
    const { short_id } = await res.json()

    const hit = await (
      await a.request(`/v1/artifacts/${short_id}/search?query=pricing`, {
        headers: as("search-owner@x.test"),
      })
    ).text()
    expect(hit).toContain("1 match")
    expect(hit).toContain("Pricing")

    const cs = await (
      await a.request(`/v1/artifacts/${short_id}/search?query=Pricing&case_sensitive=true`, {
        headers: as("search-owner@x.test"),
      })
    ).text()
    expect(cs).toContain("1 match")
    const csMiss = await (
      await a.request(`/v1/artifacts/${short_id}/search?query=PRICING&case_sensitive=true`, {
        headers: as("search-owner@x.test"),
      })
    ).text()
    expect(csMiss).toContain("no matches")

    const missingQuery = await a.request(`/v1/artifacts/${short_id}/search`, {
      headers: as("search-owner@x.test"),
    })
    expect(missingQuery.status).toBe(400)

    const notFound = await a.request("/v1/artifacts/doesnotexist/search?query=x", {
      headers: as("search-owner@x.test"),
    })
    expect(notFound.status).toBe(404)
  })

  it("workspace-wide search (GET /v1/artifacts/search, no shortId) reaches the search handler — NOT swallowed by the GET /v1/artifacts/:shortId route (regression: static-vs-param route ordering)", async () => {
    const { app: a } = makeAuthedApp("rest-search-order", users, "editor")
    await publishAs(
      a,
      "# Order Doc\n\nthe order-canary-zxcv term",
      { title: "Order Doc" },
      as("search-owner@x.test"),
    )
    const res = await a.request("/v1/artifacts/search?query=order-canary-zxcv", {
      headers: as("search-owner@x.test"),
    })
    // A route-order bug would resolve :shortId="search" instead, which 404s (no
    // artifact literally short-id'd "search") rather than running a real search.
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("order-canary-zxcv")
    expect(body).toContain("Order Doc")
  })

  it("workspace-wide search groups by artifact and NEVER surfaces a private (workspace_access:none) artifact's content to a co-member (regression)", async () => {
    const { app: a } = makeAuthedApp("rest-search-ws", users, "editor")
    // The factory default publish is a private "team draft" (listed:"none") — a
    // co-member could open it directly but it wouldn't appear in a LISTING either,
    // same as list_artifacts. listed:"workspace" is what actually makes it show up
    // in a teammate's search, so that's the realistic "visible to the team" case.
    await publishAs(
      a,
      "# Visible\n\nthe visible-rest-needle-1 is here",
      { title: "Visible Doc", listed: "workspace" },
      as("search-owner@x.test"),
    )
    await publishAs(
      a,
      "# Private\n\nthe private-rest-needle-2 is here",
      { title: "Private Doc", workspace_access: "none", link_role: "none" },
      as("search-owner@x.test"),
    )

    const asMember = await (
      await a.request("/v1/artifacts/search?query=visible-rest-needle-1", {
        headers: as("search-member@x.test"),
      })
    ).text()
    expect(asMember).toContain("Visible Doc")
    expect(asMember).toContain("1 match")

    const privateSearch = await (
      await a.request("/v1/artifacts/search?query=private-rest-needle-2", {
        headers: as("search-member@x.test"),
      })
    ).text()
    expect(privateSearch).toContain("No matches")
    expect(privateSearch).not.toContain("Private Doc")

    // The owner (a real member of the private artifact) DOES find it — this isn't a
    // broken feature, only a scoped-visibility one.
    const asOwner = await (
      await a.request("/v1/artifacts/search?query=private-rest-needle-2", {
        headers: as("search-owner@x.test"),
      })
    ).text()
    expect(asOwner).toContain("Private Doc")
  })

  it("a request with no callable identity at all (no session, no token) is rejected, matching GET /v1/artifacts", async () => {
    const { app: a } = makeAuthedApp("rest-search-401", users, "editor")
    const res = await a.request("/v1/artifacts/search?query=x") // no headers at all
    expect(res.status).toBe(401)
  })
})
