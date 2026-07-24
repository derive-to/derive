import { describe, expect, it } from "vitest"
import {
  anonApp,
  app,
  as,
  json,
  jsonAs,
  makeAuthedApp,
  publishAs,
  type TestUser,
  upload,
} from "./helpers"

// Create an artifact and set its world link role; returns short_id.
const artifactWithLink = async (linkRole: "none" | "viewer" | "commenter" | "editor") => {
  const shortId = (
    await (await upload("doc.md", "# feedback me", { title: "Anon commenting" })).json()
  ).short_id as string
  const res = await app.request(`/v1/artifacts/${shortId}/access`, {
    ...json({ linkRole }),
    method: "PATCH",
  })
  expect(res.status).toBe(200)
  return shortId
}

describe("anonymous commenting", () => {
  it("anon can comment on a commenter link with a name", async () => {
    const shortId = await artifactWithLink("commenter")
    const res = await anonApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({ body_md: "love this section", author: "Glen from Customer.io" }),
    )
    expect(res.status).toBe(201)
    const cm = await res.json()
    expect(cm.author).toBe("Glen from Customer.io")
  })

  it("anon without a name is rejected", async () => {
    const shortId = await artifactWithLink("commenter")
    for (const body of [
      { body_md: "hi" },
      { body_md: "hi", author: "" },
      { body_md: "hi", author: "   " },
    ]) {
      const res = await anonApp.request(`/v1/artifacts/${shortId}/comments`, json(body))
      expect(res.status).toBe(400)
    }
  })

  it("anon with an overlong name is rejected", async () => {
    const shortId = await artifactWithLink("commenter")
    const res = await anonApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({ body_md: "hi", author: "x".repeat(81) }),
    )
    expect(res.status).toBe(400)
  })

  it("anon cannot comment on a viewer link", async () => {
    const shortId = await artifactWithLink("viewer")
    const res = await anonApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({ body_md: "hi", author: "Guest" }),
    )
    expect(res.status).toBe(403)
  })

  it("anon cannot comment on a private artifact", async () => {
    const shortId = await artifactWithLink("none")
    const res = await anonApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({ body_md: "hi", author: "Guest" }),
    )
    expect(res.status).toBe(403)
  })

  it("anon can comment on an editor link but never edit or delete", async () => {
    const shortId = await artifactWithLink("editor")
    const created = await (
      await anonApp.request(
        `/v1/artifacts/${shortId}/comments`,
        json({ body_md: "guest note", author: "Guest" }),
      )
    ).json()
    // Edit: PATCH is not on the anon allow-list -> 403 at the door.
    const edit = await anonApp.request(`/v1/artifacts/${shortId}/comments/${created.id}`, {
      ...json({ body_md: "hijacked" }),
      method: "PATCH",
    })
    expect(edit.status).toBe(403)
    const del = await anonApp.request(`/v1/artifacts/${shortId}/comments/${created.id}`, {
      ...json({}),
      method: "DELETE",
    })
    expect(del.status).toBe(403)
    const resolve = await anonApp.request(
      `/v1/artifacts/${shortId}/comments/${created.id}/resolve`,
      json({ state: "resolved" }),
    )
    expect(resolve.status).toBe(403)
  })

  it("anon can read comments on a commenter link", async () => {
    const shortId = await artifactWithLink("commenter")
    await anonApp.request(
      `/v1/artifacts/${shortId}/comments`,
      json({ body_md: "first!", author: "Guest" }),
    )
    const res = await anonApp.request(`/v1/artifacts/${shortId}/comments`)
    expect(res.status).toBe(200)
    const list = await res.json()
    expect(list.comments).toHaveLength(1)
    expect(list.comments[0].author).toBe("Guest")
  })

  it("anon still cannot read comments on a viewer link", async () => {
    const shortId = await artifactWithLink("viewer")
    const res = await anonApp.request(`/v1/artifacts/${shortId}/comments`)
    expect(res.status).toBe(404)
  })

  it("signed-in callers ignore a body author (session name wins)", async () => {
    // A real signed-in session is cheap here via makeAuthedApp/as/jsonAs (same
    // pattern as comment-access.test.ts), so exercise the actual route code
    // rather than asserting it in review.
    const alice: TestUser = { id: "u_ac_alice", email: "alice@anon-comments.test", name: "Alice" }
    const { app: app2 } = makeAuthedApp("anon-comments-signedin", [alice])
    const shortId = (await (await publishAs(app2, "<h1>doc</h1>", {}, as(alice.email))).json())
      .short_id as string
    const res = await app2.request(
      `/v1/artifacts/${shortId}/comments`,
      jsonAs(as(alice.email), { body_md: "hi", author: "Spoof" }),
    )
    expect(res.status).toBe(201)
    const cm = await res.json()
    expect(cm.author).toBe("Alice")
    expect(cm.author).not.toBe("Spoof")
  })
})
