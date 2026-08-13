import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteMetaStore } from "@derive/db/sqlite"
import { FsBlobStore } from "@derive/storage/fs"
import Database from "better-sqlite3"
import { afterAll, describe, expect, it } from "vitest"
import { createApp } from "../src/app"
import { sha256 } from "../src/lib/crypto"

const dir = mkdtempSync(join(tmpdir(), "derive-orgdel-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** An app plus an OAuth bearer at the given scopes — the same seeding the consent dance
 *  produces. `derive:manage` maps to owner grade (capped by the human's real membership),
 *  which is what separates the delete cases below from the publish-grade ones. */
function appWithGrant(name: string, scopes: string) {
  const path = join(dir, `${name}.db`)
  const meta = new SqliteMetaStore(path)
  const db = new Database(path)
  db.exec(`
    CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, name TEXT, image TEXT, username TEXT, discoverable INTEGER, profession TEXT, about TEXT, brandprint TEXT);
    CREATE TABLE IF NOT EXISTS "oauthClient" (clientId TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE IF NOT EXISTS "oauthAccessToken" (token TEXT PRIMARY KEY, clientId TEXT, userId TEXT, scopes TEXT, expiresAt TEXT);
  `)
  db.prepare(
    `INSERT OR IGNORE INTO "user"(id,email,name) VALUES('u_o','owner@x.test','Owner')`,
  ).run()
  db.prepare(`INSERT OR IGNORE INTO "oauthClient"(clientId,name) VALUES('cli','Claude')`).run()
  db.prepare(
    `INSERT INTO "oauthAccessToken"(token,clientId,userId,scopes,expiresAt) VALUES(?,?,?,?,?)`,
  ).run(
    sha256(`tok_${name}`),
    "cli",
    "u_o",
    JSON.stringify(scopes.split(/\s+/).filter(Boolean)),
    new Date(Date.now() + 3_600_000).toISOString(),
  )
  db.close()
  const blobs = new FsBlobStore(join(dir, `${name}-blobs`))
  const app = createApp({ meta, blobs, baseUrl: "http://derive.test", token: "tok" })
  return { app, token: `tok_${name}`, meta, blobs }
}

// PERMANENT DELETE on `organize` (state:'deleted'). The capability already existed at
// REST (DELETE /v1/artifacts/:id, same manage gate) and was simply unreachable from the
// tool an agent tidies its library with — so finishing a cleanup meant minting a second
// credential. This is parity, not new power, which is exactly why the gate must MATCH
// the REST one rather than being relaxed to fit the caller.
const call = (
  app: ReturnType<typeof appWithGrant>["app"],
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) =>
  app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  })

const toolJson = async (res: Response) => {
  const ct = res.headers.get("content-type") ?? ""
  const txt = await res.text()
  const out = ct.includes("application/json")
    ? JSON.parse(txt)
    : JSON.parse(
        (txt.split("\n").find((l) => l.startsWith("data:")) ?? "data:null").slice(5).trim(),
      )
  const t = (out?.result as { content?: { text: string }[] })?.content?.[0]?.text
  if (t == null) throw new Error(`no tool text: ${JSON.stringify(out)}`)
  return JSON.parse(t)
}

const publish = async (
  app: ReturnType<typeof appWithGrant>["app"],
  token: string,
  title: string,
) => {
  const form = new FormData()
  form.append("file", new Blob([new TextEncoder().encode(`<h1>${title}</h1>`)]), "index.html")
  form.append("title", title)
  return (
    await app.request("/v1/artifacts", {
      method: "POST",
      body: form,
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()
}

describe("organize state:'deleted' — the permanent one", () => {
  it("deletes for real, and says there is no undo", async () => {
    const { app, token, meta } = appWithGrant(
      "orgdel",
      "openid derive:read derive:publish derive:manage",
    )
    const a = await publish(app, token, "Throwaway")
    expect(await meta.getByShortId(a.short_id)).toBeTruthy()

    const out = await toolJson(
      await call(app, token, "shelve", { short_ids: [a.short_id], state: "deleted" }),
    )
    expect(out.state.deleted).toBe(1)
    // Gone from the store, not merely tombstoned.
    expect(await meta.getByShortId(a.short_id)).toBeNull()
    // Every other state change hands back its reversal. This one must NOT pretend to.
    expect(out.state.undo).toBeUndefined()
    expect(out.state.note).toContain("cannot be undone")
    // And it points at the reversible option, since that is usually what was meant.
    expect(out.state.note).toContain("removed")
  })

  it("deletes an artifact that has logged views (the raw-DDL view table's FK)", async () => {
    // Regression: the view ledger is raw DDL with a NOT NULL FK to artifact(id) and no
    // drizzle model, so it was invisible to check-delete-cascade and missing from every
    // delete path. Postgres enforces the FK, so deleting any once-viewed artifact 500d
    // in production while this suite stayed green (better-sqlite3 runs with FK
    // enforcement off) — run under pnpm test:pg, this case is the one that catches it.
    const { app, token, meta } = appWithGrant(
      "orgdelviews",
      "openid derive:read derive:publish derive:manage",
    )
    const a = await publish(app, token, "Viewed then deleted")
    const rec = await meta.getByShortId(a.short_id)
    if (!rec) throw new Error("publish did not land")
    await meta.recordView({
      id: "vw_orgdelviews_1",
      artifact_id: rec.id,
      version: 1,
      viewer: "anon-fingerprint",
      viewer_kind: "anon",
    })
    const out = await toolJson(
      await call(app, token, "shelve", { short_ids: [a.short_id], state: "deleted" }),
    )
    expect(out.state.deleted).toBe(1)
    expect(await meta.getByShortId(a.short_id)).toBeNull()
  })

  it("refuses below manage and names the reversible alternative", async () => {
    // publish-grade only: enough to create the artifact, deliberately not enough to
    // destroy it. The REST route draws the line in the same place.
    const { app, token, meta } = appWithGrant("orgdellow", "openid derive:read derive:publish")
    const a = await publish(app, token, "Keeper")

    const out = await toolJson(
      await call(app, token, "shelve", { short_ids: [a.short_id], state: "deleted" }),
    )
    expect(out.state.deleted).toBe(0)
    expect(out.state.needs_manage).toEqual([a.short_id])
    expect(out.state.needs_manage_note).toContain("removed")
    // Still there, which is the whole point.
    expect(await meta.getByShortId(a.short_id)).toBeTruthy()
  })

  it("still offers the reversible shelving path at publish grade", async () => {
    // The refusal above must not read as "you cannot clean up" — retiring still works.
    const { app, token, meta } = appWithGrant("orgdelshelf", "openid derive:read derive:publish")
    const a = await publish(app, token, "Shelvable")
    const out = await toolJson(
      await call(app, token, "shelve", { short_ids: [a.short_id], state: "removed" }),
    )
    expect(out.state.changed).toBe(1)
    expect(out.state.undo).toMatchObject({ arguments: { state: "live" } })
    expect((await meta.getByShortId(a.short_id))?.removed_at).toBeTruthy()
  })

  it("deletes a batch, skipping what it cannot reach, without failing the call", async () => {
    const { app, token, meta } = appWithGrant(
      "orgdelbatch",
      "openid derive:read derive:publish derive:manage",
    )
    const a = await publish(app, token, "One")
    const b = await publish(app, token, "Two")
    const out = await toolJson(
      await call(app, token, "shelve", {
        short_ids: [a.short_id, b.short_id, "nosuchid"],
        state: "deleted",
      }),
    )
    expect(out.state.deleted).toBe(2)
    expect(out.state.skipped).toBe(1)
    expect(await meta.getByShortId(a.short_id)).toBeNull()
    expect(await meta.getByShortId(b.short_id)).toBeNull()
  })

  it("rejects an unknown state value by name, listing the real ones", async () => {
    const { app, token } = appWithGrant("orgdelbad", "openid derive:read derive:publish")
    const res = await call(app, token, "shelve", { short_ids: ["x"], state: "destroyed" })
    const txt = await res.text()
    expect(txt).toContain("deleted")
  })
})
