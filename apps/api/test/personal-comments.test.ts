import { join } from "node:path"
import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"
import { sha256 } from "../src/lib/crypto"
import { as, bearer, dir, jsonAs, makeAuthedApp, publishAs, type TestUser } from "./helpers"

// Mode A — personal comments: a private channel scoped to a human owner and the
// agents that human has OAuth-authed. The store filters; these tests pin that the
// filter holds across every surface (another user, a workspace agent, an OAuth agent)
// and that a personal comment's existence never leaks (404, not 403, on by-id paths).

const A: TestUser = { id: "u_alice", email: "alice@x.test", name: "Alice" }
const B: TestUser = { id: "u_bob", email: "bob@x.test", name: "Bob" }

const { app } = makeAuthedApp("personal-comments", [A, B])

const list = async (sid: string, headers: Record<string, string>) =>
  (await (await app.request(`/v1/artifacts/${sid}/comments`, { headers })).json()).comments as {
    id: string
    thread_id: string
    visibility?: string
  }[]

const personalOf = async (sid: string) =>
  (await list(sid, as(A.email))).find((c) => c.visibility === "personal") as {
    id: string
    thread_id: string
  }

// Seed an OAuth access token granting `userId` a scope set, into the same sqlite file
// the app uses — what the browser-consent flow produces. The stored token is its
// sha256; the raw string is the bearer.
const seedGrant = (userId: string, raw: string, scopes = "openid dock:comment dock:read") => {
  const db = new Database(join(dir, "personal-comments.db"))
  db.exec(`
    CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE IF NOT EXISTS "oauthAccessToken" (token TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT, expiresAt TEXT);
  `)
  db.prepare(`INSERT OR IGNORE INTO "oauthClient"(clientId,name) VALUES('cli','Claude')`).run()
  db.prepare(
    `INSERT OR REPLACE INTO "oauthAccessToken"(token,clientId,userId,scopes,expiresAt) VALUES(?,?,?,?,?)`,
  ).run(
    sha256(raw),
    "cli",
    userId,
    JSON.stringify(scopes.split(/\s+/).filter(Boolean)),
    new Date(Date.now() + 3_600_000).toISOString(),
  )
  db.close()
}

describe("personal comments — visibility", () => {
  let sid: string

  it("creates a public and a personal comment as the owner", async () => {
    sid = (await (await publishAs(app, "<h1>doc</h1>", { title: "Doc" }, as(A.email))).json())
      .short_id
    const pub = await app.request(
      `/v1/artifacts/${sid}/comments`,
      jsonAs(as(A.email), { body_md: "public note" }),
    )
    expect((await pub.json()).visibility).toBe("public")

    const res = await app.request(
      `/v1/artifacts/${sid}/comments`,
      jsonAs(as(A.email), { body_md: "redo the chart", visibility: "personal" }),
    )
    expect(res.status).toBe(201)
    const cm = await res.json()
    expect(cm.visibility).toBe("personal")
    // owner_id is the privacy key — it must never reach the client.
    expect(cm).not.toHaveProperty("owner_id")
  })

  it("the owner sees their personal comment; another user sees only public", async () => {
    expect(await list(sid, as(A.email))).toHaveLength(2)
    const bob = await list(sid, as(B.email))
    expect(bob).toHaveLength(1)
    expect(bob.every((c) => c.visibility !== "personal")).toBe(true)
  })

  it("a non-owner cannot resolve / react / edit / delete a personal comment (404, not 403)", async () => {
    const { id } = await personalOf(sid)
    const ct = { ...as(B.email), "content-type": "application/json" }
    expect(
      (await app.request(`/v1/artifacts/${sid}/comments/${id}/resolve`, jsonAs(as(B.email), {})))
        .status,
    ).toBe(404)
    expect(
      (
        await app.request(
          `/v1/artifacts/${sid}/comments/${id}/react`,
          jsonAs(as(B.email), { emoji: "👍" }),
        )
      ).status,
    ).toBe(404)
    expect(
      (
        await app.request(`/v1/artifacts/${sid}/comments/${id}`, {
          method: "PATCH",
          headers: ct,
          body: JSON.stringify({ body_md: "hijack" }),
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await app.request(`/v1/artifacts/${sid}/comments/${id}`, {
          method: "DELETE",
          headers: as(B.email),
        })
      ).status,
    ).toBe(404)
    // The owner still controls it.
    expect(
      (await app.request(`/v1/artifacts/${sid}/comments/${id}/resolve`, jsonAs(as(A.email), {})))
        .status,
    ).toBe(200)
    await app.request(
      `/v1/artifacts/${sid}/comments/${id}/resolve`,
      jsonAs(as(A.email), { state: "open" }),
    )
  })

  it("a reply inherits its thread's personal visibility; a non-owner can't reply in", async () => {
    const { thread_id } = await personalOf(sid)
    expect(
      (
        await app.request(
          `/v1/artifacts/${sid}/comments`,
          jsonAs(as(B.email), { body_md: "sneaking in", thread_id }),
        )
      ).status,
    ).toBe(404)
    const r = await app.request(
      `/v1/artifacts/${sid}/comments`,
      jsonAs(as(A.email), { body_md: "and switch to $M", thread_id }),
    )
    expect(r.status).toBe(201)
    expect((await r.json()).visibility).toBe("personal")
    // Bob still sees only the one public thread.
    expect(await list(sid, as(B.email))).toHaveLength(1)
  })

  it("a registered workspace agent sees only public, and can't open a personal comment", async () => {
    const reg = await (
      await app.request("/v1/agents", jsonAs(as(A.email), { name: "WorkspaceBot" }))
    ).json()
    const agentList = await list(sid, bearer(reg.token))
    expect(agentList.every((c) => c.visibility !== "personal")).toBe(true)
    // No human behind a workspace agent → it can't own a personal channel.
    const create = await app.request(`/v1/artifacts/${sid}/comments`, {
      method: "POST",
      headers: { ...bearer(reg.token), "content-type": "application/json" },
      body: JSON.stringify({ body_md: "secret", visibility: "personal" }),
    })
    expect(create.status).toBe(400)
  })

  it("an OAuth agent sees its own user's personal comments, never another user's", async () => {
    seedGrant(A.id, "tok_alice_agent")
    seedGrant(B.id, "tok_bob_agent")
    // Alice's authed agent sees Alice's personal channel.
    expect(
      (await list(sid, bearer("tok_alice_agent"))).some((c) => c.visibility === "personal"),
    ).toBe(true)
    // Bob's authed agent sees only public — Alice's personal is invisible to it.
    expect(
      (await list(sid, bearer("tok_bob_agent"))).every((c) => c.visibility !== "personal"),
    ).toBe(true)
  })
})
