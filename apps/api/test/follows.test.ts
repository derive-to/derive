import { newId } from "@derive/core"
import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, type TestUser } from "./helpers"

// End-to-end: drive people follows + scope=following as a real session user.
const amy: TestUser = { id: "u-amy", email: "amy@x.com", name: "Amy", username: "amy" }
const bob: TestUser = { id: "u-bob", email: "bob@x.com", name: "Bob", username: "bob" }
const { app, meta } = makeAuthedApp("follows", [amy, bob])

const post = (headers: Record<string, string>, body: unknown) =>
  app.request("/v1/follows", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

// People-follow: bob follows Amy by handle, her hand-published (author_id) public work
// flows into his feed, and the profile reflects follower/following + followed_by_me.
describe("people follow", () => {
  // Publish an artifact authored by a Derive user (stamps author_id), via the store. `org`
  // defaults to amy's OWN workspace (not bob's active "default"), so the feed assertions
  // exercise the cross-workspace people-follow path — the real-world case.
  const publishByUser = async (
    title: string,
    userId: string,
    visibility: "public" | "private" = "public",
    org = "amy_ws",
  ): Promise<string> => {
    const a = await meta.createArtifact({
      id: newId("a"),
      short_id: newId("s"),
      org_id: org,
      slug: null,
      title,
      workspace_access: visibility === "public" ? "member" : "none",
      link_role: visibility === "public" ? "viewer" : "none",
      listed: visibility === "public" ? "public" : "none",
      kind: "file",
      spa: 0,
    })
    await meta.addVersion(a.id, {
      id: newId("v"),
      blob_key: `blob_${newId("b")}`,
      content_type: "text/markdown",
      size_bytes: 1,
      author: "Amy",
      author_id: userId,
      message: null,
    })
    return a.short_id
  }

  it("rejects self-follow (400) and an unknown handle (404)", async () => {
    expect((await post(as(amy.email), { kind: "user", target: "amy" })).status).toBe(400)
    expect((await post(as(amy.email), { kind: "user", target: "ghost" })).status).toBe(404)
  })

  it("follows a person; their public work flows into the feed across workspaces, private stays hidden", async () => {
    // Amy publishes in HER OWN workspace ("amy_ws") — NOT bob's active "default".
    const amyPublic = await publishByUser("Amy's plan", amy.id, "public")
    const amyPrivate = await publishByUser("Amy's secret", amy.id, "private")

    // bob follows amy (by username; stored as her id, globally).
    const r = await post(as(bob.email), { kind: "user", target: "Amy" })
    expect(r.status).toBe(201)
    expect((await r.json()).follow).toMatchObject({ kind: "user", target: amy.id, org_id: "*" })

    // Amy's PUBLIC work shows in bob's feed even though it lives in another workspace;
    // her private (link) work never leaks. (Bob's active workspace is "default".)
    const feed = await app.request("/v1/artifacts?scope=following&limit=100", {
      headers: as(bob.email),
    })
    const ids = (await feed.json()).artifacts.map((a: { short_id: string }) => a.short_id)
    expect(ids).toContain(amyPublic) // cross-workspace public work surfaces
    expect(ids).not.toContain(amyPrivate) // private work stays hidden

    // GET /v1/follows resolves the people-follow to a public handle; the internal user id
    // never reaches the client — `target` is REPLACED by the handle (matches the client's
    // by-username keying), so amy.id appears nowhere in the response.
    const bobFollows = await (await app.request("/v1/follows", { headers: as(bob.email) })).json()
    const userFollow = bobFollows.follows.find((f: { kind: string }) => f.kind === "user")
    expect(userFollow).toMatchObject({ kind: "user", target: "amy", handle: "amy", name: "Amy" })
    expect(JSON.stringify(bobFollows)).not.toContain(amy.id) // no raw user id on the wire

    // The profile reflects it: bob (the viewer) follows her. (No follower
    // counts — the follow graph isn't a browsable surface at launch.)
    const amyProfile = await (await app.request("/v1/users/amy", { headers: as(bob.email) })).json()
    expect(amyProfile.user.followed_by_me).toBe(true)

    // amy sees a "follow" notification from bob (by his handle).
    const notifs = await (await app.request("/v1/notifications", { headers: as(amy.email) })).json()
    expect(notifs.notifications[0]).toMatchObject({ kind: "follow", actor: "bob" })

    // Unfollow removes it (and the follower count drops back).
    const del = await app.request("/v1/follows", {
      method: "DELETE",
      headers: { "content-type": "application/json", ...as(bob.email) },
      body: JSON.stringify({ kind: "user", target: "amy" }),
    })
    expect(del.status).toBe(204)
    const after = await (await app.request("/v1/users/amy", { headers: as(bob.email) })).json()
    expect(after.user.followed_by_me).toBe(false)
  })
})
