import { describe, expect, it } from "vitest"
import { app, as, makeAuthedApp, meta, postJson, publishAs, type TestUser, upload } from "./helpers"

describe("collections", () => {
  const put = (path: string) =>
    app.request(path, { method: "PUT", headers: { "content-type": "application/json" } })

  it("CRUD + items + ?collection filter + detail membership", async () => {
    const col = await (await postJson("/v1/collections", { title: "Launch" })).json()
    expect(col.title).toBe("Launch")
    const { short_id } = await (await upload("c1.md", "x", { title: "In collection" })).json()
    expect((await put(`/v1/collections/${col.id}/items/${short_id}`)).status).toBe(200)

    const list = await (await app.request("/v1/collections")).json()
    expect(list.collections.find((c: { id: string }) => c.id === col.id)?.count).toBe(1)

    const filtered = await (await app.request(`/v1/artifacts?collection=${col.id}`)).json()
    expect(filtered.artifacts.map((a: { short_id: string }) => a.short_id)).toEqual([short_id])

    const detail = await (await app.request(`/v1/artifacts/${short_id}`)).json()
    expect(detail.collections).toEqual([col.id])

    await app.request(`/v1/collections/${col.id}/items/${short_id}`, { method: "DELETE" })
    expect(
      (await (await app.request(`/v1/artifacts?collection=${col.id}`)).json()).artifacts,
    ).toHaveLength(0)
  })

  it("sharing a collection grants its role on every artifact in it", async () => {
    const col = await (await postJson("/v1/collections", { title: "Shared" })).json()
    const { short_id } = await (await upload("cs.md", "x", { title: "Shared art" })).json()
    await put(`/v1/collections/${col.id}/items/${short_id}`)
    const art = await meta.getByShortId(short_id)
    if (!art) throw new Error("missing artifact")
    // A stranger has no role over the artifact…
    expect(await meta.collectionRolesForArtifact(art.id, "stranger")).toEqual([])
    // …until the collection is shared with them — then it propagates to items.
    await meta.setCollectionMember({
      id: "cm_test",
      collection_id: col.id,
      user_id: "stranger",
      role: "editor",
    })
    expect(await meta.collectionRolesForArtifact(art.id, "stranger")).toEqual(["editor"])
    // Removing the item drops the propagation.
    await meta.removeCollectionItem(col.id, art.id)
    expect(await meta.collectionRolesForArtifact(art.id, "stranger")).toEqual([])
  })

  it("renames and deletes a collection (artifacts survive)", async () => {
    const col = await (await postJson("/v1/collections", { title: "Temp" })).json()
    const { short_id } = await (await upload("cd.md", "x", { title: "Survivor" })).json()
    await put(`/v1/collections/${col.id}/items/${short_id}`)
    await app.request(`/v1/collections/${col.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    })
    expect((await meta.getCollection(col.id))?.title).toBe("Renamed")
    expect((await app.request(`/v1/collections/${col.id}`, { method: "DELETE" })).status).toBe(204)
    expect(await meta.getCollection(col.id)).toBeNull()
    // the artifact itself is untouched
    expect(await meta.getByShortId(short_id)).not.toBeNull()
  })

  it("a workspace editor can add a teammate's workspace artifact to a teammate's collection; an outsider can't", async () => {
    // Collections are org-wide organizing tools: any workspace editor manages them at
    // their seat (not just the creator), and can fold in any workspace-accessible
    // artifact — not just ones they own. (Regression: collectionRole ignored workspace
    // membership, and the add-item guard required owning the artifact.)
    const ana: TestUser = { id: "u_col_ana", email: "ana@col.test", name: "Ana", username: "anac" }
    const ben: TestUser = { id: "u_col_ben", email: "ben@col.test", name: "Ben", username: "benc" }
    const { app: teamApp } = makeAuthedApp("col-member", [ana, ben], "editor")
    // Ana creates the collection AND owns the artifact (a default team-draft — the
    // workspace reaches it at each member's seat). Ben created neither.
    const col = await (
      await teamApp.request("/v1/collections", {
        method: "POST",
        headers: { "content-type": "application/json", ...as(ana.email) },
        body: JSON.stringify({ title: "Team" }),
      })
    ).json()
    const anas = await (await publishAs(teamApp, "<h1>a</h1>", {}, as(ana.email))).json()
    // Ben (workspace editor, owns neither) can still fold Ana's artifact into her
    // collection — his seat gives him share on it and manage on the collection.
    expect(
      (
        await teamApp.request(`/v1/collections/${col.id}/items/${anas.short_id}`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...as(ben.email) },
        })
      ).status,
    ).toBe(200)

    // An outsider (own workspace, no membership here) still can't manage the collection.
    const outsider: TestUser = {
      id: "u_col_out",
      email: "out@col.test",
      name: "Out",
      username: "outc",
    }
    const { app: outApp } = makeAuthedApp("col-outsider", [ana, outsider], undefined, {
      isolated: true,
    })
    const otherCol = await (
      await outApp.request("/v1/collections", {
        method: "POST",
        headers: { "content-type": "application/json", ...as(ana.email) },
        body: JSON.stringify({ title: "Private-ish" }),
      })
    ).json()
    const mine = await (await publishAs(outApp, "<h1>o</h1>", {}, as(outsider.email))).json()
    expect(
      (
        await outApp.request(`/v1/collections/${otherCol.id}/items/${mine.short_id}`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...as(outsider.email) },
        })
      ).status,
    ).toBe(403) // no seat in that workspace → no standing to manage the collection
  })

  it("tags repo / PR / manual collections so the client can nest PR previews", async () => {
    // Manual: no repo source backing it.
    const manual = await (await postJson("/v1/collections", { title: "Manual" })).json()

    // Repo mirror: a collection backed by a branch source (pr_number null).
    const repoCol = await meta.createCollection({
      id: "col_repo_nest",
      org_id: "default",
      title: "GitHub: acme/docs",
      created_by: "u",
    })
    await meta.createRepoSource({
      id: "rs_branch_nest",
      org_id: "default",
      collection_id: repoCol.id,
      repo: "acme/docs",
      ref: "HEAD",
      includes: "**/*.md",
      created_by: "u",
    })

    // PR preview: its own collection backed by a source with pr_number set.
    const prCol = await meta.createCollection({
      id: "col_pr_nest",
      org_id: "default",
      title: "PR #7: Add guide",
      created_by: "u",
    })
    await meta.createRepoSource({
      id: "rs_pr_nest",
      org_id: "default",
      collection_id: prCol.id,
      repo: "acme/docs",
      ref: "deadbeef",
      includes: "**/*.md",
      pr_number: 7,
      created_by: "u",
    })

    const list = await (await app.request("/v1/collections")).json()
    const byId = (id: string) =>
      list.collections.find((c: { id: string }) => c.id === id) as {
        kind: string
        repo?: string
        prNumber?: number
        parentId?: string
      }

    expect(byId(manual.id).kind).toBe("manual")
    expect(byId(repoCol.id).kind).toBe("repo")
    expect(byId(repoCol.id).repo).toBe("acme/docs")

    const pr = byId(prCol.id)
    expect(pr.kind).toBe("pr")
    expect(pr.prNumber).toBe(7)
    // Nests under its repo collection, not top-level.
    expect(pr.parentId).toBe(repoCol.id)
  })
})

describe("collections: starring", () => {
  const amy: TestUser = { id: "u_amy", email: "amy@derive.test", name: "Amy" }
  const bob: TestUser = { id: "u_bob", email: "bob@derive.test", name: "Bob" }
  const { app: authed } = makeAuthedApp("collection-stars", [amy, bob])

  const mk = async (title: string) => {
    const r = await authed.request("/v1/collections", {
      method: "POST",
      headers: { ...as(amy.email), "content-type": "application/json" },
      body: JSON.stringify({ title }),
    })
    return (await r.json()) as { id: string }
  }
  const rowFor = async (email: string, id: string) => {
    const j = await (await authed.request("/v1/collections", { headers: as(email) })).json()
    return j.collections.find((c: { id: string }) => c.id === id)
  }

  it("stars, reports it on the list, and unstars", async () => {
    const col = await mk("Q3 planning")
    // Unstarred is stated, not absent — the sidebar decides what to pin off this field.
    expect((await rowFor(amy.email, col.id)).starred).toBe(false)

    const on = await authed.request(`/v1/collections/${col.id}/favorite`, {
      method: "PUT",
      headers: as(amy.email),
    })
    expect(await on.json()).toEqual({ starred: true })
    expect((await rowFor(amy.email, col.id)).starred).toBe(true)

    // Twice stays true rather than erroring or double-inserting.
    await authed.request(`/v1/collections/${col.id}/favorite`, {
      method: "PUT",
      headers: as(amy.email),
    })
    expect((await rowFor(amy.email, col.id)).starred).toBe(true)

    const off = await authed.request(`/v1/collections/${col.id}/favorite`, {
      method: "DELETE",
      headers: as(amy.email),
    })
    expect(await off.json()).toEqual({ starred: false })
    expect((await rowFor(amy.email, col.id)).starred).toBe(false)
  })

  it("reports a collection as active once you comment in it, not merely by access", async () => {
    const col = await mk("Worked in")
    const up = await authed.request("/v1/artifacts", {
      method: "POST",
      headers: as(amy.email),
      body: (() => {
        const f = new FormData()
        f.set("file", new File(["# doc"], "d.md", { type: "text/markdown" }))
        f.set("title", "Doc")
        return f
      })(),
    })
    const { short_id } = (await up.json()) as { short_id: string }
    await authed.request(`/v1/collections/${col.id}/items/${short_id}`, {
      method: "PUT",
      headers: as(amy.email),
    })

    // A shelf amy merely CREATED is not active: creating auto-adds you as owner, and
    // counting that marked every collection you ever made as active.
    const bare = await mk("Made but untouched")
    expect((await rowFor(amy.email, bare.id)).active).toBe(false)

    // This one she published into, which is a real signal.
    expect((await rowFor(amy.email, col.id)).active).toBe(true)
    // bob can open it and has done nothing: access is not activity. This is the whole
    // distinction the grouping rests on.
    expect((await rowFor(bob.email, col.id)).active).toBe(false)

    await authed.request(`/v1/artifacts/${short_id}/comments`, {
      method: "POST",
      headers: { ...as(bob.email), "content-type": "application/json" },
      body: JSON.stringify({ body_md: "looks right" }),
    })
    // One deliberate act moves him.
    expect((await rowFor(bob.email, col.id)).active).toBe(true)
  })

  it("carries a preview strip so the Collections view can show what's inside", async () => {
    const col = await mk("Shelf with covers")
    const shortIds: string[] = []
    // One more than the strip holds, so both the cap and the "+N" the view derives from
    // count-minus-strip are exercised.
    for (let i = 0; i < 5; i++) {
      const up = await authed.request("/v1/artifacts", {
        method: "POST",
        headers: as(amy.email),
        body: (() => {
          const f = new FormData()
          f.set("file", new File([`# doc ${i}`], `d${i}.md`, { type: "text/markdown" }))
          f.set("title", `Doc ${i}`)
          return f
        })(),
      })
      const { short_id } = (await up.json()) as { short_id: string }
      shortIds.push(short_id)
      await authed.request(`/v1/collections/${col.id}/items/${short_id}`, {
        method: "PUT",
        headers: as(amy.email),
      })
    }

    const row = await rowFor(amy.email, col.id)
    expect(row.count).toBe(5)
    expect(row.preview).toHaveLength(4)
    // Newest first, and each entry carries what a cover needs: the ref, the version to
    // pin the render to, and whether a static PNG exists.
    expect(row.preview[0].short_id).toBe(shortIds[4])
    expect(row.preview[0].current_version).toBe(1)
    expect(typeof row.preview[0].has_preview).toBe("boolean")
    // Last activity is derived from the strip's head — a collection has no mtime of
    // its own, so this is the only honest answer to "when was this touched". The
    // timestamp itself stays server-side; only this one derived field goes on the wire.
    expect(typeof row.last_activity).toBe("string")
    expect(row.preview[0].updated_at).toBeUndefined()

    // An empty shelf reports an empty strip rather than omitting the field: the view
    // renders "Nothing filed here yet" off this, and undefined would read as loading.
    const bare = await mk("Empty shelf")
    expect((await rowFor(amy.email, bare.id)).preview).toEqual([])
    expect((await rowFor(amy.email, bare.id)).last_activity).toBeUndefined()
  })

  it("list rows carry their collection ids, from the batched read", async () => {
    // The library's grouped-by-collection view groups on this field, from the LIST
    // response — not the detail. It shipped broken once: the field was populated by
    // `listEnrichment` but the Postgres fast path (`listPage`) builds its decoration
    // inside one statement, and the arm was missing there — so every artifact grouped
    // as unfiled in production while every SQLite test passed. This test runs under
    // test:pg too, which is the whole point of it.
    const col = await mk("Filed")
    const up = await authed.request("/v1/artifacts", {
      method: "POST",
      headers: as(amy.email),
      body: (() => {
        const f = new FormData()
        f.set("file", new File(["# filed"], "filed.md", { type: "text/markdown" }))
        f.set("title", "Filed doc")
        return f
      })(),
    })
    const { short_id } = (await up.json()) as { short_id: string }
    await authed.request(`/v1/collections/${col.id}/items/${short_id}`, {
      method: "PUT",
      headers: as(amy.email),
    })

    // A second artifact, deliberately unfiled.
    const up2 = await authed.request("/v1/artifacts", {
      method: "POST",
      headers: as(amy.email),
      body: (() => {
        const f = new FormData()
        f.set("file", new File(["# loose"], "loose.md", { type: "text/markdown" }))
        f.set("title", "Unfiled doc")
        return f
      })(),
    })
    const { short_id: looseId } = (await up2.json()) as { short_id: string }

    const list = await (
      await authed.request("/v1/artifacts?limit=30", { headers: as(amy.email) })
    ).json()
    const byId = (id: string) => list.artifacts.find((a: { short_id: string }) => a.short_id === id)
    expect(byId(short_id), "the filed artifact is on the list").toBeTruthy()
    expect(byId(short_id).collections).toEqual([col.id])
    // An unfiled row says so with an empty array, not an absent field.
    expect(byId(looseId).collections).toEqual([])
  })

  it("is per person, and gated on read rather than share", async () => {
    // Starring is a note to yourself about where you work — it grants nothing — so any
    // member who can open the collection can star it, and it stays theirs alone.
    const col = await mk("Team shelf")
    const res = await authed.request(`/v1/collections/${col.id}/favorite`, {
      method: "PUT",
      headers: as(bob.email),
    })
    expect(res.status).toBe(200)
    expect((await rowFor(bob.email, col.id)).starred).toBe(true)
    expect((await rowFor(amy.email, col.id)).starred).toBe(false)
  })

  it("refuses an anonymous star", async () => {
    // 403, matching the artifact star (anonymous.test pins the same): the workspace
    // gate answers before the user guard does, and a caller with no session is not a
    // member. Either way nothing is written.
    const col = await mk("Anon check")
    const res = await authed.request(`/v1/collections/${col.id}/favorite`, { method: "PUT" })
    expect(res.status).toBe(403)
  })
})
