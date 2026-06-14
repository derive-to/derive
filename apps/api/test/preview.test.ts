import { describe, expect, it } from "vitest"
import { app, as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

// The live editor preview endpoint: renders a markdown draft to the exact
// published HTML (same renderMarkdown), stateless, signed-in only.
describe("live editor preview (/v1/preview)", () => {
  const owner: TestUser = { id: "u_prev", email: "prev@dock.test", name: "Prev" }
  const { app: authed } = makeAuthedApp("preview-org", [owner])

  it("renders a markdown draft to HTML for a signed-in user", async () => {
    const r = await authed.request(
      "/v1/preview",
      jsonAs(as(owner.email), { source: "# Hi\n\nsome **bold** text", title: "Draft" }),
    )
    expect(r.status).toBe(200)
    const { html } = (await r.json()) as { html: string }
    expect(html).toContain("<!doctype html>")
    expect(html).toContain("<h1>Hi</h1>")
    expect(html).toContain("<strong>bold</strong>")
  })

  it("refuses an unauthenticated caller (401)", async () => {
    const r = await app.request("/v1/preview", jsonAs({}, { source: "# x" }))
    expect(r.status).toBe(401)
  })
})
