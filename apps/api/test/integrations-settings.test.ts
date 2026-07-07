import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, type TestUser } from "./helpers"

const owner: TestUser = { id: "u-own", email: "own@x.com", name: "Owner", username: "owner" }
const editor: TestUser = { id: "u-ed", email: "ed@x.com", name: "Ed", username: "ed" }

const { app } = makeAuthedApp("integ-settings", [owner, editor], "editor")

describe("workspace integration settings", () => {
  it("defaults to all channels enabled", async () => {
    const r = await app.request("/v1/workspace/settings", { headers: as(owner.email) })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({
      emailNotifications: true,
      githubPostComments: true,
      githubMirrorComments: true,
      githubPreviewLink: true,
      slackPost: true,
      defaultUnlistedRole: "viewer",
      defaultAgentVisibility: "unlisted",
    })
  })

  it("an admin can flip a single toggle; the rest are unchanged", async () => {
    const r = await app.request("/v1/workspace/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ slackPost: false }),
    })
    expect(r.status).toBe(200)
    const s = await r.json()
    expect(s.slackPost).toBe(false)
    expect(s.emailNotifications).toBe(true)
    // Persisted across reads.
    const again = await (
      await app.request("/v1/workspace/settings", { headers: as(owner.email) })
    ).json()
    expect(again.slackPost).toBe(false)
  })

  it("a non-admin can read but not change settings", async () => {
    const read = await app.request("/v1/workspace/settings", { headers: as(editor.email) })
    expect(read.status).toBe(200)
    const write = await app.request("/v1/workspace/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(editor.email) },
      body: JSON.stringify({ emailNotifications: false }),
    })
    expect(write.status).toBe(403)
  })

  it("requires authentication", async () => {
    const r = await app.request("/v1/workspace/settings")
    expect(r.status).toBe(401)
  })
})
