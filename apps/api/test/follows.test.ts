import { newId } from "@dock/core"
import { describe, expect, it } from "vitest"
import { as, makeAuthedApp, type TestUser } from "./helpers"

// End-to-end: drive the follows route + scope=following as a real session user (via
// the `x-test-user` fake-auth harness — see helpers.ts). Amy is the workspace owner so
// she can publish; she follows an author + a path and reads her activity feed back.
const amy: TestUser = { id: "u-amy", email: "amy@x.com", name: "Amy", username: "amy" }
const bob: TestUser = { id: "u-bob", email: "bob@x.com", name: "Bob", username: "bob" }
const { app, meta } = makeAuthedApp("follows", [amy, bob])

// Publish an artifact in the shared "default" workspace authored by `login`, optionally
// at a repo `sourcePath`, then return its short_id (the id the list JSON exposes). Goes
// through the store so we can stamp the author login + source path deterministically (the
// feed keys on those denormalized columns).
const publish = async (
  title: string,
  login: string,
  sourcePath: string | null,
): Promise<string> => {
  const a = await meta.createArtifact({
    id: newId("a"),
    short_id: newId("s"),
    org_id: "default",
    slug: null,
    title,
    visibility: "link",
    kind: "file",
    spa: 0,
  })
  await meta.addVersion(a.id, {
    id: newId("v"),
    blob_key: `blob_${newId("b")}`,
    content_type: "text/markdown",
    size_bytes: 1,
    author: login,
    author_login: login,
    author_avatar: null,
    author_gh_id: null,
    message: null,
  })
  if (sourcePath) await meta.setArtifactSourcePath(a.id, sourcePath)
  return a.short_id
}

const post = (headers: Record<string, string>, body: unknown) =>
  app.request("/v1/follows", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })

describe("follows route", () => {
  it("requires a signed-in user (GET 401; anonymous write blocked 403)", async () => {
    // GET is open to the route, which 401s a caller with no session.
    expect((await app.request("/v1/follows")).status).toBe(401)
    // A non-GET /v1/* by a non-principal is blocked by the global write gate (403)
    // before the route runs — anonymous can't write a follow.
    expect((await post({}, { kind: "author", target: "x" })).status).toBe(403)
  })

  it("validates kind + non-empty target", async () => {
    expect((await post(as(amy.email), { kind: "nope", target: "x" })).status).toBe(400)
    expect((await post(as(amy.email), { kind: "author", target: "" })).status).toBe(400)
    expect((await post(as(amy.email), { kind: "author" })).status).toBe(400)
  })

  it("adds (idempotent), lists, and removes follows; author target is lowercased", async () => {
    // Author target is stored lowercased to match the author_login comparison.
    const r1 = await post(as(amy.email), { kind: "author", target: "Ada" })
    expect(r1.status).toBe(201)
    const f1 = (await r1.json()).follow
    expect(f1).toMatchObject({ kind: "author", target: "ada", user_id: amy.id, org_id: "default" })
    // Re-adding the same follow is idempotent — same row id, still 201.
    const r2 = await post(as(amy.email), { kind: "author", target: "ada" })
    expect((await r2.json()).follow.id).toBe(f1.id)

    // A path follow is stored verbatim.
    await post(as(amy.email), { kind: "path", target: "docs/plans" })
    const list = await (await app.request("/v1/follows", { headers: as(amy.email) })).json()
    expect(
      list.follows.map((f: { kind: string; target: string }) => `${f.kind}:${f.target}`).sort(),
    ).toEqual(["author:ada", "path:docs/plans"])

    // Follows are per-user: bob sees none of amy's.
    const bobList = await (await app.request("/v1/follows", { headers: as(bob.email) })).json()
    expect(bobList.follows).toEqual([])

    // DELETE removes a single follow (204).
    const del = await app.request("/v1/follows", {
      method: "DELETE",
      headers: { "content-type": "application/json", ...as(amy.email) },
      body: JSON.stringify({ kind: "author", target: "ada" }),
    })
    expect(del.status).toBe(204)
    const after = await (await app.request("/v1/follows", { headers: as(amy.email) })).json()
    expect(after.follows.map((f: { target: string }) => f.target)).toEqual(["docs/plans"])
  })

  it("scope=following returns artifacts matching the user's follows (author + path), per-user", async () => {
    const byAda = await publish("By Ada", "ada", null)
    const inPlans = await publish("In Plans", "bob", "docs/plans/q3.md")
    const neither = await publish("Neither", "carol", "src/x.ts")

    // Carol-follower amy already has a "docs/plans" follow from the prior test; add the
    // author follow back. (Tests share the workspace; we assert via inclusion.)
    await post(as(amy.email), { kind: "author", target: "ada" })

    const res = await app.request("/v1/artifacts?scope=following&limit=100", {
      headers: as(amy.email),
    })
    expect(res.status).toBe(200)
    const ids = (await res.json()).artifacts.map((a: { short_id: string }) => a.short_id)
    expect(ids).toContain(byAda) // followed author (case-insensitive)
    expect(ids).toContain(inPlans) // followed path prefix
    expect(ids).not.toContain(neither) // neither matches

    // bob follows nothing → empty feed (not "everyone's").
    const bobFeed = await app.request("/v1/artifacts?scope=following&limit=100", {
      headers: as(bob.email),
    })
    expect((await bobFeed.json()).artifacts).toEqual([])
  })
})
