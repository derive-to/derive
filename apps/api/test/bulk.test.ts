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
})

describe("bulk archive", () => {
  it("archives a set, leaves direct reads intact, and restores it", async () => {
    const [a, b, c] = [await publish("arc-a"), await publish("arc-b"), await publish("arc-c")]
    const archived = await bulk("/v1/bulk/archive", { shortIds: [a, b], archived: true }, ben)
    expect(await archived.json()).toEqual({ ok: 2, skipped: 0, failed: 0 })

    const normal = await (await app.request("/v1/artifacts", { headers: as(amy.email) })).json()
    expect(normal.artifacts.map((x: { short_id: string }) => x.short_id)).not.toContain(a)
    expect(normal.artifacts.map((x: { short_id: string }) => x.short_id)).toContain(c)
    expect((await app.request(`/v1/artifacts/${a}`, { headers: as(amy.email) })).status).toBe(200)

    const shelf = await (
      await app.request("/v1/artifacts?scope=archived", { headers: as(amy.email) })
    ).json()
    expect(shelf.artifacts.map((x: { short_id: string }) => x.short_id).sort()).toEqual(
      [a, b].sort(),
    )

    const restored = await bulk("/v1/bulk/archive", { shortIds: [a, b], archived: false }, ben)
    expect(await restored.json()).toEqual({ ok: 2, skipped: 0, failed: 0 })
    expect((await meta.getByShortId(a))?.archived_at).toBeNull()
    expect((await meta.getByShortId(b))?.archived_at).toBeNull()
  })

  it("does not turn a tombstone into an archive", async () => {
    const a = await publish("arc-removed")
    const record = await meta.getByShortId(a)
    if (!record) throw new Error("artifact missing")
    await meta.setArtifactRemoved(record.id, "2026-01-02T00:00:00.000Z")

    const one = await app.request(`/v1/artifacts/${a}/archive`, {
      method: "PUT",
      headers: as(amy.email),
    })
    expect(one.status).toBe(409)

    const many = await bulk("/v1/bulk/archive", { shortIds: [a], archived: true })
    expect(await many.json()).toEqual({ ok: 0, skipped: 1, failed: 0 })
    expect((await meta.getByShortId(a))?.archived_at).toBeNull()
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
