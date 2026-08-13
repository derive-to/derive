import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { as, bearer, dir, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

describe("workspace: name + members (Admin / Creator / Viewer)", () => {
  const admin: TestUser = { id: "u_ws_admin", email: "wsadmin@derive.test", name: "Ada" }
  const creator: TestUser = { id: "u_ws_creator", email: "wscreator@derive.test", name: "Cara" }
  const viewer: TestUser = { id: "u_ws_viewer", email: "wsviewer@derive.test", name: "Vic" }
  const { app } = makeAuthedApp("workspace", [admin, creator, viewer], "commenter")

  const ws = async (headers: Record<string, string>) =>
    (await app.request("/v1/workspace", { headers })).json()
  const patchWs = (headers: Record<string, string>, body: unknown) =>
    app.request("/v1/workspace", { ...jsonAs(headers, body), method: "PATCH" })
  const putMember = (headers: Record<string, string>, body: unknown) =>
    app.request("/v1/workspace/members", { ...jsonAs(headers, body), method: "PUT" })
  const patchMember = (headers: Record<string, string>, userId: string, body: unknown) =>
    app.request(`/v1/workspace/members/${userId}`, { ...jsonAs(headers, body), method: "PATCH" })

  it("defaults the name and makes the first user the Admin (owner)", async () => {
    // The first /v1/me claims ownership; the others provision as Viewers.
    const me = await (await app.request("/v1/me", { headers: as(admin.email) })).json()
    expect(me.user.role).toBe("owner")
    await app.request("/v1/me", { headers: as(creator.email) })
    await app.request("/v1/me", { headers: as(viewer.email) })
    const w = await ws(as(admin.email))
    expect(w.name).toBe("My Workspace")
    expect(w.role).toBe("owner")
    expect(w.members).toHaveLength(3)
  })

  it("an Admin renames the workspace; a Viewer cannot; the name shows in browse", async () => {
    const ok = await patchWs(as(admin.email), { name: "Acme HQ" })
    expect(ok.status).toBe(200)
    expect((await ok.json()).name).toBe("Acme HQ")
    expect((await ws(as(viewer.email))).name).toBe("Acme HQ")
    expect((await patchWs(as(viewer.email), { name: "Hijacked" })).status).toBe(403)
    const summary = await (await app.request("/v1/tags", { headers: as(admin.email) })).json()
    expect(summary.workspace).toBe("Acme HQ")
  })

  it("an Admin promotes a member to Creator (editor); a Viewer cannot add anyone", async () => {
    expect(
      (await putMember(as(admin.email), { email: creator.email, role: "editor" })).status,
    ).toBe(201)
    const me = await (await app.request("/v1/me", { headers: as(creator.email) })).json()
    expect(me.user.role).toBe("editor")
    expect((await putMember(as(viewer.email), { email: viewer.email, role: "owner" })).status).toBe(
      403,
    )
  })

  it("rejects an unknown email and an invalid role", async () => {
    expect(
      (await putMember(as(admin.email), { email: "ghost@derive.test", role: "editor" })).status,
    ).toBe(404)
    expect(
      (await putMember(as(admin.email), { email: creator.email, role: "wizard" })).status,
    ).toBe(400)
  })

  it("changes a member's role and removes a member", async () => {
    expect((await patchMember(as(admin.email), creator.id, { role: "owner" })).status).toBe(200)
    const del = await app.request(`/v1/workspace/members/${viewer.id}`, {
      method: "DELETE",
      headers: as(admin.email),
    })
    expect(del.status).toBe(204)
    const w = await ws(as(admin.email))
    expect(w.members.find((m: { user_id: string }) => m.user_id === viewer.id)).toBeUndefined()
  })

  it("won't strip or remove the last Admin", async () => {
    // creator is currently an Admin too; demote it so `admin` is the only one.
    expect((await patchMember(as(admin.email), creator.id, { role: "editor" })).status).toBe(200)
    expect((await patchMember(as(admin.email), admin.id, { role: "editor" })).status).toBe(409)
    const remove = await app.request(`/v1/workspace/members/${admin.id}`, {
      method: "DELETE",
      headers: as(admin.email),
    })
    expect(remove.status).toBe(409)
  })
})

describe("workspace: edge conditions", () => {
  const admin: TestUser = { id: "u_we_admin", email: "weadmin@derive.test", name: "Ed" }
  const other: TestUser = { id: "u_we_other", email: "weother@derive.test", name: "Otto" }
  const { app } = makeAuthedApp("ws-edge", [admin, other], "commenter")

  const putMember = (headers: Record<string, string>, body: unknown) =>
    app.request("/v1/workspace/members", { ...jsonAs(headers, body), method: "PUT" })
  const patchWs = (headers: Record<string, string>, body: unknown) =>
    app.request("/v1/workspace", { ...jsonAs(headers, body), method: "PATCH" })

  it("provisions the first user as Admin, then clamps long names and rejects blank ones", async () => {
    await app.request("/v1/me", { headers: as(admin.email) }) // first member → owner
    expect((await patchWs(as(admin.email), { name: "   " })).status).toBe(400)
    expect((await patchWs(as(admin.email), {})).status).toBe(400)
    const ok = await patchWs(as(admin.email), { name: "x".repeat(200) })
    expect(ok.status).toBe(200)
    expect((await ok.json()).name).toHaveLength(80)
  })

  it("rejects any role outside Admin / Creator / Viewer", async () => {
    for (const role of ["viewer", "admin", "boss", 3, null]) {
      expect((await putMember(as(admin.email), { email: other.email, role })).status).toBe(400)
    }
  })

  it("PUT is idempotent: re-adding a member re-roles them without duplicating", async () => {
    expect(
      (await putMember(as(admin.email), { email: other.email, role: "commenter" })).status,
    ).toBe(201)
    expect((await putMember(as(admin.email), { email: other.email, role: "editor" })).status).toBe(
      201,
    )
    const w = await (await app.request("/v1/workspace", { headers: as(admin.email) })).json()
    const rows = w.members.filter((m: { user_id: string }) => m.user_id === other.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe("editor")
  })

  it("the add/update (PUT) path also refuses to strip the last Admin", async () => {
    // admin is the sole owner — demoting itself via PUT must be blocked too.
    expect(
      (await putMember(as(admin.email), { email: admin.email, role: "commenter" })).status,
    ).toBe(409)
  })

  it("404s a PATCH on a non-member; a Creator can't manage", async () => {
    // `other` is a Creator (editor) — no manage rights.
    expect((await patchWs(as(other.email), { name: "Nope" })).status).toBe(403)
    expect((await putMember(as(other.email), { email: other.email, role: "owner" })).status).toBe(
      403,
    )
    const ghost = await app.request("/v1/workspace/members/u_ghost", {
      ...jsonAs(as(admin.email), { role: "editor" }),
      method: "PATCH",
    })
    expect(ghost.status).toBe(404)
  })

  it("allows self-demotion once a second Admin exists", async () => {
    expect((await putMember(as(admin.email), { email: other.email, role: "owner" })).status).toBe(
      201,
    )
    const demote = await app.request(`/v1/workspace/members/${admin.id}`, {
      ...jsonAs(as(admin.email), { role: "editor" }),
      method: "PATCH",
    })
    expect(demote.status).toBe(200)
    // having dropped Admin, the former Admin can no longer manage.
    expect((await patchWs(as(admin.email), { name: "X" })).status).toBe(403)
  })
})

describe("workspace: ownership handoff", () => {
  const admin: TestUser = {
    id: "u_handoff_admin",
    email: "handoff-admin@derive.test",
    name: "Admin",
  }
  const leaver: TestUser = {
    id: "u_handoff_leaver",
    email: "handoff-leaver@derive.test",
    name: "Leaver",
  }
  const { app, meta } = makeAuthedApp("ws-ownership-handoff", [admin, leaver], "editor")

  it("does not remove the sole owner of workspace resources", async () => {
    const published = await publishAs(
      app,
      "<h1>Private</h1>",
      { title: "Private", workspace_access: "none", link_role: "none", listed: "none" },
      as(leaver.email),
    )
    expect(published.status).toBe(201)
    const artifact = (await published.json()) as { short_id: string }
    const record = await meta.getByShortId(artifact.short_id)
    expect(record).not.toBeNull()

    const madeCollection = await app.request(
      "/v1/collections",
      jsonAs(as(leaver.email), { title: "Leaver's collection" }),
    )
    expect(madeCollection.status).toBe(201)
    const collection = (await madeCollection.json()) as { id: string }

    const blocked = await app.request(`/v1/workspace/members/${leaver.id}`, {
      method: "DELETE",
      headers: as(admin.email),
    })
    expect(blocked.status).toBe(409)
    expect((await blocked.json()).error).toMatch(/another owner.*1 artifact.*1 collection/i)
    expect(await meta.getMembership("default", leaver.id)).not.toBeNull()

    await meta.setArtifactMember({
      id: "am_handoff_admin",
      artifact_id: record?.id ?? "",
      user_id: admin.id,
      role: "owner",
    })
    await meta.setCollectionMember({
      id: "cm_handoff_admin",
      collection_id: collection.id,
      user_id: admin.id,
      role: "owner",
    })
    const removed = await app.request(`/v1/workspace/members/${leaver.id}`, {
      method: "DELETE",
      headers: as(admin.email),
    })
    expect(removed.status).toBe(204)
    expect(await meta.getMembership("default", leaver.id)).toBeNull()
  })
})

describe("workspace: anonymous lockout + token mode", () => {
  it("a no-token instance still does NOT trust anonymous callers (can't manage)", async () => {
    const noTokenApp = createApp({
      meta: new SqliteMetaStore(join(dir, "ws-open.db")),
      blobs: new FsBlobStore(join(dir, "blobs")),
      baseUrl: "http://derive.test",
    })
    // No open-mode owner elevation: an anonymous caller can't rename the workspace.
    const renamed = await noTokenApp.request("/v1/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Solo" }),
    })
    expect(renamed.status).toBe(403)
  })

  it("a static token acts as Admin", async () => {
    const admin: TestUser = { id: "u_tok_admin", email: "tokadmin@derive.test", name: "Toki" }
    const { app: tokApp } = makeAuthedApp("ws-token", [admin], "commenter")
    const r = await tokApp.request("/v1/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...bearer("tok") },
      body: JSON.stringify({ name: "Tokenspace" }),
    })
    expect(r.status).toBe(200)
    expect((await r.json()).name).toBe("Tokenspace")
  })
})

describe("multi-workspace: isolation, switch, create, provision", () => {
  const ada: TestUser = { id: "u_mw_ada", email: "mwada@derive.test", name: "Ada" }
  const bo: TestUser = { id: "u_mw_bo", email: "mwbo@derive.test", name: "Bo" }
  const { app } = makeAuthedApp("multiws", [ada, bo], "commenter", { isolated: true })

  // Pull the derive_ws cookie out of a Set-Cookie header to thread it on later calls.
  const wsCookie = (res: Response): string => {
    const m = (res.headers.get("set-cookie") ?? "").match(/derive_ws=([^;]+)/)
    return m ? `derive_ws=${m[1]}` : ""
  }
  const withCookie = (email: string, cookie: string) => ({ ...as(email), cookie })

  it("provisions a personal workspace for each new user on first load", async () => {
    const a = await (await app.request("/v1/workspaces", { headers: as(ada.email) })).json()
    expect(a.multi).toBe(true)
    expect(a.workspaces).toHaveLength(1)
    expect(a.workspaces[0].role).toBe("owner")
    // Flagged personal so clients render "Personal" instead of the plumbing name.
    expect(a.workspaces[0].personal).toBe(true)
    const b = await (await app.request("/v1/workspaces", { headers: as(bo.email) })).json()
    // Bo gets his OWN workspace, distinct from Ada's.
    expect(b.workspaces[0].id).not.toBe(a.workspaces[0].id)
  })

  it("isolates artifacts to the active workspace", async () => {
    expect((await publishAs(app, "<h1>ada</h1>", { title: "Ada doc" }, as(ada.email))).status).toBe(
      201,
    )
    const adaList = await (await app.request("/v1/artifacts", { headers: as(ada.email) })).json()
    expect(adaList.artifacts.map((x: { title: string }) => x.title)).toContain("Ada doc")
    const boList = await (await app.request("/v1/artifacts", { headers: as(bo.email) })).json()
    expect(boList.artifacts).toHaveLength(0)
  })

  it("creates a workspace, switches into it, and it starts empty", async () => {
    const create = await app.request("/v1/workspaces", jsonAs(as(ada.email), { name: "Acme" }))
    expect(create.status).toBe(201)
    const { id: acmeId, role } = await create.json()
    expect(role).toBe("owner")
    const cookie = wsCookie(create)
    expect(cookie).toContain(acmeId)
    // In Acme (via the cookie), Ada sees none of her personal-workspace artifacts.
    const inAcme = await (
      await app.request("/v1/artifacts", { headers: withCookie(ada.email, cookie) })
    ).json()
    expect(inAcme.artifacts).toHaveLength(0)
    const spaces = await (
      await app.request("/v1/workspaces", { headers: withCookie(ada.email, cookie) })
    ).json()
    expect(spaces.active).toBe(acmeId)
    expect(spaces.workspaces).toHaveLength(2)
    // A created (team) workspace is never flagged personal.
    const acme = spaces.workspaces.find((w: { id: string }) => w.id === acmeId)
    expect(acme?.personal).toBe(false)
  })

  it("switches back to a workspace you belong to; rejects one you don't", async () => {
    const a = await (await app.request("/v1/workspaces", { headers: as(ada.email) })).json()
    const personal = a.workspaces.find((w: { name: string }) => w.name !== "Acme")
    const sw = await app.request("/v1/workspace/switch", jsonAs(as(ada.email), { id: personal.id }))
    expect(sw.status).toBe(200)
    const back = await (
      await app.request("/v1/artifacts", { headers: withCookie(ada.email, wsCookie(sw)) })
    ).json()
    expect(back.artifacts.map((x: { title: string }) => x.title)).toContain("Ada doc")
    // Bo is not a member of Ada's personal workspace.
    expect(
      (await app.request("/v1/workspace/switch", jsonAs(as(bo.email), { id: personal.id }))).status,
    ).toBe(403)
  })
})

// (single-mode create/switch-disabled tests removed — multi-workspace is now the
// only mode; create + switch are always available, /me reports multi:true.)

describe("workspace: delete (guarded)", () => {
  const me: TestUser = { id: "u_wsdel", email: "wsdel@derive.test", name: "Del" }
  const { app } = makeAuthedApp("ws-del", [me], undefined, { isolated: true })
  const H = as(me.email)
  const del = (id: string) => app.request(`/v1/workspaces/${id}`, { method: "DELETE", headers: H })
  const create = async (name: string): Promise<{ id: string }> =>
    (await app.request("/v1/workspaces", jsonAs(H, { name }))).json()
  const listWs = async (): Promise<{ id: string }[]> =>
    (await (await app.request("/v1/workspaces", { headers: H })).json()).workspaces

  it("blocks your last workspace, non-owners, and non-empty; deletes an empty one", async () => {
    await app.request("/v1/me", { headers: H }) // provision the personal workspace (active)
    const mine = await listWs()
    const first = mine[0]
    if (!first) throw new Error("expected a personal workspace")
    const personal = first.id
    // can't delete your only workspace
    expect((await del(personal)).status).toBe(409)
    // not a member / unknown id → forbidden
    expect((await del("ws_not_mine")).status).toBe(403)
    // publish into the active (personal) workspace, then add a second so it isn't "last"
    expect((await publishAs(app, "<h1>x</h1>", {}, H)).status).toBe(201)
    const empty = await create("Empty One")
    // the personal workspace now has an artifact → must be emptied first
    expect((await del(personal)).status).toBe(409)
    // the empty second workspace deletes cleanly
    expect((await del(empty.id)).status).toBe(200)
    expect((await listWs()).some((w) => w.id === empty.id)).toBe(false)
  })
})
