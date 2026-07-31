import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

/**
 * GET /v1/bootstrap IS the four individual boot endpoints, verbatim. The client seeds
 * each endpoint's query cache from the corresponding bootstrap field, so any divergence
 * — a missing field, a different sort, a role computed differently — is a cache
 * poisoning the UI would render. The shapes and mappers are shared (lib/boot-shapes)
 * precisely so this cannot happen; this test is the tripwire if someone ever unshares
 * them. It compares LIVE response bodies, not schemas: same session, same data, four
 * requests against one.
 */

const owner: TestUser = { id: "u_boot_own", email: "boot@derive.test", name: "Boot Owner" }
const mate: TestUser = { id: "u_boot_mate", email: "mate@derive.test", name: "Boot Mate" }

const getJson = async (
  app: ReturnType<typeof makeAuthedApp>["app"],
  path: string,
  headers: Record<string, string>,
) => {
  const res = await app.request(path, { headers })
  expect(res.status, `${path} did not 200`).toBe(200)
  return res.json()
}

describe("GET /v1/bootstrap", () => {
  it("returns exactly what the four individual endpoints return, on a workspace with data", async () => {
    const { app } = makeAuthedApp("bootstrap-eq", [owner, mate])
    const h = as(owner.email)

    // Seed enough state to exercise every arm: two artifacts (one tagged, one
    // favorited), a collection, and a notification (a mention from the mate).
    const a1 = await (await publishAs(app, "<h1>one</h1>", { title: "One" }, h)).json()
    const a2 = await (await publishAs(app, "<h1>two</h1>", { title: "Two" }, h)).json()
    await app.request(`/v1/artifacts/${a1.short_id}/tags`, {
      ...jsonAs(h, { tags: ["perf", "boot"] }),
      method: "PUT",
    })
    const fav = await app.request(`/v1/artifacts/${a2.short_id}/favorite`, {
      method: "PUT",
      headers: h,
    })
    expect(fav.status, "favorite seed").toBeLessThan(300)
    await app.request("/v1/collections", jsonAs(h, { title: "Boot Col" }))
    // A comment from the mate that @mentions the owner lands a notification.
    await app.request(
      `/v1/artifacts/${a1.short_id}/comments`,
      jsonAs(as(mate.email), {
        body: `hey @${owner.name}`,
        mentions: [{ id: owner.id, name: owner.name ?? "" }],
      }),
    )

    const [tags, collections, settings, notifications, boot] = [
      await getJson(app, "/v1/tags", h),
      await getJson(app, "/v1/collections", h),
      await getJson(app, "/v1/workspace/settings", h),
      await getJson(app, "/v1/notifications", h),
      await getJson(app, "/v1/bootstrap", h),
    ]

    expect(boot.summary).toEqual(tags)
    expect(boot.collections).toEqual(collections.collections)
    expect(boot.settings).toEqual(settings)
    expect(boot.notifications).toEqual(notifications.notifications)
    expect(boot.unread).toEqual(notifications.unread)

    // The seeds actually exercised the arms — an accidentally-empty workspace would
    // let a broken batch pass the equality above by matching empty-to-empty.
    expect(boot.summary.total).toBeGreaterThan(0)
    expect(boot.summary.tags.length).toBeGreaterThan(0)
    expect(boot.summary.favorites).toBeGreaterThan(0)
    expect(boot.collections.length).toBeGreaterThan(0)
  })

  it("is member-only: a signed-out caller gets 401", async () => {
    const { app } = makeAuthedApp("bootstrap-anon", [owner])
    const res = await app.request("/v1/bootstrap")
    expect(res.status).toBe(401)
  })
})
