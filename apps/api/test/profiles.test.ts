import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

const post = (
  app: ReturnType<typeof makeAuthedApp>["app"],
  headers: Record<string, string>,
  username: string,
) => app.request("/v1/me/username", jsonAs(headers, { username }))

describe("usernames + public profiles", () => {
  it("claims a handle, then serves a public profile with no email", async () => {
    const nia: TestUser = { id: "u_nia", email: "nia@dock.test", name: "Nia", image: "x.png" }
    const { app } = makeAuthedApp("profiles-claim", [nia])

    const claim = await post(app, as(nia.email), "Nia") // mixed case → lowercased
    expect(claim.status).toBe(200)
    expect((await claim.json()).username).toBe("nia")

    // Anyone (even anonymous — no header) can read the public profile by handle,
    // and it carries name + avatar but never the email.
    const prof = await app.request("/v1/users/nia")
    expect(prof.status).toBe(200)
    const { user } = await prof.json()
    expect(user).toEqual({ username: "nia", name: "Nia", image: "x.png" })
    expect(user).not.toHaveProperty("email")

    // The route normalizes the handle, so an upper-cased URL resolves too.
    expect((await app.request("/v1/users/NIA")).status).toBe(200)
  })

  it("reflects a seeded handle on /v1/me", async () => {
    const pat: TestUser = { id: "u_pat", email: "pat@dock.test", name: "Pat", username: "pat" }
    const { app } = makeAuthedApp("profiles-me", [pat])
    const me = await (await app.request("/v1/me", { headers: as(pat.email) })).json()
    expect(me.user.username).toBe("pat")
  })

  it("404s an unclaimed handle", async () => {
    const { app } = makeAuthedApp("profiles-404", [{ id: "u_x", email: "x@dock.test", name: "X" }])
    expect((await app.request("/v1/users/ghost")).status).toBe(404)
  })

  it("rejects a malformed or reserved handle (400) and claims nothing", async () => {
    const u: TestUser = { id: "u_bad", email: "bad@dock.test", name: "Bad" }
    const { app } = makeAuthedApp("profiles-bad", [u])
    expect((await post(app, as(u.email), "a")).status).toBe(400) // too short
    expect((await post(app, as(u.email), "no spaces")).status).toBe(400) // bad chars
    expect((await post(app, as(u.email), "settings")).status).toBe(400) // reserved
    // None of those wrote anything.
    expect((await app.request("/v1/users/settings")).status).toBe(404)
  })

  it("won't let two accounts share a handle (409)", async () => {
    const ann: TestUser = { id: "u_ann", email: "ann@dock.test", name: "Ann" }
    const bob: TestUser = { id: "u_bob", email: "bob@dock.test", name: "Bob" }
    const { app } = makeAuthedApp("profiles-unique", [ann, bob])

    expect((await post(app, as(ann.email), "shared")).status).toBe(200)
    const dup = await post(app, as(bob.email), "shared")
    expect(dup.status).toBe(409)
    // The handle still resolves to its owner, not the loser of the race.
    const { user } = await (await app.request("/v1/users/shared")).json()
    expect(user.name).toBe("Ann")
    // Re-setting your own handle to what you already hold is a no-op success.
    expect((await post(app, as(ann.email), "shared")).status).toBe(200)
  })

  it("renames: the old handle frees up, the new one resolves", async () => {
    const r: TestUser = { id: "u_ren", email: "ren@dock.test", name: "Ren" }
    const { app } = makeAuthedApp("profiles-rename", [r])
    await post(app, as(r.email), "ren-one")
    expect((await post(app, as(r.email), "ren-two")).status).toBe(200)
    expect((await app.request("/v1/users/ren-two")).status).toBe(200)
    expect((await app.request("/v1/users/ren-one")).status).toBe(404)
  })

  it("anonymous callers cannot claim a handle (write lockdown)", async () => {
    const { app } = makeAuthedApp("profiles-anon", [{ id: "u_o", email: "o@dock.test", name: "O" }])
    // No session header + no token → not a principal → blocked at the door.
    const res = await app.request("/v1/me/username", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "sneaky" }),
    })
    expect(res.status).toBe(403)
  })
})
