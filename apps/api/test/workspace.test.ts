import { join } from "node:path"
import { SqliteMetaStore } from "@dock/db/sqlite"
import { FsBlobStore } from "@dock/storage/fs"
import { describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { as, bearer, dir, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

describe("workspace: name + members (Admin / Creator / Viewer)", () => {
  const admin: TestUser = { id: "u_ws_admin", email: "wsadmin@dock.test", name: "Ada" }
  const creator: TestUser = { id: "u_ws_creator", email: "wscreator@dock.test", name: "Cara" }
  const viewer: TestUser = { id: "u_ws_viewer", email: "wsviewer@dock.test", name: "Vic" }
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
      (await putMember(as(admin.email), { email: "ghost@dock.test", role: "editor" })).status,
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
  const admin: TestUser = { id: "u_we_admin", email: "weadmin@dock.test", name: "Ed" }
  const other: TestUser = { id: "u_we_other", email: "weother@dock.test", name: "Otto" }
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

describe("workspace: anonymous lockout + token mode", () => {
  it("a no-token instance still does NOT trust anonymous callers (can't manage)", async () => {
    const noTokenApp = createApp({
      meta: new SqliteMetaStore(join(dir, "ws-open.db")),
      blobs: new FsBlobStore(join(dir, "blobs")),
      baseUrl: "http://dock.test",
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
    const admin: TestUser = { id: "u_tok_admin", email: "tokadmin@dock.test", name: "Toki" }
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
  const ada: TestUser = { id: "u_mw_ada", email: "mwada@dock.test", name: "Ada" }
  const bo: TestUser = { id: "u_mw_bo", email: "mwbo@dock.test", name: "Bo" }
  const { app } = makeAuthedApp("multiws", [ada, bo], "commenter", { isolated: true })

  // Pull the dock_ws cookie out of a Set-Cookie header to thread it on later calls.
  const wsCookie = (res: Response): string => {
    const m = (res.headers.get("set-cookie") ?? "").match(/dock_ws=([^;]+)/)
    return m ? `dock_ws=${m[1]}` : ""
  }
  const withCookie = (email: string, cookie: string) => ({ ...as(email), cookie })

  it("provisions a personal workspace for each new user on first load", async () => {
    const a = await (await app.request("/v1/workspaces", { headers: as(ada.email) })).json()
    expect(a.multi).toBe(true)
    expect(a.workspaces).toHaveLength(1)
    expect(a.workspaces[0].role).toBe("owner")
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
  const me: TestUser = { id: "u_wsdel", email: "wsdel@dock.test", name: "Del" }
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
