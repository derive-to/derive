import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, publishAs } from "./helpers"

describe("artifact usefulness ratings", () => {
  const users = [
    { id: "rate-author", email: "rate-author@x.test", name: "Author" },
    { id: "rate-one", email: "rate-one@x.test", name: "One" },
    { id: "rate-two", email: "rate-two@x.test", name: "Two" },
    { id: "rate-three", email: "rate-three@x.test", name: "Three" },
    { id: "rate-editor", email: "rate-editor@x.test", name: "Editor" },
  ]

  const put = (
    app: ReturnType<typeof makeAuthedApp>["app"],
    shortId: string,
    email: string,
    value: "not_useful" | "useful" | "essential",
    reason: string | null = null,
    version = 1,
  ) =>
    app.request(`/v1/artifacts/${shortId}/rating`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...as(email) },
      body: JSON.stringify({ version, value, reason }),
    })

  it("accepts human ratings, blocks self-ratings, and hides small aggregates", async () => {
    const { app } = makeAuthedApp("usefulness-ratings", users, "editor")
    const published = await publishAs(
      app,
      "# Useful guide",
      { title: "Useful guide" },
      as("rate-author@x.test"),
    )
    const { short_id: shortId } = (await published.json()) as { short_id: string }

    const authorView = await app.request(`/v1/artifacts/${shortId}/rating?version=1`, {
      headers: as("rate-author@x.test"),
    })
    expect(authorView.status).toBe(200)
    expect(await authorView.json()).toMatchObject({
      eligible: false,
      rating: null,
      aggregate: null,
    })
    expect((await put(app, shortId, "rate-author@x.test", "useful")).status).toBe(403)

    const first = await put(app, shortId, "rate-one@x.test", "useful", "clear")
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({
      eligible: true,
      rating: { value: "useful", reason: "clear" },
      aggregate: null,
    })
    expect((await put(app, shortId, "rate-two@x.test", "not_useful", "clear")).status).toBe(400)

    await put(app, shortId, "rate-two@x.test", "essential", "saved_time")
    const third = await put(app, shortId, "rate-three@x.test", "not_useful", "outdated")
    expect(await third.json()).toMatchObject({
      aggregate: { total: 3, helpful_percent: 67, essential: 1 },
    })

    const changed = await put(app, shortId, "rate-one@x.test", "essential", "reusable")
    expect(await changed.json()).toMatchObject({
      rating: { value: "essential", reason: "reusable" },
      aggregate: { total: 3, helpful_percent: 67, essential: 2 },
    })

    const cleared = await app.request(`/v1/artifacts/${shortId}/rating?version=1`, {
      method: "DELETE",
      headers: as("rate-one@x.test"),
    })
    expect(await cleared.json()).toMatchObject({ rating: null, aggregate: null })
  })

  it("blocks the original author when an agent publishes the current version", async () => {
    const { app } = makeAuthedApp("usefulness-original-author", users, "editor")
    const published = await publishAs(
      app,
      "# First version",
      { title: "Agent revised guide" },
      as("rate-author@x.test"),
    )
    const { short_id: shortId } = (await published.json()) as { short_id: string }
    const revised = await publishAs(
      app,
      "# Agent revision",
      { message: "Agent revision" },
      { authorization: "Bearer tok" },
      shortId,
    )
    expect(revised.status).toBe(201)

    const authorView = await app.request(`/v1/artifacts/${shortId}/rating?version=2`, {
      headers: as("rate-author@x.test"),
    })
    expect(await authorView.json()).toMatchObject({ eligible: false })
    expect((await put(app, shortId, "rate-author@x.test", "useful", null, 2)).status).toBe(403)
  })

  it("blocks every human author after a later agent revision", async () => {
    const { app } = makeAuthedApp("usefulness-intermediate-author", users, "editor")
    const published = await publishAs(
      app,
      "# First version",
      { title: "Multi-author guide" },
      as("rate-author@x.test"),
    )
    const { short_id: shortId } = (await published.json()) as { short_id: string }
    expect(
      (
        await publishAs(
          app,
          "# Human revision",
          { message: "Human revision" },
          as("rate-editor@x.test"),
          shortId,
        )
      ).status,
    ).toBe(201)
    expect(
      (
        await publishAs(
          app,
          "# Agent revision",
          { message: "Agent revision" },
          { authorization: "Bearer tok" },
          shortId,
        )
      ).status,
    ).toBe(201)

    const editorView = await app.request(`/v1/artifacts/${shortId}/rating?version=3`, {
      headers: as("rate-editor@x.test"),
    })
    expect(await editorView.json()).toMatchObject({ eligible: false })
    expect((await put(app, shortId, "rate-editor@x.test", "useful", null, 3)).status).toBe(403)
  })

  it("rejects anonymous rating reads and writes", async () => {
    const { app } = makeAuthedApp("usefulness-ratings-auth", users, "editor")
    const published = await publishAs(app, "# Guide", { title: "Guide" }, as("rate-author@x.test"))
    const { short_id: shortId } = (await published.json()) as { short_id: string }
    expect((await app.request(`/v1/artifacts/${shortId}/rating`)).status).toBe(401)
    expect(
      (
        await app.request(`/v1/artifacts/${shortId}/rating`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: 1, value: "useful", reason: null }),
        })
      ).status,
    ).toBe(403)
  })
})
