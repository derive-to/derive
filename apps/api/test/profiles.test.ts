import { newId } from "@derive/core"
import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, type TestUser } from "./helpers"

const post = (
  app: ReturnType<typeof makeAuthedApp>["app"],
  headers: Record<string, string>,
  username: string,
) => app.request("/v1/me/username", jsonAs(headers, { username }))

describe("usernames + public profiles", () => {
  it("claims a handle, then serves a public profile with no email", async () => {
    const nia: TestUser = { id: "u_nia", email: "nia@derive.test", name: "Nia", image: "x.png" }
    const { app } = makeAuthedApp("profiles-claim", [nia])

    const claim = await post(app, as(nia.email), "Nia") // mixed case → lowercased
    expect(claim.status).toBe(200)
    expect((await claim.json()).username).toBe("nia")

    // Anyone (even anonymous — no header) can read the identity card by handle —
    // an author chip must resolve — but a stranger gets no stats and no work
    // grid (profiles aren't a broadcast surface at launch), and never the email.
    const prof = await app.request("/v1/users/nia")
    expect(prof.status).toBe(200)
    const { user } = await prof.json()
    expect(user).toEqual({
      username: "nia",
      name: "Nia",
      image: "x.png",
      profession: null,
      about: null,
      github_login: null,
      teammate: false,
      followed_by_me: false,
    })
    expect(user).not.toHaveProperty("email")
    expect(user).not.toHaveProperty("stats")

    // Nia herself is trivially a teammate: full card, work count included.
    const own = await (await app.request("/v1/users/nia", { headers: as(nia.email) })).json()
    expect(own.user.teammate).toBe(true)
    expect(own.user.stats).toEqual({ works: 0 })

    // The route normalizes the handle, so an upper-cased URL resolves too.
    expect((await app.request("/v1/users/NIA")).status).toBe(200)
  })

  it("reflects a seeded handle on /v1/me", async () => {
    const pat: TestUser = { id: "u_pat", email: "pat@derive.test", name: "Pat", username: "pat" }
    const { app } = makeAuthedApp("profiles-me", [pat])
    const me = await (await app.request("/v1/me", { headers: as(pat.email) })).json()
    expect(me.user.username).toBe("pat")
  })

  it("sets a role + bio that surface on the public profile (and trims/caps input)", async () => {
    const ravi: TestUser = {
      id: "u_ravi",
      email: "ravi@derive.test",
      name: "Ravi",
      username: "ravi",
    }
    const { app } = makeAuthedApp("profiles-role", [ravi])

    // Set a role + blurb; whitespace is trimmed.
    const res = await app.request(
      "/v1/me/profile",
      jsonAs(as(ravi.email), { profession: " Builder ", about: "  ship features + docs  " }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      profession: "Builder",
      about: "ship features + docs",
      brandprint: null,
    })

    // They come back on the public profile.
    const { user } = await (await app.request("/v1/users/ravi")).json()
    expect(user).toMatchObject({ profession: "Builder", about: "ship features + docs" })

    // An empty string clears a field; an omitted field is left untouched.
    const cleared = await app.request("/v1/me/profile", jsonAs(as(ravi.email), { profession: "" }))
    expect(await cleared.json()).toEqual({ profession: null, about: null, brandprint: null })
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

  it("saves and returns a personal brandprint, and clears it with null", async () => {
    const bo: TestUser = { id: "u_bo", email: "bo@derive.test", name: "Bo", username: "bo" }
    const { app } = makeAuthedApp("profiles-brandprint", [bo])

    const saved = await app.request(
      "/v1/me/profile",
      jsonAs(as(bo.email), { brandprint: { collectionId: "col_1" } }),
    )
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({
      profession: null,
      about: null,
      brandprint: { collectionId: "col_1" },
    })

    const cleared = await app.request("/v1/me/profile", jsonAs(as(bo.email), { brandprint: null }))
    expect(cleared.status).toBe(200)
    expect((await cleared.json()).brandprint).toBeNull()
  })

  it("404s an unclaimed handle", async () => {
    const { app } = makeAuthedApp("profiles-404", [
      { id: "u_x", email: "x@derive.test", name: "X" },
    ])
    expect((await app.request("/v1/users/ghost")).status).toBe(404)
  })

  it("rejects a malformed or reserved handle (400) and claims nothing", async () => {
    const u: TestUser = { id: "u_bad", email: "bad@derive.test", name: "Bad" }
    const { app } = makeAuthedApp("profiles-bad", [u])
    expect((await post(app, as(u.email), "a")).status).toBe(400) // too short
    expect((await post(app, as(u.email), "no spaces")).status).toBe(400) // bad chars
    expect((await post(app, as(u.email), "settings")).status).toBe(400) // reserved
    // None of those wrote anything.
    expect((await app.request("/v1/users/settings")).status).toBe(404)
  })

  it("won't let two accounts share a handle (409)", async () => {
    const ann: TestUser = { id: "u_ann", email: "ann@derive.test", name: "Ann" }
    const bob: TestUser = { id: "u_bob", email: "bob@derive.test", name: "Bob" }
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
    const r: TestUser = { id: "u_ren", email: "ren@derive.test", name: "Ren" }
    const { app } = makeAuthedApp("profiles-rename", [r])
    await post(app, as(r.email), "ren-one")
    expect((await post(app, as(r.email), "ren-two")).status).toBe(200)
    expect((await app.request("/v1/users/ren-two")).status).toBe(200)
    expect((await app.request("/v1/users/ren-one")).status).toBe(404)
  })

  it("anonymous callers cannot claim a handle (write lockdown)", async () => {
    const { app } = makeAuthedApp("profiles-anon", [
      { id: "u_o", email: "o@derive.test", name: "O" },
    ])
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
    const u: TestUser = { id: "u_av", email: "av@derive.test", name: "Ava" }
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
    const u: TestUser = { id: "u_av2", email: "av2@derive.test", name: "Avb" }
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
      { id: "u_av3", email: "av3@derive.test", name: "C" },
    ])
    const fd = new FormData()
    fd.append("file", new Blob([PNG as BlobPart], { type: "image/png" }), "x.png")
    expect((await app.request("/v1/me/avatar", { method: "POST", body: fd })).status).toBe(403)
  })
})

describe("profile work-list (visibility-scoped)", () => {
  const amy: TestUser = { id: "u_pw_amy", email: "pwamy@d.test", name: "Amy W", username: "amyw" }
  const carl: TestUser = {
    id: "u_pw_carl",
    email: "pwcarl@d.test",
    name: "Carl",
    username: "carlw",
  }
  // amy + carl share the "default" workspace (amy owner, carl editor).
  const { app, meta } = makeAuthedApp("profile-works", [amy, carl])

  // A hand-published artifact authored by `userId` (stamps author_id), at a visibility.
  const work = async (title: string, userId: string, visibility: "public" | "org") => {
    const a = await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s"),
      org_id: "default",
      slug: null,
      title,
      workspace_access: "member",
      link_role: visibility === "public" ? "viewer" : "none",
      listed: visibility === "public" ? "public" : "workspace",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(a.id, {
      id: newId("v"),
      blob_key: `blob_${newId("b")}`,
      content_type: "text/markdown",
      size_bytes: 1,
      author: "Amy W",
      author_id: userId,
      message: null,
    })
    return a.short_id
  }

  it("shows work to teammates only — a stranger (or anon) gets an empty page", async () => {
    const pub = await work("Amy public", amy.id, "public")
    const priv = await work("Amy workspace-only", amy.id, "org")

    // Anonymous viewer: no work grid at all — a profile is not a broadcast
    // surface, even for public docs (the docs themselves stay URL-reachable).
    const anon = await (await app.request("/v1/users/amyw/artifacts")).json()
    expect(anon.artifacts).toEqual([])
    expect(anon.next_cursor).toBeNull()

    // Carl shares the workspace with amy → he sees her work, org-visible included.
    const shared = await (
      await app.request("/v1/users/amyw/artifacts", { headers: as(carl.email) })
    ).json()
    const sharedIds = shared.artifacts.map((a: { short_id: string }) => a.short_id)
    expect(sharedIds).toContain(pub)
    expect(sharedIds).toContain(priv)

    // Stats track the same gate: absent for the stranger, counted for the teammate.
    const anonProfile = await (await app.request("/v1/users/amyw")).json()
    expect(anonProfile.user).not.toHaveProperty("stats")
    const carlProfile = await (
      await app.request("/v1/users/amyw", { headers: as(carl.email) })
    ).json()
    expect(carlProfile.user.stats.works).toBe(2)
  })

  it("the follower/following list routes are gone (the launch social cut)", async () => {
    // carl can still follow amy — they share a workspace.
    const follow = await app.request("/v1/follows", {
      method: "POST",
      headers: { "content-type": "application/json", ...as(carl.email) },
      body: JSON.stringify({ kind: "user", target: "amyw" }),
    })
    expect(follow.status).toBe(201)
    // But the graph is not a browsable surface — for anyone.
    expect((await app.request("/v1/users/amyw/followers")).status).toBe(404)
    expect(
      (await app.request("/v1/users/amyw/followers", { headers: as(carl.email) })).status,
    ).toBe(404)
    expect(
      (await app.request("/v1/users/carlw/following", { headers: as(carl.email) })).status,
    ).toBe(404)
  })
})

// The work-list is keyset-paginated (limit+1 over-fetch → next_cursor "<created_at>|<id>").
// Isolated app so the count is exact (other tests' works don't bleed in).
describe("profile work-list pagination (keyset)", () => {
  const peg: TestUser = { id: "u_peg", email: "peg@d.test", name: "Peg", username: "peg" }
  const { app, meta } = makeAuthedApp("profile-pagination", [peg])

  it("pages public work by cursor; respects + caps the limit", async () => {
    const N = 27 // > the default page of 24, so there's a real second page
    for (let i = 0; i < N; i++) {
      const a = await meta.createArtifact({
        id: newId("a"),
        short_id: newId("s"),
        org_id: "default",
        slug: null,
        title: `Doc ${i}`,
        workspace_access: "member",
        link_role: "viewer",
        listed: "public",
        kind: "file",
        spa: 0,
      })
      await meta.addVersion(a.id, {
        id: newId("v"),
        blob_key: `blob_${newId("b")}`,
        content_type: "text/markdown",
        size_bytes: 1,
        author: "Peg",
        author_id: peg.id,
        message: null,
      })
    }

    // Page 1 (as peg — a work list is teammates-only now): exactly the default
    // page size, with a cursor to continue.
    const p1 = await (
      await app.request("/v1/users/peg/artifacts", { headers: as(peg.email) })
    ).json()
    expect(p1.artifacts.length).toBe(24)
    expect(p1.next_cursor).toBeTruthy()

    // Page 2: the remainder, and no further cursor.
    const p2 = await (
      await app.request(`/v1/users/peg/artifacts?cursor=${encodeURIComponent(p1.next_cursor)}`, {
        headers: as(peg.email),
      })
    ).json()
    expect(p2.artifacts.length).toBe(N - 24)
    expect(p2.next_cursor).toBeNull()

    // The two pages are disjoint and together cover every work (keyset correctness).
    const ids = new Set(
      [...p1.artifacts, ...p2.artifacts].map((a: { short_id: string }) => a.short_id),
    )
    expect(ids.size).toBe(N)

    // An explicit limit is honored (and yields a cursor when more remain).
    const small = await (
      await app.request("/v1/users/peg/artifacts?limit=5", { headers: as(peg.email) })
    ).json()
    expect(small.artifacts.length).toBe(5)
    expect(small.next_cursor).toBeTruthy()
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
    (await app.request(`/v1/users/search?query=${q}`, by ? { headers: as(by) } : {})).json()

  it("finds default-on users (never email), hides opt-outs; needs a query + auth", async () => {
    // Nova is findable without ever opting in; the opted-out Dox never appears.
    expect(handles(await search("nov", dox.email))).toContain("nova")
    expect(handles(await search("star", dox.email))).toContain("nova")
    expect((await search("nov", dox.email)).users[0]).not.toHaveProperty("email")
    expect(handles(await search("dox", nova.email))).toHaveLength(0)
    // Empty query returns nothing (no full enumeration); anonymous is refused.
    expect(handles(await search("", nova.email))).toHaveLength(0)
    expect((await app.request("/v1/users/search?query=nov")).status).toBe(401)
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

describe("people (/v1/people) — your workmates, not a directory", () => {
  // ivy and jay share the default workspace; jay's discoverable opt-out doesn't
  // hide him from a TEAMMATE (membership already implies you can see each other).
  const ivy: TestUser = { id: "u_ivy", email: "ivy@d.test", name: "Ivy", username: "ivy" }
  const jay: TestUser = {
    id: "u_jay",
    email: "jay@d.test",
    name: "Jay",
    username: "jay",
    discoverable: false,
  }
  const { app } = makeAuthedApp("people-dir", [ivy, jay])
  const handles = (r: { users: { username: string }[] }) => r.users.map((u) => u.username)

  it("lists workmates (opt-out included), filters with ?query=, requires auth", async () => {
    const browse = await (await app.request("/v1/people", { headers: as(ivy.email) })).json()
    expect(handles(browse)).toContain("jay") // a teammate, discoverable or not
    expect(handles(browse)).not.toContain("ivy") // never yourself
    expect(browse.users[0]).not.toHaveProperty("email") // public fields only

    // ?query= filters WITHIN workmates — there is no global directory to search.
    const searched = await (
      await app.request("/v1/people?query=ja", { headers: as(ivy.email) })
    ).json()
    expect(handles(searched)).toEqual(["jay"])
    const miss = await (
      await app.request("/v1/people?query=nobody", { headers: as(ivy.email) })
    ).json()
    expect(miss.users).toEqual([])

    // Signed-in only — anonymous is refused.
    expect((await app.request("/v1/people")).status).toBe(401)
  })
})
