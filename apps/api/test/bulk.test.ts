import { describe, expect, it } from "vitest"
import { as, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// The /v1/bulk/* routes behind the library multi-select bar. The point of these routes is
// that each artifact is authorized on its own — a selection legitimately mixes what you own
// with what you only read — so the tests that matter most are the MIXED ones: the batch
// applies to what the caller may touch and reports the rest as `skipped`, never failing the
// whole call or silently dropping the artifacts it couldn't act on.

const amy: TestUser = { id: "u_bulk_amy", email: "amy@bulk.test", name: "Amy", username: "amyb" }
const ben: TestUser = { id: "u_bulk_ben", email: "ben@bulk.test", name: "Ben", username: "benb" }

// amy owns the workspace (users[0]); ben is a plain editor seat. Team-draft artifacts
// (the default) are workspace-readable, so ben can read/edit them but not manage (delete).
const { app, meta } = makeAuthedApp("bulk", [amy, ben], "editor")

const publish = async (title: string): Promise<string> => {
  const res = await publishAs(app, `# ${title}`, { title }, as(amy.email))
  return (await res.json()).short_id
}

const bulk = (path: string, body: unknown, who: TestUser = amy) =>
  app.request(path, jsonAs(as(who.email), body))

describe("bulk tags", () => {
  it("ADDS to each artifact's set (never replaces) and skips nothing you own", async () => {
    const [a, b, c] = [await publish("tag-a"), await publish("tag-b"), await publish("tag-c")]
    // b already carries a tag — the bulk add must not wipe it.
    await app.request(`/v1/artifacts/${b}/tags`, {
      ...jsonAs(as(amy.email), { tags: ["keep"] }),
      method: "PUT",
    })

    const res = await bulk("/v1/bulk/tags", { shortIds: [a, b], add: ["q3"] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: 2, skipped: 0, failed: 0 })

    const idA = (await meta.getByShortId(a))?.id as string
    const idB = (await meta.getByShortId(b))?.id as string
    const idC = (await meta.getByShortId(c))?.id as string
    const tags = await meta.tagsForArtifacts([idA, idB, idC])
    expect(tags[idA]).toEqual(["q3"])
    expect(tags[idB]?.sort()).toEqual(["keep", "q3"]) // merged, not replaced
    expect(tags[idC] ?? []).toEqual([]) // untouched — never in the set
  })

  it("a short id that resolves to nothing is skipped, not a failure", async () => {
    const a = await publish("mixed-a")
    // An unknown id resolves to null → skipped; the real, owned artifact still gets tagged.
    // (The authz-refused skip path — a caller without standing — is covered by bulk delete.)
    const res = await bulk("/v1/bulk/tags", { shortIds: [a, "does_not_exist"], add: ["x"] })
    expect(await res.json()).toEqual({ ok: 1, skipped: 1, failed: 0 })
  })

  it("a no-op tag set is a clean 0/0/0, not an error", async () => {
    const a = await publish("noop")
    const res = await bulk("/v1/bulk/tags", { shortIds: [a], add: ["   "] })
    expect(await res.json()).toEqual({ ok: 0, skipped: 0, failed: 0 })
  })
})

describe("bulk favorite", () => {
  it("stars a set, then unstars it", async () => {
    const [a, b] = [await publish("fav-a"), await publish("fav-b")]

    const star = await bulk("/v1/bulk/favorite", { shortIds: [a, b], favorite: true })
    expect(await star.json()).toEqual({ ok: 2, skipped: 0, failed: 0 })
    const starred = await (
      await app.request("/v1/artifacts?favorite=true", { headers: as(amy.email) })
    ).json()
    expect(starred.artifacts.map((x: { short_id: string }) => x.short_id).sort()).toEqual(
      [a, b].sort(),
    )

    const unstar = await bulk("/v1/bulk/favorite", { shortIds: [a, b], favorite: false })
    expect(await unstar.json()).toEqual({ ok: 2, skipped: 0, failed: 0 })
    const after = await (
      await app.request("/v1/artifacts?favorite=true", { headers: as(amy.email) })
    ).json()
    expect(after.artifacts).toHaveLength(0)
  })
})

describe("bulk collections", () => {
  it("adds a set to a collection in one call", async () => {
    const [a, b, c] = [await publish("col-a"), await publish("col-b"), await publish("col-c")]
    const col = await (await bulk("/v1/collections", { title: "Q3" })).json()

    const res = await bulk("/v1/bulk/collections", {
      shortIds: [a, b],
      collectionIds: [col.id],
    })
    expect(await res.json()).toEqual({ ok: 2, skipped: 0, failed: 0 })

    const listed = await (
      await app.request(`/v1/artifacts?collection=${col.id}`, { headers: as(amy.email) })
    ).json()
    expect(listed.artifacts.map((x: { short_id: string }) => x.short_id).sort()).toEqual(
      [a, b].sort(),
    )
    // c was never in the selection.
    expect(listed.artifacts.map((x: { short_id: string }) => x.short_id)).not.toContain(c)
  })

  it("403s when the caller can manage none of the target collections", async () => {
    const a = await publish("col-orphan")
    const res = await bulk("/v1/bulk/collections", {
      shortIds: [a],
      collectionIds: ["col_does_not_exist"],
    })
    expect(res.status).toBe(403)
  })
})

describe("bulk delete", () => {
  it("deletes an owned set and leaves the unselected one", async () => {
    const [a, b, c] = [await publish("del-a"), await publish("del-b"), await publish("del-c")]
    const res = await bulk("/v1/bulk/delete", { shortIds: [a, b] })
    expect(await res.json()).toEqual({ ok: 2, skipped: 0, failed: 0 })
    expect(await meta.getByShortId(a)).toBeNull()
    expect(await meta.getByShortId(b)).toBeNull()
    expect(await meta.getByShortId(c)).not.toBeNull()
  })

  it("skips artifacts the caller doesn't own — an editor can't bulk-delete", async () => {
    const [a, b] = [await publish("guard-a"), await publish("guard-b")]
    // ben is an editor: he can read these team drafts but delete is owner-only (manage), so
    // both are skipped and neither is removed. The batch does not error.
    const res = await bulk("/v1/bulk/delete", { shortIds: [a, b] }, ben)
    expect(await res.json()).toEqual({ ok: 0, skipped: 2, failed: 0 })
    expect(await meta.getByShortId(a)).not.toBeNull()
    expect(await meta.getByShortId(b)).not.toBeNull()
  })
})

describe("bulk validation", () => {
  it("rejects an empty selection", async () => {
    const res = await bulk("/v1/bulk/delete", { shortIds: [] })
    expect(res.status).toBe(400)
  })
})
