import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

const put = (body: unknown, who: TestUser) => ({ ...jsonAs(as(who.email), body), method: "PUT" })

describe("/v1/seen — a reader's position in an activity stream", () => {
  const ana: TestUser = { id: "u_seen_ana", email: "seenana@derive.test", name: "Ana" }
  const ben: TestUser = { id: "u_seen_ben", email: "seenben@derive.test", name: "Ben" }
  const { app } = makeAuthedApp("seen", [ana, ben], "editor")
  const scope = "ws:org_seen_test"

  it("is null before a visit, moves forward, ignores an older write, rewinds only when manual", async () => {
    const r0 = await app.request(`/v1/seen?scope=${scope}`, { headers: as(ana.email) })
    expect(r0.status).toBe(200)
    expect(await r0.json()).toEqual({ seen_at: null })

    const t1 = "2026-08-28T10:00:00.000Z"
    const t2 = "2026-08-28T11:00:00.000Z"
    const t0 = "2026-08-28T09:00:00.000Z"
    expect(await (await app.request("/v1/seen", put({ scope, at: t1 }, ana))).json()).toEqual({
      seen_at: t1,
    })
    expect(await (await app.request("/v1/seen", put({ scope, at: t2 }, ana))).json()).toEqual({
      seen_at: t2,
    })
    // A slow write carrying an older stamp never rewinds a fresher one.
    expect(await (await app.request("/v1/seen", put({ scope, at: t0 }, ana))).json()).toEqual({
      seen_at: t2,
    })
    // "Mark new from here" is the one legitimate rewind.
    expect(
      await (await app.request("/v1/seen", put({ scope, at: t0, manual: true }, ana))).json(),
    ).toEqual({ seen_at: t0 })
    const r1 = await app.request(`/v1/seen?scope=${scope}`, { headers: as(ana.email) })
    expect(await r1.json()).toEqual({ seen_at: t0 })
  })

  it("is private to the user and independent per scope", async () => {
    await app.request("/v1/seen", put({ scope, at: "2026-08-28T10:00:00.000Z" }, ana))
    const other = await app.request(`/v1/seen?scope=${scope}`, { headers: as(ben.email) })
    expect(await other.json()).toEqual({ seen_at: null })
    const rail = await app.request("/v1/seen?scope=artifact:abcd1234", { headers: as(ana.email) })
    expect(await rail.json()).toEqual({ seen_at: null })
  })

  it("rejects a signed-out caller, a malformed scope, a non-ISO time, and a future stamp", async () => {
    expect((await app.request(`/v1/seen?scope=${scope}`)).status).toBe(401)
    expect((await app.request("/v1/seen?scope=nope", { headers: as(ana.email) })).status).toBe(400)
    expect(
      (
        await app.request(
          "/v1/seen",
          put({ scope: "ws:../x", at: "2026-08-28T10:00:00.000Z" }, ana),
        )
      ).status,
    ).toBe(400)
    expect((await app.request("/v1/seen", put({ scope, at: "yesterday" }, ana))).status).toBe(400)
    const future = new Date(Date.now() + 3_600_000).toISOString()
    expect((await app.request("/v1/seen", put({ scope, at: future }, ana))).status).toBe(400)
  })
})
