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
    // and it carries name + avatar + role (null until set) but never the email.
    const prof = await app.request("/v1/users/nia")
    expect(prof.status).toBe(200)
    const { user } = await prof.json()
    expect(user).toEqual({
      username: "nia",
      name: "Nia",
      image: "x.png",
      profession: null,
      about: null,
    })
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

  it("sets a role + bio that surface on the public profile (and trims/caps input)", async () => {
    const ravi: TestUser = { id: "u_ravi", email: "ravi@dock.test", name: "Ravi", username: "ravi" }
    const { app } = makeAuthedApp("profiles-role", [ravi])

    // Set a role + blurb; whitespace is trimmed.
    const res = await app.request(
      "/v1/me/profile",
      jsonAs(as(ravi.email), { profession: " Builder ", about: "  ship features + docs  " }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ profession: "Builder", about: "ship features + docs" })

    // They come back on the public profile.
    const { user } = await (await app.request("/v1/users/ravi")).json()
    expect(user).toMatchObject({ profession: "Builder", about: "ship features + docs" })

    // An empty string clears a field; an omitted field is left untouched.
    const cleared = await app.request("/v1/me/profile", jsonAs(as(ravi.email), { profession: "" }))
    expect(await cleared.json()).toEqual({ profession: null, about: null })
    const after = await (await app.request("/v1/users/ravi")).json()
    expect(after.user.profession).toBeNull()
    expect(after.user.about).toBe("ship features + docs") // untouched

    // Over-long values are rejected (role max 40, bio max 280).
    const tooLong = await app.request(
      "/v1/me/profile",
      jsonAs(as(ravi.email), { profession: "x".repeat(41) }),
    )
    expect(tooLong.status).toBe(400)

    // Anonymous callers can't set a profile (the anon-write lockdown blocks it 403).
    expect((await app.request("/v1/me/profile", jsonAs({}, { profession: "Design" }))).status).toBe(
      403,
    )
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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const uploadAvatar = (
  app: ReturnType<typeof makeAuthedApp>["app"],
  headers: Record<string, string>,
  bytes: Uint8Array,
  type: string,
  filename: string,
) => {
  const fd = new FormData()
  fd.append("file", new Blob([bytes as BlobPart], { type }), filename)
  return app.request("/v1/me/avatar", { method: "POST", body: fd, headers })
}

describe("profile avatars", () => {
  it("accepts a raster upload, serves it back, and surfaces it on the profile", async () => {
    const u: TestUser = { id: "u_av", email: "av@dock.test", name: "Ava" }
    const { app } = makeAuthedApp("avatar-ok", [u])
    await post(app, as(u.email), "ava") // claim a handle so we can read the profile

    const res = await uploadAvatar(app, as(u.email), PNG, "image/png", "me.png")
    expect(res.status).toBe(200)
    const { image } = await res.json()
    expect(image).toMatch(/\/v1\/avatars\/[0-9a-f]{64}$/)

    // The bytes serve back as a real image (content-type re-derived from bytes).
    const key = image.split("/").pop() as string
    const got = await app.request(`/v1/avatars/${key}`)
    expect(got.status).toBe(200)
    expect(got.headers.get("content-type")).toBe("image/png")

    // The public profile now carries the avatar URL.
    const prof = await (await app.request("/v1/users/ava")).json()
    expect(prof.user.image).toBe(image)
  })

  it("rejects non-images and SVG (no stored-XSS), and 404s an unknown key", async () => {
    const u: TestUser = { id: "u_av2", email: "av2@dock.test", name: "Avb" }
    const { app } = makeAuthedApp("avatar-bad", [u])
    const enc = (s: string) => new TextEncoder().encode(s)
    expect((await uploadAvatar(app, as(u.email), enc("hello"), "image/png", "x.png")).status).toBe(
      400,
    ) // bytes aren't an image, despite the declared type
    expect(
      (
        await uploadAvatar(
          app,
          as(u.email),
          enc("<svg onload=alert(1)></svg>"),
          "image/svg+xml",
          "x.svg",
        )
      ).status,
    ).toBe(400) // SVG is refused outright
    expect((await app.request("/v1/avatars/deadbeef")).status).toBe(404)
  })

  it("anonymous callers cannot upload an avatar (write lockdown)", async () => {
    const { app } = makeAuthedApp("avatar-anon", [
      { id: "u_av3", email: "av3@dock.test", name: "C" },
    ])
    const fd = new FormData()
    fd.append("file", new Blob([PNG as BlobPart], { type: "image/png" }), "x.png")
    expect((await app.request("/v1/me/avatar", { method: "POST", body: fd })).status).toBe(403)
  })
})

describe("discoverability (on by default) + people search", () => {
  // Nova never set the flag → discoverable by default (GitHub-style).
  const nova: TestUser = {
    id: "u_disc_nova",
    email: "nova@d.test",
    name: "Nova Star",
    username: "nova",
  }
  // Dox explicitly opted out.
  const dox: TestUser = {
    id: "u_disc_dox",
    email: "dox@d.test",
    name: "Dox",
    username: "dox",
    discoverable: false,
  }
  const { app } = makeAuthedApp("discover", [nova, dox])
  const handles = (r: { users: { username: string }[] }) => r.users.map((u) => u.username)
  const search = async (q: string, by?: string) =>
    (await app.request(`/v1/users/search?q=${q}`, by ? { headers: as(by) } : {})).json()

  it("finds default-on users (never email), hides opt-outs; needs a query + auth", async () => {
    // Nova is findable without ever opting in; the opted-out Dox never appears.
    expect(handles(await search("nov", dox.email))).toContain("nova")
    expect(handles(await search("star", dox.email))).toContain("nova")
    expect((await search("nov", dox.email)).users[0]).not.toHaveProperty("email")
    expect(handles(await search("dox", nova.email))).toHaveLength(0)
    // Empty query returns nothing (no full enumeration); anonymous is refused.
    expect(handles(await search("", nova.email))).toHaveLength(0)
    expect((await app.request("/v1/users/search?q=nov")).status).toBe(401)
  })

  it("opting back in makes you findable; opting out hides you", async () => {
    // Dox opts in → findable; then a default-on user opts out → hidden.
    await app.request("/v1/me/discoverable", jsonAs(as(dox.email), { discoverable: true }))
    expect(handles(await search("dox", nova.email))).toContain("dox")
    await app.request("/v1/me/discoverable", jsonAs(as(nova.email), { discoverable: false }))
    expect(handles(await search("nov", dox.email))).toHaveLength(0)
    // /v1/me: unset → on by default; explicit false → off.
    const novaMe = await (await app.request("/v1/me", { headers: as(nova.email) })).json()
    expect(novaMe.user.discoverable).toBe(true) // session is the seeded (unset) flag → default on
    const doxMe = await (await app.request("/v1/me", { headers: as(dox.email) })).json()
    expect(doxMe.user.discoverable).toBe(false)
  })
})
