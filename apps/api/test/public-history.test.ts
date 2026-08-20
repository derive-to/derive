import { describe, expect, it } from "vitest"
import {
  anonApp,
  app,
  as,
  bearer,
  makeAuthedApp,
  meta,
  publishAs,
  TEST_TOKEN,
  type TestUser,
  upload,
} from "./helpers"

const idOf = async (res: Response): Promise<string> => (await res.json()).short_id

const patchAccess = async (short: string, body: unknown) => {
  const res = await app.request(`/v1/artifacts/${short}/access`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...bearer(TEST_TOKEN) },
    body: JSON.stringify(body),
  })
  if (res.status !== 200) throw new Error(`access patch failed: ${res.status}`)
  return res.json()
}

/** Publish v2 so the artifact has real history to show or hide. */
const addVersion = async (short: string) => {
  const res = await upload("v2.md", "# Second", {}, short)
  if (res.status !== 201 && res.status !== 200) throw new Error(`version failed: ${res.status}`)
}

// Private history is visible to members and collaborators, not world-link holders.
// public_history opts those link readers in, whether or not they are signed in.
describe("public history", () => {
  it("defaults off: anon detail carries only the current version and public_history false", async () => {
    const short = await idOf(await upload("ph.md", "# One", { visibility: "public", title: "PH" }))
    await addVersion(short)

    const detail = await (await anonApp.request(`/v1/artifacts/${short}`)).json()
    expect(detail.public_history).toBe(false)
    expect(detail.current_version).toBe(2)
    expect(detail.versions.map((v: { n: number }) => v.n)).toEqual([2])
    expect(detail.sessions.length).toBe(1)
  })

  it("the authenticated owner keeps full history regardless of the flag", async () => {
    const short = await idOf(await upload("pha.md", "# One", { visibility: "public", title: "A" }))
    await addVersion(short)

    const detail = await (
      await app.request(`/v1/artifacts/${short}`, { headers: bearer(TEST_TOKEN) })
    ).json()
    expect(detail.versions.length).toBe(2)
  })

  it("the owner flips it over PATCH /access; anon then sees the full history", async () => {
    const short = await idOf(await upload("phb.md", "# One", { visibility: "public", title: "B" }))
    await addVersion(short)

    const flipped = await patchAccess(short, { publicHistory: true })
    expect(flipped.public_history).toBe(true)

    const detail = await (await anonApp.request(`/v1/artifacts/${short}`)).json()
    expect(detail.public_history).toBe(true)
    expect(detail.versions.map((v: { n: number }) => v.n)).toEqual([1, 2])

    // Access-triple changes that omit the flag leave it alone.
    await patchAccess(short, { listed: "public" })
    const after = await (await anonApp.request(`/v1/artifacts/${short}`)).json()
    expect(after.public_history).toBe(true)
  })

  it("anon old-version raw: 404 while off, served once on; the current version always serves", async () => {
    const short = await idOf(await upload("phc.md", "# One", { visibility: "public", title: "C" }))
    await addVersion(short)
    const art = await meta.getByShortId(short)
    if (!art) throw new Error("artifact missing")

    const current = await anonApp.request(`/raw/${short}/v/2/index.md`)
    expect(current.status).toBe(200)
    const old = await anonApp.request(`/raw/${short}/v/1/index.md`)
    expect(old.status).toBe(404)

    await meta.setPublicHistory(art.id, 1)
    const oldOn = await anonApp.request(`/raw/${short}/v/1/index.md`)
    expect(oldOn.status).toBe(200)
  })
})

describe("private history standing", () => {
  const owner: TestUser = { id: "u_ph_owner", email: "owner@ph.test", name: "Owner" }
  const stranger: TestUser = {
    id: "u_ph_stranger",
    email: "stranger@ph.test",
    name: "Stranger",
  }
  const { app } = makeAuthedApp("private-history-standing", [owner, stranger], undefined, {
    isolated: true,
  })

  it("a signed-in world-link holder gets only current history and a current-only raw token", async () => {
    await app.request("/v1/me", { headers: as(owner.email) })
    await app.request("/v1/me", { headers: as(stranger.email) })
    const first = await (await publishAs(app, "<h1>One</h1>", {}, as(owner.email))).json()
    const short = first.short_id as string
    const access = await app.request(`/v1/artifacts/${short}/access`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(owner.email) },
      body: JSON.stringify({ linkRole: "viewer" }),
    })
    expect(access.status).toBe(200)
    expect((await publishAs(app, "<h1>Two</h1>", {}, as(owner.email), short)).status).toBe(201)

    const outside = await (
      await app.request(`/v1/artifacts/${short}`, { headers: as(stranger.email) })
    ).json()
    expect(outside.is_workspace_member).toBe(false)
    expect(outside.versions.map((v: { n: number }) => v.n)).toEqual([2])
    expect(
      (
        await app.request(`/raw/${short}/v/1/t/${outside.raw_token}/index.html`, {
          headers: as(stranger.email),
        })
      ).status,
    ).toBe(404)

    const inside = await (
      await app.request(`/v1/artifacts/${short}`, { headers: as(owner.email) })
    ).json()
    expect(inside.is_workspace_member).toBe(true)
    expect(inside.versions.map((v: { n: number }) => v.n)).toEqual([1, 2])
    expect(
      (
        await app.request(`/raw/${short}/v/1/t/${inside.raw_token}/index.html`, {
          headers: as(owner.email),
        })
      ).status,
    ).toBe(200)
  })
})
